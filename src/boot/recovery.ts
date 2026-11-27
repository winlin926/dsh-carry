import type { remoteDirect } from '../boot-direct.js'
import type { createRemoteRuntime } from '../remote-runtime.js'
import type { LanFallback, SayFn } from './types.js'

const DISCONNECTED_STYLE = `
#dsh-rc-disconnected {
  box-sizing: border-box;
  width: min(340px, calc(100% - 32px));
  padding: 20px;
  border: 1px solid var(--dsw-alias-border-l2, color-mix(in srgb, CanvasText 16%, Canvas));
  border-radius: 12px;
  background: var(--dsw-alias-background-primary, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
}
#dsh-rc-disconnected::backdrop { background: rgb(0 0 0 / 25%); }
#dsh-rc-disconnected h2 { margin: 0; font-size: 16px; font-weight: 600; }
#dsh-rc-disconnected p { margin: 8px 0 0; font-size: 14px; line-height: 1.55; }
#dsh-rc-disconnected button {
  display: block;
  margin: 12px 0 0 auto;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, color-mix(in srgb, CanvasText 16%, Canvas));
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}`

const STATUS_STYLE = `
#dsh-rc-connection-status {
  position: fixed;
  inset-inline: 52px;
  top: calc(env(safe-area-inset-top, 0px) + 3px);
  z-index: 2147483646;
  display: grid;
  justify-items: center;
  pointer-events: none;
}
#dsh-rc-connection-status button + [role="status"] {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
#dsh-rc-connection-status .connection-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-block-size: 44px;
  max-inline-size: 100%;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}
#dsh-rc-connection-status button { cursor: pointer; pointer-events: auto; }
#dsh-rc-connection-status .connection-line::before {
  content: '';
  flex: none;
  inline-size: 14px;
  block-size: 14px;
  background: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.2' stroke-linecap='round'%3E%3Cpath d='M1.3 5.3a11 11 0 0 1 13.4 0M3.6 7.8a7.2 7.2 0 0 1 8.8 0M5.8 10.2a3.6 3.6 0 0 1 4.4 0M8 12.7h.01'/%3E%3C/svg%3E") center / contain no-repeat;
}
#dsh-rc-connection-status button:focus-visible { outline: 1px solid currentColor; outline-offset: -5px; border-radius: 6px; }`

export async function isUnpairedResponse(response: Response, fromManagement = false): Promise<boolean> {
  const relayRefusal = fromManagement && response.status === 401
  if ((!relayRefusal && response.status !== 403) || !response.headers.get('content-type')?.includes('application/json'))
    return false
  try {
    const data = await response.clone().json()
    return relayRefusal ? data?.error?.code === 'AUTH_REQUIRED' : data?.code === 'unpaired'
  } catch {
    return false
  }
}

export function installRecovery(options: {
  runtime: ReturnType<typeof createRemoteRuntime>
  originalFetch: typeof fetch
  routedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  lanFallback: LanFallback | undefined
  link: ReturnType<typeof remoteDirect> | undefined
  announceLan: boolean
  say: SayFn
}): { probeAuthorization: () => void } {
  const { runtime, originalFetch, routedFetch, lanFallback, link, say } = options
  let announceLan = options.announceLan

  function disconnected(title: string, identityMismatch = false): void {
    if (document.getElementById('dsh-rc-disconnected')) return
    connectionStatus('')
    const dialog = document.createElement('dialog')
    dialog.id = 'dsh-rc-disconnected'
    dialog.setAttribute('aria-labelledby', 'dsh-rc-disconnected-title')
    dialog.setAttribute('aria-describedby', 'dsh-rc-disconnected-text')
    dialog.addEventListener('cancel', (event) => event.preventDefault())
    const style = document.createElement('style')
    style.textContent = DISCONNECTED_STYLE
    const heading = document.createElement('h2')
    heading.id = 'dsh-rc-disconnected-title'
    heading.textContent = title
    const instructions = document.createElement('p')
    instructions.id = 'dsh-rc-disconnected-text'
    dialog.setAttribute('lang', say('zh-CN', 'en'))
    instructions.textContent = identityMismatch
      ? say(
          '请在电脑上核对入口与指纹，从远程控制面板扫描新的二维码。',
          'Check the entry address and fingerprint on the computer, then scan a new QR code from Remote Control.',
        )
      : say(
          '在电脑上打开 DSH 的「远程控制」，用手机扫描新的二维码，并在电脑上确认。',
          'Open Remote Control in DSH on the computer, scan a new QR code, and approve the request.',
        )
    dialog.append(style, heading, instructions)
    if (identityMismatch) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = say('重试当前入口', 'Retry this entry')
      retry.onclick = () => {
        if (!runtime.retry()) location.reload()
      }
      dialog.append(retry)
    }
    ;(document.body ?? document.documentElement).append(dialog)
    dialog.showModal()
  }

  function connectionStatus(message: string, retry = false): void {
    document.getElementById('dsh-rc-connection-status')?.remove()
    if (!message || document.getElementById('dsh-rc-disconnected')) return
    const bar = document.createElement('div')
    bar.id = 'dsh-rc-connection-status'
    bar.setAttribute('lang', say('zh-CN', 'en'))
    const style = document.createElement('style')
    style.textContent = STATUS_STYLE
    const status = document.createElement('span')
    status.setAttribute('role', 'status')
    bar.append(style)
    if (retry) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'connection-line'
      button.textContent = message
      button.title = say('重试连接电脑', 'Retry the connection')
      button.setAttribute('aria-label', say('正在重新连接，点击重试', 'Reconnecting. Retry the connection'))
      button.onclick = () => {
        if (!runtime.retry()) location.reload()
      }
      bar.append(button)
    } else {
      status.className = 'connection-line'
    }
    bar.append(status)
    ;(document.body ?? document.documentElement).append(bar)
    status.textContent =
      message === say('正在重新连接…', 'Reconnecting…')
        ? say('正在重新连接电脑…', 'Reconnecting to the computer…')
        : message
    if (!retry) setTimeout(() => bar.remove(), 2600)
  }

  let fallbackTried = false
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  let fallbackCheck: AbortController | undefined

  const revoke = () => {
    if (runtime.api.getSnapshot().phase === 'blocked') return
    runtime.report('unpaired')
    document.getElementById('dsh-rc-disconnected')?.remove()
    disconnected(say('设备授权已失效', 'Device access expired'))
  }

  // Only navigate to the same Host, on the LAN origin embedded in this authenticated boot.
  async function switchToLan(): Promise<void> {
    if (!lanFallback || fallbackTried || runtime.api.getSnapshot().phase !== 'reconnecting') return
    fallbackTried = true
    const check = new AbortController()
    fallbackCheck = check
    const timeout = setTimeout(() => check.abort(), 6000)
    try {
      const response = await originalFetch('/rc/fallback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: check.signal,
      })
      if (fallbackCheck !== check) return
      if (await isUnpairedResponse(response)) {
        if (fallbackCheck === check) revoke()
        return
      }
      const data = (await response.json().catch(() => null)) as {
        sameHost?: unknown
        url?: unknown
        node?: unknown
        hostId?: unknown
        fingerprint?: unknown
        reason?: unknown
      } | null
      if (fallbackCheck !== check) return
      if (!response.ok || (data?.sameHost !== true && data?.reason !== 'identity')) {
        runtime.report('lan-unavailable')
        return
      }
      const target = typeof data?.url === 'string' ? data.url : ''
      const answerNode =
        data?.node && typeof data.node === 'object' && !Array.isArray(data.node)
          ? (data.node as Record<string, unknown>)
          : null
      const answer =
        answerNode && typeof answerNode.id === 'string' && typeof answerNode.fingerprint === 'string'
          ? { id: answerNode.id, fingerprint: answerNode.fingerprint }
          : typeof data?.hostId === 'string' && typeof data?.fingerprint === 'string'
            ? { id: data.hostId, fingerprint: data.fingerprint }
            : null
      const expected =
        lanFallback.node ??
        (lanFallback.hostId !== null && lanFallback.fingerprint !== null
          ? { id: lanFallback.hostId, fingerprint: lanFallback.fingerprint }
          : null)
      const sameOrigin = (() => {
        try {
          return new URL(target).origin === new URL(lanFallback.url).origin
        } catch {
          return false
        }
      })()
      if (
        data?.sameHost === true &&
        expected &&
        answer?.id === expected.id &&
        answer.fingerprint === expected.fingerprint &&
        sameOrigin
      ) {
        location.replace(new URL('/?rc=lan', target).href)
      } else {
        runtime.report('identity-mismatch')
        disconnected(say('局域网入口的主机身份不匹配', 'LAN entry belongs to a different host'), true)
      }
    } catch {
      if (fallbackCheck === check) runtime.report('lan-unavailable')
    } finally {
      clearTimeout(timeout)
      if (fallbackCheck === check) fallbackCheck = undefined
    }
  }

  let lastRoute: 'lan' | 'public' | 'direct' | undefined
  let lastMessage = ''
  runtime.api.subscribe(() => {
    const { phase, route, reason } = runtime.api.getSnapshot()
    if (phase === 'connected' || phase === 'blocked') {
      clearTimeout(fallbackTimer)
      fallbackTimer = undefined
      const check = fallbackCheck
      fallbackCheck = undefined
      check?.abort()
      if (phase === 'connected') {
        fallbackTried = false
        document.getElementById('dsh-rc-disconnected')?.remove()
        const changed = route && lastRoute && route !== lastRoute
        if (announceLan) {
          announceLan = false
          connectionStatus(say('已切换到局域网', 'Switched to the local network'))
        } else if (changed) {
          if (route === 'direct') connectionStatus(say('已切换到局域网直连', 'Switched to a direct LAN connection'))
          else if (route === 'public') connectionStatus(say('已切换到公网', 'Switched to the public entry'))
          else connectionStatus(say('已切换到局域网', 'Switched to the local network'))
        } else if (lastMessage) connectionStatus('')
        lastRoute = route
      }
      lastMessage = ''
      return
    }
    if (phase !== 'reconnecting') return
    const message =
      reason === 'lan-unavailable'
        ? say('局域网暂不可用，点击重试当前连接', 'LAN unavailable. Retry this connection')
        : say('正在重新连接…', 'Reconnecting…')
    if (message !== lastMessage) {
      lastMessage = message
      connectionStatus(message, true)
    }
  })

  window.addEventListener('dsh-rc-offline', () => {
    runtime.report('network')
    if (link) {
      link.invalidateUpstream()
      void link.probe()
      return
    }
    if (
      lanFallback &&
      !fallbackTried &&
      fallbackTimer === undefined &&
      runtime.api.getSnapshot().phase === 'reconnecting'
    ) {
      // Give the Host's current reconnect attempt a chance to finish.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined
        void switchToLan()
      }, 1500)
    }
  })

  window.fetch = async (...args) => {
    const response = await routedFetch(args[0], args[1])
    if (
      new URL(String(args[0] instanceof Request ? args[0].url : args[0]), location.href).origin === location.origin &&
      (await isUnpairedResponse(response))
    )
      revoke()
    return response
  }

  // Failed reconnects can reveal a revoked session after the initial network failure.
  let probing: Promise<unknown> | undefined
  const probeAuthorization = (): void => {
    if (probing || runtime.api.getSnapshot().phase === 'blocked') return
    probing = originalFetch('/api/dsh-remote-connect/manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    })
      .then(async (response) => {
        if (await isUnpairedResponse(response, true)) revoke()
        else if ([502, 503, 504].includes(response.status)) runtime.report('host-unavailable')
      })
      .catch(() => window.dispatchEvent(new Event('dsh-rc-offline')))
      .finally(() => {
        probing = undefined
      })
  }

  return { probeAuthorization }
}
