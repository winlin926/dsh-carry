import { createBootScreen } from '../boot-screen.js'
import type { SayFn } from './types.js'

type Graph = {
  rev: string
  entries: Array<{ id: string; url: string }>
  batches: Array<{ url: string; entries: string[] }>
}

export function installBootProgress(options: {
  globals: Record<string, any>
  transport: Record<string, any>
  originalFetch: typeof fetch
  language: 'zh' | 'en'
  say: SayFn
}): void {
  const { globals, transport, originalFetch, language, say } = options
  const started = performance.now()
  let phase: 'checking' | 'loading' | 'initializing' | 'ready' | 'failed' = 'checking'
  let result: 'unknown' | 'pending' | 'ready' | 'failed' = 'unknown'
  let observedBoot = false
  let loading = 0
  let completedResources = 0
  const errors: string[] = []
  const resources: Array<{
    origin: string
    path: string
    rev?: string
    result: 'loaded' | 'error'
    durationMs: number
  }> = []

  const resourceAddress = (value: string): { origin: string; path: string; rev?: string } => {
    try {
      const url = new URL(value, location.href)
      const rev = url.searchParams.get('rev')
      return {
        origin: url.origin.slice(0, 120),
        path: url.pathname.slice(0, 160),
        ...(rev && /^[\w-]{1,64}$/.test(rev) ? { rev } : {}),
      }
    } catch {
      return { origin: '', path: '' }
    }
  }
  const recordError = (message: string): void => {
    if (errors.length < 6 && !errors.includes(message)) errors.push(message)
  }

  let reported = 0
  let reportTimer: ReturnType<typeof setTimeout> | undefined
  const sendReport = (): void => {
    if (reported >= 3) return
    reported += 1
    const report = {
      ...resourceAddress(location.href),
      viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      ua: navigator.userAgent.slice(0, 300),
      phase,
      result,
      mounted: result === 'ready',
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      completedResources,
      resources: resources.slice(),
      errors: errors.slice(),
    }
    let payload = JSON.stringify(report)
    // The gateway accepts 8 KiB; non-ASCII paths can use three bytes per character.
    while (new TextEncoder().encode(payload).length > 7000 && (report.resources.length || report.errors.length)) {
      if (report.resources.length) report.resources.shift()
      else report.errors.pop()
      payload = JSON.stringify(report)
    }
    void originalFetch('/rc/boot-report', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: payload,
    }).catch(() => {
      /* diagnostics must never disturb the page */
    })
  }
  const scheduleReport = (delay: number): void => {
    if (reported >= 3) return
    clearTimeout(reportTimer)
    reportTimer = setTimeout(sendReport, delay)
  }

  const STORE_KEY = 'dsh-rc-boot-graph'
  /** The Host resolves `<package>/client` and its package onto one graph row. */
  const bare = (spec: string): string => (spec.endsWith('/client') ? spec.slice(0, -7) : spec)
  const addr = (value: string): string => {
    try {
      const url = new URL(value, location.href)
      url.searchParams.delete('rev')
      return url.href
    } catch {
      return value
    }
  }
  const rowAt = new Map<string, number>()
  const batchAt = new Map<string, number[]>()
  const singleAt = new Map<string, number>()
  const registered = new Set<number>()
  const early: unknown[] = []
  const inFlight: string[] = []
  const timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {}
  let screen: ReturnType<typeof createBootScreen> | null = createBootScreen(language)

  const VERDICT: Record<string, string> = {
    same: say('插件清单未变化', 'Plugin list unchanged'),
    changed: say('插件清单有变化', 'Plugin list changed'),
    first: say('首次核对完成', 'Plugin list checked for the first time'),
    unavailable: say('已读取本次插件清单', 'Current plugin list loaded'),
    unknown: say('无法核对插件变化', 'Could not check plugin changes'),
  }

  let graph: Graph | null = null
  let check: 'pending' | 'same' | 'changed' | 'first' | 'unavailable' | 'unknown' = 'pending'
  let counting: 'unknown' | 'watching' | 'absent' = 'unknown'
  let wrapped = false
  let completed = false
  let recent: number[] = []
  let newest = -1
  let shownCheck = ''
  let holdingVerdict = false

  const node = (tag: string, cls: string, parent?: HTMLElement): HTMLElement => {
    const made = document.createElement(tag) as HTMLElement
    made.className = cls
    if (parent) parent.append(made)
    return made
  }

  /** This navigation's graph, or null unless the Host published one this page can count against. */
  const readGraph = (wire: unknown): Graph | null => {
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null
    const value = wire as { rev?: unknown; entries?: unknown; batches?: unknown }
    if (typeof value.rev !== 'string' || !value.rev || !Array.isArray(value.entries)) return null
    const entries: Graph['entries'] = []
    const seen = new Set<string>()
    for (const row of value.entries as Array<{ id?: unknown; url?: unknown }>) {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.url !== 'string' || !row.url || seen.has(row.id))
        return null
      seen.add(row.id)
      entries.push({ id: row.id, url: row.url })
    }
    return { rev: value.rev, entries, batches: (Array.isArray(value.batches) ? value.batches : []) as Graph['batches'] }
  }

  /** Only a Host that took the page over leaves a baseline, so a broken boot is retried as broken. */
  const previousRevision = (() => {
    try {
      const store = window.localStorage
      return store ? store.getItem(STORE_KEY) : false
    } catch {
      return false
    }
  })()

  const remember = (): void => {
    try {
      if (graph) (window as unknown as { localStorage?: Storage }).localStorage?.setItem(STORE_KEY, graph.rev)
    } catch {
      /* a page without storage keeps no baseline */
    }
  }

  const observe = (registration: unknown): void => {
    if (!graph) {
      if (early.length < 1000) early.push(registration)
      return
    }
    const value = registration as { id?: unknown; chunk?: unknown }
    if (typeof value?.id !== 'string' || value.chunk !== undefined) return
    const at = rowAt.get(bare(value.id))
    if (at === undefined || registered.has(at)) return
    registered.add(at)
    recent.push(at)
    scheduleProgress()
  }

  const moduleName = (id: string): string =>
    ({
      '@deepseek-ai/dsh-client-connection': say('连接服务', 'Connection service'),
      '@deepseek-ai/dsh-client-ui-settings': say('界面设置', 'Settings'),
      '@deepseek-ai/dsh-client-ui-sidebar': say('会话侧栏', 'Conversation sidebar'),
      '@deepseek-ai/dsh-client-ui-theme': say('界面主题', 'Theme'),
    })[id] ??
    id
      .replace(/^@[^/]+\//, '')
      .replace(/^dsh-client-/, '')
      .replace(/-/g, ' ')

  const inFlightName = (): string => {
    if (!graph) return ''
    for (const url of inFlight)
      for (const at of batchAt.get(url) ?? (singleAt.has(url) ? [singleAt.get(url)!] : []))
        if (!registered.has(at)) return say('正在准备：', 'Preparing: ') + moduleName(graph.entries[at]!.id)
    return newest < 0 ? '' : say('刚完成：', 'Loaded: ') + moduleName(graph.entries[newest]!.id)
  }

  const adopt = (snapshot: Graph | null): void => {
    if (!snapshot || graph) return
    graph = snapshot
    for (const [index, row] of snapshot.entries.entries()) rowAt.set(bare(row.id), index)
    for (const batch of snapshot.batches) {
      if (typeof batch?.url !== 'string' || !Array.isArray(batch.entries)) continue
      const positions = batch.entries
        .map((id) => rowAt.get(bare(id)))
        .filter((index): index is number => index !== undefined)
      if (positions.length) batchAt.set(addr(batch.url), positions)
    }
    // A batch that already executed without one row is retried once as that row's own bundle.
    for (const row of snapshot.entries)
      if (!singleAt.has(addr(row.url))) singleAt.set(addr(row.url), rowAt.get(bare(row.id))!)
    check =
      previousRevision === false
        ? 'unavailable'
        : previousRevision === null
          ? 'first'
          : previousRevision === snapshot.rev
            ? 'same'
            : 'changed'
    for (const registration of early.splice(0)) observe(registration)
    paint()
  }

  const removeScreen = (): void => {
    for (const name in timers) clearTimeout(timers[name])
    screen?.remove()
    screen = null
  }

  const paint = (): void => {
    if (!screen) return
    clearTimeout(timers.progress)
    timers.progress = undefined
    if (recent.length) {
      newest = Math.min(...recent)
      recent = []
    }
    const total = graph?.entries.length ?? 0
    const counted = counting === 'watching' && total > 0
    const done = registered.size
    const settled = check !== 'pending'
    const holding = settled && (shownCheck !== check || holdingVerdict)
    const moduleCount = total
      ? say(`共 ${total} 个模块`, `${total} modules`)
      : say('无需加载模块', 'No modules to load')
    const verdict = VERDICT[check] ?? VERDICT.unknown!
    let stage = ''
    let count = ''
    let detail = ''
    if (completed) {
      stage = say('✓ 启动完成', '✓ Startup complete')
      detail = say('工作区已就绪', 'Workspace ready')
    } else if (phase === 'loading' || phase === 'initializing') {
      stage =
        phase === 'loading' ? say('正在加载模块', 'Loading modules') : say('正在初始化插件', 'Initializing plugins')
      if (counted) count = say(`${done} / ${total} 个模块`, `${done} / ${total} modules`)
      else if (graph) count = moduleCount
      if (!settled) detail = say('正在检查插件变化…', 'Checking for plugin changes…')
      else if (holding) detail = verdict
      else if (phase === 'loading') detail = inFlightName()
      else detail = say('正在接管工作区…', 'Opening the workspace…')
    } else if (!settled) {
      stage = say('正在检查插件变化…', 'Checking for plugin changes…')
      detail = say('正在读取插件清单…', 'Reading the plugin list…')
      if (graph) count = moduleCount
    } else {
      stage = verdict
      if (graph) count = moduleCount
    }
    const announcement = !completed && holding && verdict !== stage ? verdict + say('。', '. ') + stage : stage
    screen.paint({
      stage,
      count,
      detail,
      complete: completed,
      announcement,
      progress:
        completed || (graph && !total)
          ? null
          : counted && (phase === 'loading' || phase === 'initializing')
            ? done / total
            : 'pending',
    })
    if (settled && shownCheck !== check) {
      shownCheck = check
      holdingVerdict = true
      clearTimeout(timers.verdict)
      const shown = check
      const displayed = () => {
        if (!screen || check !== shown) return
        timers.verdict = setTimeout(() => {
          holdingVerdict = false
          if (result === 'ready') showComplete()
          else paint()
        }, 320)
      }
      // A busy parser may not paint between setting the text and mounting the workspace.
      window.requestAnimationFrame(() => window.requestAnimationFrame(displayed))
    }
  }

  const scheduleProgress = (): void => {
    if (!screen || timers.progress !== undefined) return
    timers.progress = setTimeout(paint, 80)
  }

  /** Wrap the HTML facade once: its queue holds the parser batch, its live sink every later bundle. */
  const watchLoader = (): void => {
    if (wrapped) return
    const facade = (window as unknown as Record<string, any>).__ModuleLoader__ as Record<string, any> | undefined
    if (!facade || typeof facade !== 'object') return
    if (typeof facade.create !== 'function' || facade.mode !== 'queue') {
      wrapped = true
      counting = 'absent'
      return
    }
    const create = facade.create
    facade.create = function (this: Record<string, any>, ...options: unknown[]): unknown {
      adopt(readGraph((options[0] as { boot?: unknown } | undefined)?.boot))
      // create() drains the queue itself, so the parser batch is only countable before it runs.
      const pending = Array.isArray(this.pendingQueue) ? this.pendingQueue.slice() : []
      const system = create.apply(this, options)
      for (const registration of pending) observe(registration)
      const load = this.load
      if (typeof load === 'function')
        this.load = function (this: unknown, registration: unknown): unknown {
          observe(registration)
          return load.apply(this, [registration])
        }
      counting = 'watching'
      scheduleProgress()
      return system
    }
    wrapped = true
  }

  const showComplete = (): void => {
    if (completed || !screen) return
    completed = true
    paint()
    timers.hold = setTimeout(() => {
      screen?.fade()
      timers.fade = setTimeout(removeScreen, 160)
    }, 440)
  }

  const finishReady = (): void => {
    if (result === 'ready') return
    phase = 'ready'
    result = 'ready'
    observer.disconnect()
    scheduleReport(100)
    remember()
    if (previousRevision || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      removeScreen()
      return
    }
    screen?.hideControls()
    if (check === 'pending') {
      check = 'unknown'
      paint()
    }
    if (!holdingVerdict) showComplete()
  }

  const finishFailed = (boot: HTMLElement): void => {
    if (result === 'failed') return
    phase = 'failed'
    result = 'failed'
    recordError('official-startup-failure')
    observer.disconnect()
    scheduleReport(100)
    removeScreen()
    let status = boot.querySelector<HTMLElement>('[data-dsh-rc-boot-status]')
    if (!status) {
      status = node('div', '', (boot.firstElementChild ?? boot) as HTMLElement)
      status.dataset.dshRcBootStatus = ''
      status.style.cssText = 'margin:12px auto 0;text-align:center;opacity:.8'
      status.textContent = say('启动失败，请查看上方错误。', 'Startup failed. See the error above.')
    }
    status.setAttribute('role', 'alert')
    status.setAttribute('lang', say('zh-CN', 'en'))
    const retry = node('button', '', status) as HTMLButtonElement
    retry.textContent = say('重新加载', 'Reload')
    retry.style.cssText =
      'margin:12px auto 0;padding:8px 16px;border:1px solid currentColor;border-radius:999px;background:none;color:inherit'
    retry.onclick = () => {
      retry.disabled = true
      location.reload()
    }
  }

  const updateBoot = (): void => {
    screen?.mount()
    watchLoader()
    if (!graph) adopt(readGraph((window as unknown as Record<string, any>).__DSH_BOOT__))
    if (result === 'ready' || result === 'failed') return
    const root = document.getElementById('root')
    const boot = root?.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
    if (!boot) {
      // The renderer replaces its boot DOM after the first React layout effect.
      if (observedBoot && root?.childElementCount) finishReady()
      else scheduleProgress()
      return
    }
    observedBoot = true
    result = 'pending'
    const failed =
      !boot.querySelector('[data-dsh-boot-spinner]') &&
      /Failed to load plugins|插件加载失败/.test(boot.textContent ?? '')
    if (failed) {
      finishFailed(boot)
      return
    }
    // Real registrations outrank transport counts: 'initializing' means every graph row arrived.
    const total = graph?.entries.length ?? 0
    phase = loading
      ? 'loading'
      : counting === 'watching' && total
        ? registered.size >= total
          ? 'initializing'
          : 'loading'
        : completedResources
          ? 'initializing'
          : 'checking'
    scheduleProgress()
  }

  paint()
  // A Host that never publishes a graph leaves nothing to compare, and the reader must be told.
  timers.check = setTimeout(() => {
    if (check === 'pending') {
      check = 'unknown'
      paint()
    }
  }, 3000)
  const observer = new MutationObserver(updateBoot)
  observer.observe(document.documentElement, { childList: true, subtree: true })

  const previousLoad =
    typeof transport.loadBundle === 'function'
      ? (transport.loadBundle.bind(transport) as (url: string) => Promise<void>)
      : undefined
  globals.__DSH_TRANSPORT__.loadBundle = (url: string): Promise<void> => {
    const began = performance.now()
    loading++
    inFlight.push(addr(url))
    updateBoot()
    const request = new Promise<void>((resolve, reject) => {
      if (previousLoad) {
        resolve(previousLoad(url))
        return
      }
      const script = document.createElement('script')
      script.async = true
      script.src = url
      script.addEventListener(
        'load',
        () => {
          script.remove()
          resolve()
        },
        { once: true },
      )
      script.addEventListener(
        'error',
        () => {
          script.remove()
          reject(new Error('client-modules: bundle script failed to load'))
        },
        { once: true },
      )
      document.head.append(script)
    })
    const record = (outcome: 'loaded' | 'error'): void => {
      const arrived = inFlight.indexOf(addr(url))
      if (arrived >= 0) inFlight.splice(arrived, 1)
      if (outcome === 'loaded') completedResources++
      resources.push({
        ...resourceAddress(url),
        result: outcome,
        durationMs: Math.max(0, Math.round(performance.now() - began)),
      })
      if (resources.length > 8) resources.shift()
      loading--
      updateBoot()
    }
    // The module loader owns retries and fallback; observing a request must not replay it.
    return request.then(
      () => {
        record('loaded')
      },
      (failure) => {
        record('error')
        throw failure
      },
    )
  }

  window.addEventListener(
    'error',
    (event) => {
      const failure = event as ErrorEvent
      if (
        failure.message === 'ResizeObserver loop completed with undelivered notifications.' ||
        failure.message === 'ResizeObserver loop limit exceeded'
      )
        return
      const target = event.target as (HTMLScriptElement & HTMLLinkElement & HTMLImageElement) | null
      if (target?.tagName && ['SCRIPT', 'LINK', 'IMG'].includes(target.tagName)) {
        const address = resourceAddress(target.src || target.href || '')
        recordError(
          `resource-event:${target.tagName.toLowerCase()}:${address.path}${address.rev ? `@${address.rev}` : ''}`,
        )
      } else if (failure.message)
        recordError(`javascript-error:${resourceAddress(failure.filename || '').path}:${failure.lineno || 0}`)
    },
    true,
  )
  window.addEventListener('unhandledrejection', () => {
    recordError('unhandled-rejection')
  })

  updateBoot()
  scheduleReport(8000)
}
