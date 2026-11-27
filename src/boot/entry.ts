/** Runs before the remote app and the Host's client modules. No device or Host credential is embedded. */
import { createRemoteRuntime } from '../remote-runtime.js'
import { createDirectControl } from './direct-transport.js'
import { installFileLinkInterceptor } from './file-links.js'
import { installBootProgress } from './progress.js'
import { installRecovery } from './recovery.js'
import type { BootContext, SayFn } from './types.js'

export function runRemoteBoot(context: BootContext | null): void {
  const globals = window as unknown as Record<string, any>
  globals.__DSH_REMOTE_CONTROL__ = true
  const runtime = createRemoteRuntime(context?.entry, context?.version)
  globals.__DSH_RC_CONNECTION__ = runtime.api

  const language: 'zh' | 'en' = (() => {
    try {
      const saved = window.localStorage?.getItem('dsh-rc-language')
      if (saved === 'zh' || saved === 'en') return saved
    } catch {
      /* storage is optional */
    }
    return navigator.language && !/^zh\b/i.test(navigator.language) ? 'en' : 'zh'
  })()
  const say: SayFn = (zh, en) => (language === 'en' ? en : zh)

  // The Host owns the document language, theme colour and keyboard policy since 0.2.2: a phone
  // gets its mobile layout from the Host itself. Only the browser's translate offer is ours to
  // refuse, because the app's own copy is what the reader is looking at.
  document.documentElement.setAttribute('translate', 'no')

  // A page reached through the same-host fallback says so once, then drops the marker from the address.
  const announceLan = new URLSearchParams(location.search || '').get('rc') === 'lan'
  if (announceLan) {
    try {
      const clean = new URL(location.href)
      clean.searchParams.delete('rc')
      window.history?.replaceState?.(null, '', clean.pathname + clean.search + clean.hash)
    } catch {
      /* The marker may stay if the address cannot be rewritten. */
    }
  }

  const transport = globals.__DSH_TRANSPORT__ ?? {}
  globals.__DSH_TRANSPORT__ = transport
  const originalFetch = window.fetch.bind(window)

  let probeAuth = () => {}
  const { link, routedFetch } = createDirectControl({
    globals,
    context,
    originalFetch,
    runtime,
    onMuxLost: () => probeAuth(),
  })

  if (!crypto.randomUUID) {
    Object.defineProperty(crypto, 'randomUUID', {
      value: () =>
        '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
          (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16),
        ),
      writable: true,
      configurable: true,
    })
  }

  probeAuth = installRecovery({
    runtime,
    originalFetch,
    routedFetch,
    lanFallback: context?.fallback,
    link,
    announceLan,
    say,
  }).probeAuthorization

  installFileLinkInterceptor({ link, language, say })
  installBootProgress({ globals, transport, originalFetch, language, say })
}
