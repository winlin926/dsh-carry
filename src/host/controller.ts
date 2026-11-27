import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DirectHost } from '../direct/peer.js'
import { Gateway } from '../gateway.js'
import { fingerprintGroupsOf, type HostIdentity } from '../host-identity.js'
import { readLanTls, type LanTlsMaterial } from '../lan-tls.js'
import { PairingService } from '../pairing.js'
import { PUBLIC_PORT, PublicAccess } from '../public-access.js'
import { PublicNodeConfig, type PublicNodeRecord } from '../public-node-config.js'
import type { PublicNodeDiscovery } from '../public-node.js'
import { normalizePublicUrl } from '../public-url-settings.js'
import { ServiceNode, forgetServiceNode, unregisterServiceNode } from '../service-node.js'
import { detectSystemProxy, type SystemProxy } from '../system-proxy.js'
import { bootScript } from '../boot.js'
import { appendBootReport } from './boot-report.js'
import { createQrCache, fetchUpstreamIndex, hostCookie, lanAddresses } from './network.js'
import { isProxyMode, loadPreferences, savePreferencesFile } from './preferences.js'
import type { PublicNodeDeps } from './public-node-actions.js'
import {
  IDENTITY_CHANGE_ERROR,
  type HostPluginConfig,
  type LaunchPlan,
  type Mode,
  type Preferences,
  type PublicTarget,
} from './types.js'

export function resolvePublicTarget(
  currentNode: PublicNodeRecord | undefined,
  accessDomain: string | null | undefined,
): PublicTarget {
  if (currentNode?.kind === 'service') return { kind: 'service', record: currentNode }
  const origin = currentNode?.kind === 'gateway' ? currentNode.url : accessDomain
  return origin ? { kind: 'gateway', origin } : { kind: 'none' }
}

export function resolveLaunchPlan(
  mode: Mode,
  target: PublicTarget,
  configPort: number | undefined,
  savedPort: number | undefined,
): LaunchPlan {
  const fixedPublicPort = mode === 'public' && target.kind !== 'service'
  const wantedPort = configPort || (fixedPublicPort ? PUBLIC_PORT : savedPort || 0)
  return { mode, target, fixedPublicPort, wantedPort }
}

export interface HostControllerOptions {
  storage: string
  legacyStorage: string
  config: HostPluginConfig
  hostIdentity: HostIdentity
  discovery: PublicNodeDiscovery
  nodeVersion: string
  connection: Context['connection']
  upstreamPort: number
  logWarn?: (message: string) => void
  onManage: (input: Record<string, unknown>, local: boolean) => Promise<unknown>
}

export class HostController {
  private readonly prefsFile: string
  private readonly pairing: PairingService
  private readonly access: PublicAccess
  private readonly qrImage: (url: string) => Promise<string>
  private publicNodes: PublicNodeConfig | undefined
  private publicNodesError: string | undefined
  private preferences: Preferences
  private credential: string
  private credentialTimer: ReturnType<typeof setInterval>
  private monitor: ReturnType<typeof setInterval> | undefined
  private probing = false
  private detectedProxy: { at: number; value: SystemProxy | null } | undefined
  private gateway: Gateway | undefined
  private lanTls: LanTlsMaterial | undefined
  private lanTlsError: string | undefined
  private enabled = false
  private busy = false
  private disposed = false
  private activeMode: Mode | undefined
  private generation = 0
  private qr: { token: string; expiresAt: number } | undefined
  private directHost: DirectHost | undefined
  private serviceNode: ServiceNode | undefined
  private relayMark = ''
  private readonly relayDevices = new Set<string>()
  private serviceQr: { url: string; expiresAt: number } | undefined
  private serviceQrInflight: Promise<void> | undefined
  private serviceUnregisterNotice: { origin: string; message: string } | undefined
  private error: string | undefined

  constructor(private readonly options: HostControllerOptions) {
    this.prefsFile = join(options.storage, 'preferences.json')
    const loadedPrefs = loadPreferences(this.prefsFile)
    this.preferences = loadedPrefs.preferences
    this.error = loadedPrefs.error

    try {
      this.publicNodes = new PublicNodeConfig({
        file: join(options.storage, 'public-nodes.json'),
        legacyFile: join(options.storage, 'public-url.json'),
      })
    } catch (failure) {
      this.publicNodesError = failure instanceof Error ? failure.message : '公网节点配置文件读取失败。'
      this.error = this.publicNodesError
    }

    this.pairing = new PairingService({
      file: join(options.storage, 'devices.json'),
      onRevoke: (id) => this.gateway?.revoke(id),
      isOnline: (id) => this.gateway?.onlineIds().includes(id) ?? false,
    })
    this.pairing.prune((device) => !!device.host && /(?:\.trycloudflare\.com|\.lhr\.life)$/i.test(device.host))

    this.credential = hostCookie(options.connection, options.upstreamPort)
    // The Host session cookie is absolute (30 days by default). Refresh it well before that,
    // so a gateway left running for weeks never starts answering 401 to every remote request.
    this.credentialTimer = setInterval(() => {
      try {
        this.credential = hostCookie(options.connection, options.upstreamPort)
      } catch {
        /* keep the current cookie */
      }
    }, 12 * 3600_000)
    this.credentialTimer.unref()

    this.qrImage = createQrCache()
    this.access = new PublicAccess({
      certificateDir: options.config.certificateDir || process.env.DSH_RC_CERTIFICATE_DIR,
      storage: options.storage,
      legacyStorage: options.legacyStorage,
      identity: { hostId: options.hostIdentity.hostId, fingerprint: options.hostIdentity.fingerprint },
      proxy: async () => {
        if (this.preferences.proxyMode === 'manual') return this.preferences.proxy
        if (this.preferences.proxyMode === 'system') return (await this.systemProxy(true))?.url
        return undefined
      },
      beforeIssue: async () => {
        if (!this.enabled || this.activeMode !== 'public' || this.gateway?.port !== PUBLIC_PORT) {
          throw new Error('请先开启固定公网连接，再申请证书。')
        }
      },
      log: options.logWarn,
    })
  }

  async init(): Promise<void> {
    await this.access.migrate()
    this.migrateDevices()
    this.access.certificates.startAutoRenew()
  }

  async maybeAutoStart(): Promise<void> {
    if (!this.preferences.autoStart || this.disposed) return
    await this.start().catch((failure) => {
      if (this.disposed) return
      const message = failure instanceof Error ? failure.message : '启动失败。'
      this.error =
        this.preferences.mode === 'public' && /请先填写固定公网域名/.test(message)
          ? '未开启远程连接：旧版临时公共隧道已移除，请配置固定公网域名后再开启。'
          : message
    })
  }

  markDisposed(): void {
    this.disposed = true
  }

  disposeResources(): void {
    this.stopMonitor()
    clearInterval(this.credentialTimer)
    void this.access.certificates.stop()
    void this.access.resetOutbound()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  currentNode(): PublicNodeRecord | undefined {
    const current = this.publicNodes?.current
    return current ? this.publicNodes?.list().find((record) => record.id === current) : undefined
  }

  private nodeStore(): PublicNodeConfig {
    if (!this.publicNodes) throw new Error(this.publicNodesError ?? '公网节点配置不可用。')
    return this.publicNodes
  }

  private migrateDevices(): void {
    try {
      this.pairing.migratePublicDevices(this.access.domain ? [this.access.domain] : [])
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : '旧公网设备授权迁移失败。'
    }
  }

  private async renderIndex(): Promise<string> {
    try {
      return await fetchUpstreamIndex(this.options.upstreamPort, this.credential)
    } catch (failure) {
      // A gateway left running for weeks can outlive its Host session; renew once before failing.
      if ((failure as { status?: number }).status !== 401) throw failure
      this.credential = hostCookie(this.options.connection, this.options.upstreamPort)
      return fetchUpstreamIndex(this.options.upstreamPort, this.credential)
    }
  }

  private lanURLs(): string[] {
    const port = this.gateway?.port
    if (!this.enabled || !port) return []
    return this.lanTls ? [this.lanTls.origin] : lanAddresses().map((ip) => `http://${ip}:${port}`)
  }

  private async systemProxy(fresh = false): Promise<SystemProxy | null> {
    if (fresh || !this.detectedProxy || Date.now() - this.detectedProxy.at > 15_000) {
      this.detectedProxy = { at: Date.now(), value: await detectSystemProxy().catch(() => null) }
    }
    return this.detectedProxy.value
  }

  private direct(): DirectHost {
    this.directHost ??= new DirectHost({
      port: () => this.gateway?.port ?? 0,
      log: (message) => {
        try {
          this.options.logWarn?.(`[direct] ${message}`)
        } catch {
          /* logging must never break a connection */
        }
      },
    })
    return this.directHost
  }

  private clearRelay(): void {
    this.relayMark = ''
    for (const id of this.relayDevices) this.gateway?.revoke(id)
    this.relayDevices.clear()
  }

  private logServiceNode(event: string, fields: Record<string, unknown>): void {
    try {
      this.options.logWarn?.(`[${event}] ${JSON.stringify(fields)}`)
    } catch {
      /* logging must never break the tunnel */
    }
  }

  private async ensureServiceQr(): Promise<void> {
    // A ticket stays valid until its expiry; connect and switch paths only ask for a new one when the
    // panel has nothing usable to show.
    if (this.serviceQr && this.serviceQr.expiresAt > Date.now()) return
    await this.issueServiceQr()
  }

  private issueServiceQr(): Promise<void> {
    if (this.serviceQrInflight) return this.serviceQrInflight
    const node = this.serviceNode
    if (!node) return Promise.resolve()
    this.serviceQrInflight = (async () => {
      try {
        const ticket = await node.issueTicket()
        // The node may have been stopped or swapped while the ticket request was in flight.
        if (this.serviceNode === node) this.serviceQr = ticket
      } catch {
        /* ServiceNode.lastError carries the Chinese reason the panel shows */
      } finally {
        this.serviceQrInflight = undefined
      }
    })()
    return this.serviceQrInflight
  }

  async reconcileServiceNode(): Promise<void> {
    const record = this.currentNode()
    // A node whose identity changed is used for nothing until the user confirms it: the tunnel must
    // not register this Host with a node that may be someone else now.
    const wanted =
      this.enabled &&
      this.activeMode === 'public' &&
      this.preferences.mode === 'public' &&
      record?.kind === 'service' &&
      record.identityChange === null
        ? record.url
        : undefined
    if (this.serviceNode && this.serviceNode.status().origin !== wanted) {
      const previous = this.serviceNode
      this.serviceNode = undefined
      this.serviceQr = undefined
      this.clearRelay()
      await previous.stop()
    }
    if (!wanted) {
      this.serviceQr = undefined
      this.clearRelay()
      return
    }
    if (this.serviceNode || this.disposed) return
    const scope = record?.node?.id ?? record?.fingerprint ?? wanted
    this.relayMark = `${randomUUID()}:`
    const mark = this.relayMark
    const node = new ServiceNode({
      origin: wanted,
      hostId: this.options.hostIdentity.hostId,
      identityKey: this.options.hostIdentity.publicKey,
      clientVersion: this.options.nodeVersion,
      upstreamPort: this.options.upstreamPort,
      upstreamCookie: () => this.credential,
      storage: this.options.storage,
      log: (event, fields) => this.logServiceNode(event, fields),
      relayTarget: (device) => {
        if (this.relayMark !== mark || !this.gateway || this.currentNode()?.identityChange !== null) return undefined
        const id = this.pairing.admitRelay(scope, device)
        if (!id) return undefined
        this.relayDevices.add(id)
        return { port: this.gateway.port, mark: mark + id }
      },
      relayPairComplete: (id) => {
        if (this.relayMark === mark) this.pairing.confirmRelay(scope, id)
      },
      relayPairRevoked: (id) => {
        if (this.relayMark === mark) this.pairing.revokeRelay(scope, id)
      },
      onConnected: () => {
        this.serviceUnregisterNotice = undefined
        void this.ensureServiceQr()
      },
    })
    this.serviceNode = node
    // start() reports failures through status().lastError and keeps retrying; it never rejects.
    await node.start()
    // start() resolves after the first attempt; later connects ask for a ticket through the callback.
    if (node.status().connected) await this.ensureServiceQr()
  }

  private stopMonitor(): void {
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = undefined
  }

  private async probeDomain(): Promise<void> {
    if (this.probing || !this.enabled || this.activeMode !== 'public' || !this.access.domain) return
    this.probing = true
    try {
      // One failed sample is a blink, not a diagnosis: a handshake can abort on a single probe
      // while the entry is fine for every phone. Probe again before the panel is told it is down.
      const first = await this.access.checkDomain()
      if (!first.reachable && this.enabled && this.activeMode === 'public') await this.access.checkDomain()
    } catch {
      /* the check reports its own failures */
    } finally {
      this.probing = false
    }
  }

  private startMonitor(): void {
    this.stopMonitor()
    this.monitor = setInterval(() => void this.probeDomain(), 30_000)
    this.monitor.unref()
    void this.probeDomain()
  }

  async stop(): Promise<void> {
    ++this.generation
    this.enabled = false
    this.activeMode = undefined
    this.lanTls = undefined
    this.access.setActive(false)
    this.qr = undefined
    this.pairing.invalidate()
    this.stopMonitor()
    const current = this.gateway
    this.gateway = undefined
    await current?.close()
    // A direct channel points at the gateway that just closed; keeping it would only keep a
    // phone on a line whose target no longer exists.
    const channels = this.directHost
    this.directHost = undefined
    await channels?.close()
    await this.reconcileServiceNode()
  }

  async start(): Promise<void> {
    if (this.busy) throw new Error('连接操作正在进行，请稍后再试。')
    const node = this.currentNode()
    const target = resolvePublicTarget(node, this.access.domain)
    const serviceNodeMode = target.kind === 'service'
    // A node that started presenting another identity may not be connected through until confirmed.
    if (this.preferences.mode === 'public' && node?.identityChange) throw new Error(IDENTITY_CHANGE_ERROR)
    if (this.preferences.mode === 'public' && !serviceNodeMode && !this.access.domain)
      throw new Error('请先添加公网节点并设为当前，再开启“公网连接”。')

    this.busy = true
    this.error = undefined
    let ticket = this.generation
    let next: Gateway | undefined
    let stopped = false
    try {
      const mode = this.preferences.mode
      let tls: LanTlsMaterial | undefined
      if (mode === 'lan' && this.options.config.lanTls) {
        try {
          tls = await readLanTls(this.options.config.lanTls, this.options.config.gatewayPort ?? 0)
          this.lanTlsError = undefined
        } catch (failure) {
          this.lanTlsError = failure instanceof Error ? failure.message : '局域网证书读取失败。'
          throw failure
        }
      }
      if (this.disposed || ticket !== this.generation) return
      const stopping = this.stop()
      ticket = this.generation
      stopped = true
      await stopping
      if (this.disposed || ticket !== this.generation) return

      this.credential = hostCookie(this.options.connection, this.options.upstreamPort)
      const create = () =>
        new Gateway({
          pairing: this.pairing,
          upstreamPort: this.options.upstreamPort,
          upstreamCookie: () => this.credential,
          manage: this.options.onManage,
          index: () => this.renderIndex(),
          boot: (context) => bootScript({ ...context, version: this.options.nodeVersion }),
          discovery: this.options.discovery,
          lanTls: tls,
          addresses: lanAddresses,
          public: mode === 'public' ? () => this.access : undefined,
          // This same computer's LAN entry, handed only to an authorized public page through the
          // injected boot context; the fallback target never comes from the phone.
          lanFallback: () => {
            if (!this.enabled || this.activeMode !== 'public' || !this.gateway) return undefined
            const address = lanAddresses()[0]
            return address ? `http://${address}:${this.gateway.port}` : undefined
          },
          websocketCompression: this.options.config.websocketCompression !== false,
          relayDevice: (mark) =>
            this.relayMark && mark.startsWith(this.relayMark) ? mark.slice(this.relayMark.length) : undefined,
          direct: {
            offer: (deviceId, sdp) => this.direct().offer(deviceId, sdp),
            resolve: (mark) => this.directHost?.mark(mark),
            preference: () => this.preferences.line,
            closeDevice: (deviceId) => this.directHost?.closeDevice(deviceId),
          },
          onBootReport: (report, device) => {
            try {
              appendBootReport(join(this.options.storage, 'boot-reports.jsonl'), report, device)
            } catch {
              /* diagnostics must never break the gateway */
            }
          },
        })

      const plan = resolveLaunchPlan(mode, target, this.options.config.gatewayPort, this.preferences.port)
      const host = '0.0.0.0'
      next = create()
      try {
        await next.listen(host, plan.wantedPort)
      } catch (failure) {
        const code = (failure as NodeJS.ErrnoException).code ?? ''
        if (plan.fixedPublicPort && code === 'EADDRINUSE') {
          throw new Error(
            `公网端口 ${plan.wantedPort} 已被占用：可能另一个 DSH 配置正在使用公网模式，请先关闭它的远程连接。`,
          )
        }
        // Only a port that cannot be had is worth a second try on another one.
        if (
          plan.fixedPublicPort ||
          this.options.config.gatewayPort ||
          !plan.wantedPort ||
          !['EADDRINUSE', 'EACCES'].includes(code)
        ) {
          throw failure
        }
        await next.close()
        next = create()
        await next.listen(host, 0)
      }

      if (!plan.fixedPublicPort && !this.options.config.gatewayPort && next.port !== this.preferences.port) {
        this.preferences = { ...this.preferences, port: next.port }
        try {
          savePreferencesFile(this.prefsFile, this.preferences)
        } catch {
          /* only a convenience */
        }
      }
      if (this.disposed || ticket !== this.generation) {
        await next.close()
        return
      }

      this.gateway = next
      if (tls) this.lanTls = tls
      else this.lanTlsError = undefined
      this.enabled = true
      this.activeMode = mode
      this.access.setActive(mode === 'public')
      this.qr = this.pairing.issue()
      this.serviceQr = undefined
      if (mode === 'public') this.startMonitor()
      else this.stopMonitor()

      try {
        await this.reconcileServiceNode()
        if (serviceNodeMode) await this.ensureServiceQr()
      } catch (failure) {
        this.logServiceNode('service-node-error', {
          origin: this.currentNode()?.url ?? '',
          message: failure instanceof Error ? failure.message : '自托管节点启动失败。',
        })
      }
    } catch (failure) {
      await next?.close()
      if (ticket === this.generation && !this.disposed) {
        this.error = failure instanceof Error ? failure.message : '启动失败。'
        if (stopped) await this.stop()
      }
      throw failure
    } finally {
      this.busy = false
    }
  }

  async reloadLanCertificate(): Promise<void> {
    if (this.busy) throw new Error('连接操作正在进行，请稍后再试。')
    if (!this.options.config.lanTls || !this.enabled || this.activeMode !== 'lan' || !this.gateway)
      throw new Error('请先开启局域网 HTTPS。')
    this.busy = true
    const current = this.gateway
    const ticket = this.generation
    try {
      const next = await readLanTls(this.options.config.lanTls, this.options.config.gatewayPort ?? 0)
      if (this.disposed || ticket !== this.generation || this.gateway !== current)
        throw new Error('连接状态已变化，请重新开启后再重载证书。')
      current.reloadLanCertificate(next)
      this.lanTls = next
      this.lanTlsError = undefined
    } catch (failure) {
      this.lanTlsError = failure instanceof Error ? failure.message : '证书重载失败。'
      throw failure
    } finally {
      this.busy = false
    }
  }

  async switchMode(local: boolean): Promise<Record<string, unknown> | { switching: true; mode: Mode }> {
    if (this.busy) throw new Error('连接操作正在进行，请稍后再试。')
    if (this.preferences.mode === this.activeMode && this.enabled) return this.status(local)
    if (local) {
      await this.start()
      return this.status(local)
    }
    this.busy = true
    const ticket = this.generation
    setTimeout(() => {
      this.busy = false
      if (!this.disposed && ticket === this.generation) void this.start().catch(() => {})
    }, 75)
    return { switching: true, mode: this.preferences.mode }
  }

  async stopByCaller(local: boolean): Promise<{ stopped: true }> {
    if (local) await this.stop()
    else {
      ++this.generation
      setTimeout(() => {
        void this.stop()
      }, 75)
    }
    return { stopped: true }
  }

  async refresh(): Promise<void> {
    if (this.currentNode()?.identityChange && !this.enabled) throw new Error(IDENTITY_CHANGE_ERROR)
    if (!this.enabled) throw new Error('请先开启远程连接。')
    if (this.serviceNode?.status().connected && this.serviceQr && this.serviceQr.expiresAt > Date.now()) {
      await this.issueServiceQr()
      if (this.serviceQr && this.serviceQr.expiresAt > Date.now()) return
    }
    if (this.pairing.outstanding()) throw new Error('还有配对请求在等待确认，请先处理后再刷新二维码。')
    this.qr = this.pairing.issue()
  }

  approvePairing(input: Record<string, unknown>): void {
    const id = String(input.id)
    const pending = this.pairing.requests().find((request) => request.id === id)
    if (!pending) throw new Error('配对请求已失效，请重新扫码。')
    const reject = (reason: string): never => {
      this.pairing.reject(id)
      this.pairing.reportFailure(pending.name, reason)
      throw new Error(reason)
    }
    // The computer confirms the same device name and the same fingerprint the pairing page
    // showed; a mismatch cancels the request and leaves the reason on the panel.
    if (String(input.name ?? '') !== pending.name) reject('设备名与配对页不一致，本次配对已拒绝。')
    if (String(input.fingerprint ?? '') !== this.options.hostIdentity.fingerprint)
      reject('主机指纹与配对页不一致，本次配对已拒绝。')
    this.pairing.approve(id)
  }

  rejectPairing(id: string): void {
    this.pairing.reject(id)
  }

  scheduleRevoke(id: string): { revoked: true } {
    // Allow the management acknowledgement to reach the revoked caller.
    setTimeout(() => {
      try {
        this.pairing.revoke(id)
      } catch {
        this.error = '撤销失败，授权文件未能保存；请在本机重试。'
      }
    }, 75)
    return { revoked: true }
  }

  renameDevice(id: string, name: string): void {
    this.pairing.rename(id, name)
  }

  scheduleRevokeAll(): { revoked: true } {
    setTimeout(() => {
      try {
        this.pairing.revokeAll()
        this.qr = undefined
      } catch {
        this.error = '撤销失败，授权文件未能保存；请在本机重试。'
      }
    }, 75)
    return { revoked: true }
  }

  async updatePreferences(input: Record<string, unknown>, local: boolean): Promise<void> {
    const previous = this.preferences
    const previousDomain = this.access.domain
    if (this.busy && Object.keys(input).some((key) => key !== 'action')) throw new Error('请等待当前连接操作完成。')
    const next: Preferences = { ...this.preferences }
    if (typeof input.autoStart === 'boolean') next.autoStart = input.autoStart
    if (input.mode !== undefined) {
      if (input.mode !== 'public' && input.mode !== 'lan') throw new Error('连接模式不正确。')
      next.mode = input.mode
    }
    // The line preference decides what a phone tries first; it never touches a live gateway.
    if (input.line !== undefined) {
      if (input.line !== 'public' && input.line !== 'lan') throw new Error('线路偏好不正确。')
      next.line = input.line
    }
    if (input.proxyMode !== undefined) {
      if (!isProxyMode(input.proxyMode)) throw new Error('代理方式不正确。')
      next.proxyMode = input.proxyMode
    }
    if (input.publicUrl !== undefined) {
      if (!local) throw new Error('公网域名只能在本机面板修改。')
      const nextDomain = normalizePublicUrl(String(input.publicUrl))
      if (this.enabled && this.activeMode === 'public' && nextDomain !== this.access.domain)
        throw new Error('请先关闭远程连接，再修改公网域名。')
      await this.access.saveDomain(String(input.publicUrl))
      if (input.enablePublic === true) next.mode = nextDomain ? 'public' : 'lan'
    }
    if (input.proxy !== undefined) {
      const value = String(input.proxy).trim()
      if (value) {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error('代理需为不带用户名和密码的 HTTP(S) 地址。')
      }
      next.proxy = value || undefined
    }
    this.preferences = next
    try {
      savePreferencesFile(this.prefsFile, this.preferences)
    } catch (failure) {
      this.preferences = previous
      if (input.publicUrl !== undefined) {
        try {
          await this.access.saveDomain(previousDomain ?? '')
        } catch {
          throw new Error('偏好设置保存失败，且公网域名回滚失败，请检查配置文件。')
        }
      }
      throw failure
    }
    if (previous.proxy !== next.proxy || previous.proxyMode !== next.proxyMode) await this.access.resetOutbound()
    if (previous.mode !== next.mode) await this.reconcileServiceNode()
    if (input.publicUrl !== undefined) {
      this.migrateDevices()
      if (input.enablePublic === true && this.enabled && next.mode !== this.activeMode && !this.pairing.outstanding())
        await this.start()
    }
  }

  async checkPublicUrl(): Promise<void> {
    await this.access.checkDomain()
  }

  requestCertificate(): void {
    if (!this.access.domain) throw new Error('请先保存固定公网域名。')
    if (!this.enabled || this.activeMode !== 'public') throw new Error('请先开启“公网连接”，再申请证书。')
    if (this.gateway?.port !== PUBLIC_PORT) throw new Error('公网监听端口与固定域名转发目标不一致，请先修复端口配置。')
    void this.access.certificates.ensure(true).catch(() => undefined)
  }

  approveServicePairing(id: string): void {
    if (!this.serviceNode) throw new Error('当前没有连接自托管公网节点。')
    if (!id) throw new Error('缺少要处理的配对请求。')
    this.serviceNode.approvePairing(id)
  }

  rejectServicePairing(id: string): void {
    if (!this.serviceNode) throw new Error('当前没有连接自托管公网节点。')
    if (!id) throw new Error('缺少要处理的配对请求。')
    this.serviceNode.rejectPairing(id)
  }

  publicNodeDeps(): PublicNodeDeps {
    return {
      nodeStore: () => this.nodeStore(),
      reconcile: async () => {
        await this.reconcileServiceNode()
        if (this.enabled && this.activeMode === 'public' && this.preferences.mode === 'public' && this.serviceNode) {
          await this.ensureServiceQr()
        }
      },
      clearUnregisterNoticeIfOrigin: (origin) => {
        if (this.serviceUnregisterNotice?.origin === origin) this.serviceUnregisterNotice = undefined
      },
      onSelectGatewayDomain: async (url) => {
        await this.access.saveDomain(url)
      },
      onSwitchToServiceNode: async () => {
        const domain = this.access.domain
        if (
          domain &&
          this.nodeStore()
            .list()
            .some((item) => item.kind === 'gateway' && item.url === domain)
        ) {
          await this.access.saveDomain('')
        }
      },
      onRemoveGatewayNode: async (origin, wasCurrent) => {
        if (this.access.domain === origin) await this.access.saveDomain('')
        if (wasCurrent && this.enabled && this.activeMode === 'public') await this.stop()
      },
      onRemoveServiceNode: async (origin) => {
        this.serviceUnregisterNotice = undefined
        const live = this.serviceNode?.status().origin === origin ? this.serviceNode : undefined
        if (live) {
          this.serviceNode = undefined
          this.serviceQr = undefined
          this.clearRelay()
          await live.stop()
        }
        try {
          if (live) await live.unregister()
          else await unregisterServiceNode(this.options.storage, origin, { hostId: this.options.hostIdentity.hostId })
          this.logServiceNode('service-node-unregister', { origin, hostId: this.options.hostIdentity.hostId })
        } catch (failure) {
          const reason = failure instanceof Error && failure.message ? failure.message : '撤销节点注册失败。'
          this.serviceUnregisterNotice = {
            origin,
            message: `节点上的主机注册可能仍在（${reason}）重新添加前需要在该节点上重置。`,
          }
          this.logServiceNode('service-node-unregister-failed', {
            origin,
            hostId: this.options.hostIdentity.hostId,
            message: reason,
          })
        }
        // The local record is gone either way; the notice above explains a failed node cleanup.
        if (live) await live.forget(origin)
        else await forgetServiceNode(this.options.storage, origin)
      },
      onForgetNonServiceNode: async (origin) => {
        if (this.serviceNode) await this.serviceNode.forget(origin)
        else await forgetServiceNode(this.options.storage, origin)
      },
      onPruneDevicesForOrigin: (origin) => {
        let hosts: string[] = []
        try {
          const parsed = new URL(origin)
          hosts = [parsed.host.toLowerCase(), parsed.hostname.toLowerCase()]
        } catch {
          hosts = []
        }
        if (hosts.length) {
          this.pairing.prune((device) => !!device.host && hosts.includes(device.host.toLowerCase()))
        }
      },
      onRestartPublicGateway: async () => {
        await this.stop()
        await this.start()
      },
      isPublicActiveAndBusy: () => ({
        enabledPublic: this.enabled && this.preferences.mode === 'public',
        busy: this.busy,
      }),
    }
  }

  requestsStatus(local: boolean) {
    return {
      enabled: this.enabled,
      node: {
        name: this.options.discovery.name,
        fingerprint: this.options.hostIdentity.fingerprint,
        fingerprintGroups: fingerprintGroupsOf(this.options.hostIdentity.fingerprint),
      },
      requests: local ? this.pairing.requests() : [],
    }
  }

  async status(local: boolean): Promise<Record<string, unknown>> {
    const record = this.currentNode()
    // A node that started presenting another identity is unusable until the user confirms it: no
    // link, no QR and no tunnel, even when a previous session left one running.
    const identityBlocked = record !== undefined && record.identityChange !== null
    const tunnel = identityBlocked ? undefined : this.serviceNode?.status()
    const serviceTicket =
      !identityBlocked && record?.kind === 'service' && this.serviceQr && this.serviceQr.expiresAt > Date.now()
        ? this.serviceQr
        : undefined
    const publicBase =
      !identityBlocked && this.enabled && this.activeMode === 'public'
        ? record?.kind === 'service'
          ? record.url
          : this.access.domain
        : undefined
    const publicReachable =
      !!publicBase &&
      (record?.kind === 'service'
        ? !!serviceTicket && tunnel?.connected === true
        : this.access.lastCheck?.reachable === true)
    const entry = publicReachable ? 'public' : 'lan'
    const lanLinks = this.lanURLs().map((base) => ({
      base,
      url: this.qr ? `${base}/pair#pair=${this.qr.token}` : undefined,
    }))
    const publicUrl =
      publicReachable && publicBase
        ? record?.kind === 'service'
          ? serviceTicket?.url
          : this.qr
            ? `${publicBase}/pair#pair=${this.qr.token}`
            : undefined
        : undefined
    const links = publicBase && publicUrl ? [{ base: publicBase, url: publicUrl }] : lanLinks
    const active = new Set(this.gateway?.onlineIds() ?? [])
    const devices = this.pairing.list()
    const publicNodeList = this.publicNodes?.list() ?? []
    const notice =
      this.serviceUnregisterNotice && this.serviceUnregisterNotice.origin === record?.url
        ? this.serviceUnregisterNotice
        : undefined
    const serviceLastError = tunnel?.lastError ?? notice?.message
    const service =
      record?.kind === 'service'
        ? {
            origin: record.url,
            connected: tunnel?.connected ?? false,
            ...(serviceLastError ? { lastError: serviceLastError } : {}),
            pendingPairings: tunnel?.pendingPairings ?? [],
          }
        : record === undefined && this.serviceUnregisterNotice
          ? {
              origin: this.serviceUnregisterNotice.origin,
              connected: false,
              lastError: this.serviceUnregisterNotice.message,
              pendingPairings: [],
            }
          : null
    const phase = identityBlocked
      ? 'error'
      : this.enabled && this.activeMode === 'public' && record?.kind === 'service'
        ? tunnel?.connected
          ? 'ready'
          : 'connecting'
        : this.enabled
          ? 'ready'
          : this.error
            ? 'error'
            : 'off'
    const lastError = identityBlocked ? IDENTITY_CHANGE_ERROR : this.error
    return {
      enabled: this.enabled,
      busy: this.busy,
      mode: this.preferences.mode,
      line: this.preferences.line,
      entry,
      activeMode: this.activeMode,
      autoStart: this.preferences.autoStart,
      proxyConfigured: !!this.preferences.proxy,
      proxyMode: this.preferences.proxyMode,
      manualProxy: local ? this.preferences.proxy : undefined,
      systemProxy:
        this.preferences.proxyMode === 'system' && this.preferences.mode === 'public'
          ? await this.systemProxy()
          : undefined,
      publicUrl: this.access.domain,
      publicPort: PUBLIC_PORT,
      node: {
        name: this.options.discovery.name,
        kind: this.options.discovery.kind,
        protocol: this.options.discovery.protocol,
        fingerprint: this.options.hostIdentity.fingerprint,
        fingerprintGroups: fingerprintGroupsOf(this.options.hostIdentity.fingerprint),
      },
      pairingFailure: local ? this.pairing.failure() : undefined,
      repairRequired: devices.filter((device) => device.requiresRepair).length,
      publicUrlCheck: local ? this.access.lastCheck : undefined,
      certificate: local && this.access.domain ? await this.access.certificateStatus() : undefined,
      lanTls: this.options.config.lanTls
        ? { origin: this.lanTls?.origin, expiresAt: this.lanTls?.expiresAt, error: this.lanTlsError }
        : undefined,
      publicNodes: {
        current: this.publicNodes?.current ?? null,
        list: publicNodeList,
        pendingReview: publicNodeList.some((item) => item.pending),
      },
      serviceNode: service,
      phase,
      error: lastError,
      lastError,
      version: this.options.nodeVersion,
      gatewayPort: this.gateway?.port ?? 0,
      local,
      direct: this.directHost?.state() ?? [],
      expiresAt: entry === 'public' && record?.kind === 'service' ? serviceTicket?.expiresAt : this.qr?.expiresAt,
      links,
      qr: links[0]?.url ? await this.qrImage(links[0].url) : undefined,
      requests: local ? this.pairing.requests() : [],
      devices: devices.map(({ host, via: pairedVia, ...device }) => ({
        ...device,
        via:
          pairedVia ??
          (host && this.access.domain && host.toLowerCase() === new URL(this.access.domain).host.toLowerCase()
            ? 'public'
            : 'lan'),
        online: active.has(device.id),
        route: active.has(device.id) ? this.gateway?.route(device.id) : undefined,
      })),
      lanHint: this.options.config.lanTls
        ? '手机需在同一局域网，并将 HTTPS 域名解析到电脑的局域网地址。证书需由手机信任；插件不修改 DNS、防火墙或证书信任。'
        : '手机需与电脑处于同一局域网。若连接被防火墙阻断，请手动允许网关端口；插件不会修改防火墙。',
    }
  }
}
