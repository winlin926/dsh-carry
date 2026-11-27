export interface ConnectionFace {
  state: {
    getSnapshot(): 'connecting' | 'connected' | 'disconnected' | undefined
    subscribe(listener: () => void): () => void
  }
  generation: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }
  reconnect(): void
}

export interface RemoteSnapshot {
  version?: string
  entry?: 'lan' | 'public'
  route?: 'lan' | 'direct' | 'public'
  phase: 'starting' | 'reconnecting' | 'connected' | 'blocked'
  reason?: 'network' | 'host-unavailable' | 'unpaired' | 'lan-unavailable' | 'identity-mismatch'
  durationMs?: number
}

export interface RemoteRuntime {
  getSnapshot(): RemoteSnapshot
  subscribe(listener: () => void): () => void
  bindConnection(connection: ConnectionFace): () => void
}

/** Serialized into the boot script, so it must have no runtime imports. */
export function createRemoteRuntime(entry?: RemoteSnapshot['entry'], version?: string) {
  if (version && !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(version)) version = undefined
  let connection: ConnectionFace | undefined
  let release: (() => void) | undefined
  let mux: { open: boolean; route: RemoteSnapshot['route'] } | undefined
  let seenMux = false
  let reason: RemoteSnapshot['reason']
  let started = performance.now()
  let snapshot: RemoteSnapshot = { version, entry, phase: 'starting' }
  const listeners = new Set<() => void>()
  const refresh = () => {
    const state = connection?.state.getSnapshot()
    const ready = state === 'connected' && connection?.generation.getSnapshot() != null && (!seenMux || mux?.open)
    let phase = snapshot.phase
    if (reason === 'unpaired') phase = 'blocked'
    else if (ready) {
      phase = 'connected'
      reason = undefined
    } else if (reason || phase === 'connected' || (seenMux && !mux) || state === 'disconnected') phase = 'reconnecting'
    const route = phase === 'connected' ? mux?.route : undefined
    if (snapshot.phase === phase && snapshot.route === route && snapshot.reason === reason) return
    if (phase === 'reconnecting' && snapshot.phase === 'connected') started = performance.now()
    const durationMs =
      phase === 'connected' || phase === 'blocked' ? Math.max(0, Math.round(performance.now() - started)) : undefined
    snapshot = { version, entry, route, phase, reason, durationMs }
    for (const listener of listeners) listener()
  }
  const api: RemoteRuntime = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    bindConnection(next) {
      release?.()
      connection = next
      const offState = next.state.subscribe(refresh),
        offGeneration = next.generation.subscribe(refresh)
      const unbind = () => {
        if (release !== unbind) return
        offState()
        offGeneration()
        release = undefined
        connection = undefined
        refresh()
      }
      release = unbind
      refresh()
      return unbind
    },
  }
  const report = (failure: RemoteSnapshot['reason']) => {
    if (reason === 'unpaired') return
    reason = failure
    refresh()
  }
  const observeMux = (socket: Pick<WebSocket, 'addEventListener'>, route: RemoteSnapshot['route']) => {
    const candidate = { open: false, route }
    mux = candidate
    seenMux = true
    socket.addEventListener('open', () => {
      if (mux === candidate) {
        candidate.open = true
        refresh()
      }
    })
    socket.addEventListener('close', () => {
      if (mux === candidate) {
        mux = undefined
        refresh()
      }
    })
    refresh()
  }
  const retry = (automatic = false): boolean => {
    const state = connection?.state.getSnapshot()
    if (!connection || state === undefined) return false
    if (
      snapshot.phase === 'blocked' ||
      navigator.onLine === false ||
      mux ||
      connection.generation.getSnapshot() != null
    )
      return true
    if (!automatic || (seenMux && state !== 'connected')) connection.reconnect()
    return true
  }
  let wake: ReturnType<typeof setTimeout> | undefined
  let nudged = false
  const wakeForeground = () => {
    if (document.hidden || nudged || wake !== undefined) return
    wake = setTimeout(() => {
      wake = undefined
      if (document.hidden || !seenMux || mux || navigator.onLine === false || snapshot.phase !== 'reconnecting') return
      const state = connection?.state.getSnapshot()
      if (
        !connection ||
        (state !== 'connecting' && state !== 'disconnected') ||
        connection.generation.getSnapshot() != null
      )
        return
      nudged = true
      retry(true)
    }, 0)
  }
  const resetWake = () => {
    clearTimeout(wake)
    wake = undefined
    nudged = false
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetWake()
    else wakeForeground()
  })
  window.addEventListener('pagehide', resetWake)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) wakeForeground()
  })
  return { api, observeMux, report, retry }
}
