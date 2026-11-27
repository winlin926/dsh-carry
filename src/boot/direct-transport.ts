import { remoteDirect } from '../boot-direct.js'
import { PREVIEW_WORKER_PATH } from '../preview-worker.js'
import type { createRemoteRuntime } from '../remote-runtime.js'
import type { BootContext } from './types.js'

export function createDirectControl(options: {
  globals: Record<string, any>
  context: BootContext | null
  originalFetch: typeof fetch
  runtime: ReturnType<typeof createRemoteRuntime>
  onMuxLost: () => void
}): {
  link: ReturnType<typeof remoteDirect> | undefined
  routedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
} {
  const { globals, context, originalFetch, runtime, onMuxLost } = options
  const direct = context?.direct
  let currentRoute: 'direct' | 'upstream' = 'upstream'
  const upstream = new Set<WebSocket>()
  let hadMux = false

  const directOverride = globals.__DSH_TEST_DIRECT__ as ReturnType<typeof remoteDirect> | undefined
  const link = direct
    ? (directOverride ??
      remoteDirect({
        signalPath: direct.signal,
        fetch: (url: RequestInfo | URL, init?: RequestInit) => originalFetch(url, init),
        // Bound: the browser's timer functions throw "Illegal invocation" when called off the window.
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: number) => clearTimeout(handle),
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: (handle: number) => clearInterval(handle),
        baseUrl: () => location.href,
        visible: () => !document.hidden,
        preference: () => direct.preference,
        onState: (state) => {
          if (state.line === currentRoute) return
          currentRoute = state.line
          setTimeout(moveSockets, 0)
        },
        log: (line: string) => {
          try {
            console.debug('[rc-direct] ' + line)
          } catch {
            /* a missing console is not a failure */
          }
        },
      }))
    : undefined

  // Sockets that opened before the direct line was usable: when it becomes usable they are closed
  // so the app's own reconnect logic opens them again on the direct channel. Without this the
  // stream carrier stays on the entry the page arrived through, and dies with it.
  const moveSockets = (): void => {
    if (link?.line !== 'direct') {
      link?.reconnectSockets()
      return
    }
    for (const socket of upstream) socket.close()
    upstream.clear()
  }

  /** Every same-origin call the app makes: uploads, streaming and previews take the live line. */
  const routedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    let sameOrigin = false
    try {
      sameOrigin = new URL(url, location.href).origin === location.origin
    } catch {
      return originalFetch(input, init)
    }
    if (!sameOrigin || !link) return originalFetch(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const safeRead = method === 'GET' || method === 'HEAD'
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const useDirect = link.ready && (link.line === 'direct' || (!safeRead && (await link.preferDirectForWrite())))
    if (useDirect) {
      try {
        return await link.fetch(input, init)
      } catch (error) {
        if (!safeRead || signal?.aborted) throw error
      }
    }
    // Only a read can try the other line after an ambiguous failure. A write may already have reached the Host.
    let response: Response
    try {
      response = await originalFetch(input, init)
    } catch (error) {
      if (signal?.aborted) throw error
      link.invalidateUpstream()
      if (safeRead && !useDirect && link.ready) return link.fetch(input, init)
      throw error
    }
    if ([502, 503, 504].includes(response.status)) {
      link.invalidateUpstream()
      if (safeRead && !useDirect && link.ready && !signal?.aborted) {
        void response.body?.cancel().catch(() => {})
        return link.fetch(input, init)
      }
    }
    return response
  }

  globals.__DSH_FILE_UPLOAD__ = { fetch: routedFetch }
  // Read-only diagnostics: a phone that cannot reach its own line is otherwise undebuggable.
  if (link) {
    globals.__DSH_DIRECT__ = { state: () => link.state(), ready: () => link.ready }
    setTimeout(() => {
      void link.start()
    }, 0)
    const checkNetwork = () => {
      link.invalidateUpstream()
      if (!document.hidden) link.checkLines()
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkNetwork()
    })
    window.addEventListener('offline', link.invalidateUpstream)
    window.addEventListener('online', checkNetwork)
    const network = (navigator as Navigator & { connection?: EventTarget }).connection
    network?.addEventListener('change', checkNetwork)
    if (window.isSecureContext && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const port = event.ports[0]
        const source = event.source as ServiceWorker | null
        if (
          !port ||
          source?.scriptURL !== new URL(PREVIEW_WORKER_PATH, location.href).href ||
          event.data?.type !== 'dsh-preview'
        )
          return
        if (link.line !== 'direct') {
          port.postMessage(null)
          return
        }
        void (async () => {
          const target = new URL(String(event.data.url), location.href)
          if (
            target.origin !== location.origin ||
            !/^\/rc\/workspace-preview\/[A-Za-z0-9_-]{43}\//.test(target.pathname)
          )
            return null
          const response = await link.fetch(target)
          return { status: response.status, headers: [...response.headers], body: response.body }
        })().then(
          (result) => {
            try {
              port.postMessage(result, result?.body ? [result.body] : [])
            } catch {
              port.postMessage(null)
            }
          },
          () => port.postMessage(null),
        )
      })
      void navigator.serviceWorker.register(PREVIEW_WORKER_PATH, { scope: '/' }).catch(() => {})
    }
  }

  const watchMux = (socket: Pick<WebSocket, 'addEventListener'>, route: 'lan' | 'public' | 'direct' | undefined) => {
    runtime.observeMux(socket, route)
    socket.addEventListener('open', () => {
      hadMux = true
    })
    socket.addEventListener('close', () => {
      if (hadMux) onMuxLost()
    })
  }

  const OriginalSocket = window.WebSocket
  globals.WebSocket = new Proxy(OriginalSocket, {
    construct(Target, args: [string | URL, (string | string[])?]) {
      const [url, protocols] = args
      // A same-origin socket rides the direct line while it is up; anything else is a plain socket.
      const target = new URL(String(url), location.href)
      const localSocket =
        target.host === location.host &&
        (target.protocol === 'wss:'
          ? location.protocol === 'https:'
          : target.protocol === 'ws:'
            ? location.protocol === 'http:'
            : target.origin === location.origin)
      const mux = localSocket && target.pathname === '/api/remote.mux'
      if (link?.line === 'direct' && localSocket) {
        const socket = link.socket(String(url), protocols)
        if (mux) watchMux(socket, 'direct')
        return socket as unknown as WebSocket
      }
      const socket = new Target(url, protocols)
      if (localSocket) upstream.add(socket)
      socket.addEventListener('close', () => {
        upstream.delete(socket)
      })
      if (mux) watchMux(socket, context?.entry)
      return socket
    },
  })

  // EventSource uses one authenticated WS carrier for both LAN and fixed-domain connections.
  const NativeSocket = window.WebSocket
  const NativeEventSource = globals.EventSource
  class RemoteEventSource extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 2
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSED = 2
    readyState = 0
    url: string
    withCredentials: boolean
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    private socket?: WebSocket
    private timer?: ReturnType<typeof setTimeout>
    private buffer = ''
    private lastId = ''
    private retry = 3000
    private backoff = 0
    constructor(url: string | URL, init?: EventSourceInit) {
      super()
      this.url = new URL(String(url), location.href).href
      this.withCredentials = init?.withCredentials ?? false
      this.connect()
    }
    private emit(type: string, event: Event): void {
      this.dispatchEvent(event)
      const callback =
        type === 'open'
          ? this.onopen
          : type === 'error'
            ? this.onerror
            : type === 'message'
              ? this.onmessage
              : undefined
      callback?.call(this, event as MessageEvent)
    }
    private connect(): void {
      if (this.readyState === 2) return
      const url = new URL('/rc/sse', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const source = new URL(this.url)
      url.searchParams.set('path', source.pathname + source.search)
      if (this.lastId) url.searchParams.set('lastEventId', this.lastId)
      const socket = new NativeSocket(url)
      this.socket = socket
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data)
        if (frame.type === 'ready') {
          this.readyState = 1
          this.backoff = 0
          this.emit('open', new Event('open'))
          return
        }
        if (frame.type === 'error') {
          this.close()
          this.emit('error', new Event('error'))
          return
        }
        if (frame.type !== 'chunk') return
        this.buffer += frame.data
        for (;;) {
          const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer)
          if (!match) break
          const text = this.buffer.slice(0, match.index)
          this.buffer = this.buffer.slice(match.index + match[0].length)
          let type = 'message'
          const data: string[] = []
          for (const line of text.split(/\r\n|\r|\n/)) {
            const colon = line.indexOf(':')
            const field = colon < 0 ? line : line.slice(0, colon)
            const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
            if (field === 'data') data.push(value)
            else if (field === 'event') type = value || 'message'
            else if (field === 'id' && !value.includes('\0')) this.lastId = value
            else if (field === 'retry' && /^\d+$/.test(value))
              this.retry = Math.min(30000, Math.max(500, Number(value)))
          }
          if (data.length)
            this.emit(
              type,
              new MessageEvent(type, { data: data.join('\n'), lastEventId: this.lastId, origin: location.origin }),
            )
        }
      }
      socket.onerror = () => this.emit('error', new Event('error'))
      // A sleeping computer or a restarting Host comes back in minutes, not in one fixed interval:
      // every failed attempt waits twice as long as the one before, up to 30s, and a live
      // connection resets the wait.
      socket.onclose = () => {
        if (this.readyState !== 2) {
          this.readyState = 0
          this.buffer = ''
          this.backoff = Math.min(30000, this.backoff ? this.backoff * 2 : this.retry)
          if (link) void link.probe()
          this.timer = setTimeout(() => this.connect(), this.backoff)
        }
      }
    }
    close(): void {
      this.readyState = 2
      clearTimeout(this.timer)
      this.socket?.close()
    }
  }
  globals.EventSource = new Proxy(RemoteEventSource, {
    construct(_Target, args: [string | URL, EventSourceInit?]) {
      const [url, init] = args
      const resolved = new URL(String(url), location.href).href
      // The carrier only carries this origin. Anywhere else the browser's own EventSource owns the
      // cross-origin rules: it reports a refusal as an error event and honours CORS.
      if (new URL(resolved).origin !== location.origin) return new NativeEventSource(url, init)
      return new RemoteEventSource(url, init)
    },
  })

  return { link, routedFetch }
}
