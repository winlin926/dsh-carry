import type { ConnectionFace, RemoteRuntime, RemoteSnapshot } from '../remote-runtime.js'
import type { NodeKind, NodePublicIdentity } from '../remote/node-api.js'

const ROUTE = '/api/dsh-remote-connect/manage'
export type PublicNodeKind = NodeKind
/** One node identity: protocol 2 carries it, protocol 1 records only keep the flat host pair. */
export type PublicNodeIdentity = NodePublicIdentity
/** A protocol 2 node that came back with a different identity; nothing connects until the Host confirms it. */
export interface PublicNodeIdentityChange { from: { id: string; fingerprint: string }; to: { id: string; fingerprint: string }; detectedAt: number }
/** One Host entry the panel can add, probe, choose or remove. */
export interface PublicNode {
  id: string; url: string; kind: PublicNodeKind | null; name: string | null; version: string | null
  protocol: number | null; capabilities: string[] | null; node: PublicNodeIdentity | null; hostId: string | null; fingerprint: string | null
  addedAt: number; lastCheckAt: number | null; lastCheckOk: boolean; lastCheckError: string | null; pending: boolean
  identityChange: PublicNodeIdentityChange | null
}
export interface ServicePairing { requestId: string; deviceName: string; expiresAt: number }
export interface ServiceNodeState { origin: string; connected: boolean; lastError?: string; pendingPairings: ServicePairing[] }
export interface Status {
  enabled: boolean; busy: boolean; mode: 'public' | 'lan'; activeMode?: 'public' | 'lan'; line?: 'public' | 'lan'; entry?: 'public' | 'lan'; autoStart: boolean; proxyConfigured: boolean; proxyMode?: 'system' | 'manual' | 'off'; manualProxy?: string; systemProxy?: { url: string; source: string } | null
  publicUrl?: string | null; publicPort: number
  /** What the public pairing page shows and what the panel confirms: the same name and fingerprint. */
  node: { name: string; kind: 'gateway' | 'service'; protocol: number; fingerprint: string; fingerprintGroups: string }
  /** Why the last pairing attempt was rejected; the panel is the place that has to explain it. */
  pairingFailure?: { at: number; name: string; reason: string }
  /** Authorizations from a public entry recorded before the double-confirmation flow. */
  repairRequired: number
  publicUrlCheck?: { at: number; reachable: boolean; status: number | null; failure: 'unreachable' | 'identity' | 'tls' | null; error: string | null }
  certificate?: { domain?: string; expiresAt?: number; renewAt?: number; selfSigned: boolean; pending: boolean; restartRequired: boolean; error?: string }
  lanTls?: { origin?: string; expiresAt?: number; error?: string }
  phase: string; error?: string; gatewayPort: number; local: boolean; expiresAt?: number; qr?: string
  links: Array<{ base: string; url?: string }>; requests: Array<{ id: string; name: string; via: 'lan' | 'public'; nodeConfirmed: boolean; expiresAt: number }>
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; online: boolean; via?: Way; route?: RemoteSnapshot['route']; requiresRepair?: boolean }>; lanHint: string
  /** Public entries recorded on this Host; the panel adds, probes and chooses among them. */
  publicNodes?: { current: string | null; list: PublicNode[]; pendingReview: boolean }
  /** Present only while this Host is connected through a self-hosted public node. */
  serviceNode?: ServiceNodeState | null
  /** The running plugin version, shown before the plugin manager has answered. */
  version?: string
}
export interface ClientContext {
  effect(run: () => void | (() => void), label?: string): void
  /** Resolve a service by name regardless of the property inject gate. */
  get?(name: string): unknown
  connection?: unknown
  slots: { inject(name: string, setup: () => unknown): void; register(meta: Record<string, unknown>, render: (props: any) => unknown): unknown }
}
type TextPair = { zh: string; en: string }
export interface ClientLocale {
  resolveText(text: TextPair): string
  getSnapshot(): { revision: number }
  subscribe(listener: () => void): () => void
}
export const noSnapshot = () => undefined
export const noop = () => {}
export const noSubscribe = () => noop

export function clientText(locale: Pick<ClientLocale, 'resolveText'> | undefined, zh: string, en: string): string {
  if (locale) return locale.resolveText({ zh, en })
  const lang = globalThis.document?.documentElement?.lang || globalThis.navigator?.language || 'zh'
  return /^zh(?:-|$)/i.test(lang) ? zh : en
}
export function remoteRuntime(): RemoteRuntime | undefined {
  const page = globalThis.window as (Window & { __DSH_REMOTE_CONTROL__?: boolean; __DSH_RC_CONNECTION__?: RemoteRuntime }) | undefined
  if (page?.__DSH_REMOTE_CONTROL__ === true) return page.__DSH_RC_CONNECTION__
}

/** Copy a fixed set of fields with values that can safely be shared in a bug report. */
export function remoteDiagnostics(snapshot: RemoteSnapshot): string {
  const { version, entry, route, phase, reason, durationMs } = snapshot
  const safeVersion = typeof version === 'string' && version.length <= 32
    && /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|dev|next)(?:\.\d+)?)?$/.test(version) ? version : undefined
  return JSON.stringify({
    version: safeVersion,
    entry: entry === 'lan' || entry === 'public' ? entry : undefined,
    route: route === 'lan' || route === 'direct' || route === 'public' ? route : undefined,
    phase: phase === 'starting' || phase === 'reconnecting' || phase === 'connected' || phase === 'blocked' ? phase : undefined,
    reason: reason === 'network' || reason === 'host-unavailable' || reason === 'unpaired' || reason === 'lan-unavailable' || reason === 'identity-mismatch' ? reason : undefined,
    durationMs: typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : undefined,
  }, null, 2)
}

export const remoteAdvice: Record<NonNullable<RemoteSnapshot['reason']>, TextPair> = {
  network: { zh: '请检查手机的网络。网络恢复后，这页会继续尝试连接。', en: 'Check your phone’s network. Leave this page open while it reconnects.' },
  'host-unavailable': { zh: '请确认电脑已唤醒，DSH 和远程连接都已开启。', en: 'Make sure the computer is awake and DSH and Remote Control are running.' },
  unpaired: { zh: '设备授权已失效。请在电脑上打开远程控制，扫描新的二维码并确认。', en: 'This device’s authorization has expired or been revoked. Scan a new QR code and approve it on the computer.' },
  'lan-unavailable': { zh: '请确认手机和电脑在同一网络，且电脑上已开启远程连接。', en: 'Make sure your phone and computer are on the same network and Remote Control is running.' },
  'identity-mismatch': { zh: '请在电脑上核对连接入口和指纹，然后从电脑面板重新打开连接。', en: 'Check the entry address and fingerprint on the computer, then open the connection from its panel.' },
}

export function resolveClientLocale(ctx: ClientContext): ClientLocale | undefined {
  try {
    const locale = ctx.get?.('locale') as ClientLocale | undefined
    if (typeof locale?.resolveText === 'function' && typeof locale.getSnapshot === 'function' && typeof locale.subscribe === 'function') return locale
  } catch { /* Older Hosts can use the document or browser locale. */ }
}

export function isConnectionFace(value: unknown): value is ConnectionFace {
  const connection = value as Partial<ConnectionFace> | undefined
  return typeof connection?.reconnect === 'function'
    && typeof connection.state?.getSnapshot === 'function' && typeof connection.state.subscribe === 'function'
    && typeof connection.generation?.getSnapshot === 'function' && typeof connection.generation.subscribe === 'function'
}

/** A panel request must never leave the poll or a button waiting forever on a dead network. */
function deadline(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}
/** An insecure origin (a phone on http://LAN-IP) exposes no clipboard API; the legacy command is the only way to copy there. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return true } catch { /* the legacy command below is the fallback */ } }
  const area = document.createElement('textarea')
  area.value = text
  // inputmode=none keeps the soft keyboard closed while the selection satisfies execCommand.
  area.setAttribute('inputmode', 'none'); area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0'
  document.body.append(area)
  area.focus(); area.setSelectionRange(0, text.length)
  try { return document.execCommand('copy') } catch { return false } finally { area.remove() }
}
export async function command(input: Record<string, unknown>): Promise<Status> {
  const transport = (globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }).__DSH_TRANSPORT__?.fetch ?? fetch
  let response: Response
  try {
    response = await transport(ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: deadline(30_000) })
  } catch (failure) {
    const name = (failure as { name?: string } | null)?.name
    throw new Error(name === 'AbortError' || name === 'TimeoutError' ? '和电脑的连接超时，请检查网络后重试。' : failure instanceof Error ? failure.message : '连接失败。')
  }
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `连接失败（HTTP ${response.status}）`)
  // Node add/probe failures arrive as HTTP 200 with { ok: false, message }; they are errors to the
  // panel, so act() shows the same Chinese reason a thrown manage action would.
  if (data.ok === false && typeof data.message === 'string') throw new Error(data.message)
  return data as Status
}
export type Way = 'public' | 'lan'
export const WAYS: Array<{ mode: Way; name: string; text: string }> = [
  { mode: 'lan', name: '同一 Wi‑Fi', text: '同一网络直连，无需公网配置。' },
  { mode: 'public', name: '公网连接', text: '异地或移动网络，需固定域名。' },
]
export function routeName(route: RemoteSnapshot['route'], locale?: ClientLocale): string | undefined {
  if (route === 'lan') return clientText(locale, '局域网', 'Local network')
  if (route === 'direct') return clientText(locale, 'WebRTC 直连', 'Direct (WebRTC)')
  if (route === 'public') return clientText(locale, '公网转发', 'Public relay')
}
export const when = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const address = (value: string) => {
  try { const url = new URL(value); return url.origin + (url.pathname === '/' ? '' : url.pathname) }
  catch { return value }
}
export type PublicNodeAddress = { ok: true; url: string } | { ok: false; error: string }
/** Mirrors the Host's rule so a malformed draft never reaches the manage API. */
export function parsePublicNodeAddress(value: string): PublicNodeAddress {
  const text = value.trim()
  if (!text) return { ok: false, error: '公网节点地址不能为空。' }
  let url: URL
  try { url = new URL(text) } catch { return { ok: false, error: '公网节点地址格式无效，请填写完整的 https:// 地址。' } }
  if (url.protocol !== 'https:') return { ok: false, error: '公网节点必须使用 https:// 地址。' }
  if (url.username || url.password) return { ok: false, error: '公网节点地址不能包含账号或密码。' }
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, error: '公网节点地址只能是域名，不能带路径、查询参数或锚点。' }
  return { ok: true, url: url.origin }
}
/** Host[:port] is the shortest unique label for buttons and confirmations. */
export function nodeHost(url: string): string {
  try { return new URL(url).host } catch { return url }
}
export function nodeKindLabel(kind: PublicNodeKind | null): string {
  return kind === 'gateway' ? '隧道网关' : kind === 'service' ? '自托管服务' : '待确认'
}
/** The Host shows fingerprints as eight upper-case groups of four digits. */
export function nodeFingerprintGroups(fingerprint: string | null): string {
  if (!fingerprint) return '尚未上报'
  const digits = fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (digits.length !== 32) return fingerprint.toUpperCase()
  return digits.match(/.{4}/g)!.join('-')
}
export type NodeTone = 'ok' | 'warn' | 'danger' | 'neutral'
/** Protocol 2 names the node identity; protocol 1 only knows the flat host pair. */
export function publicNodeFingerprint(node: Pick<PublicNode, 'node' | 'fingerprint'>): string | null {
  return node.node?.fingerprint ?? node.fingerprint
}
/** The protocol tag tells a v2 node apart from a v1 single-host gateway without opening the row. */
export function publicNodeProtocolLabel(protocol: number | null): string {
  return protocol === 2 ? 'v2' : protocol === 1 ? '旧版 v1（单主机）' : '协议待确认'
}
export function nodeCheckStatus(node: Pick<PublicNode, 'pending' | 'lastCheckAt' | 'lastCheckOk'>): { label: string; tone: NodeTone } {
  if (node.pending) return { label: '待检测确认', tone: 'warn' }
  if (node.lastCheckAt === null) return { label: '尚未检测', tone: 'neutral' }
  return node.lastCheckOk ? { label: '检测正常', tone: 'ok' } : { label: '检测失败', tone: 'danger' }
}
/** Relative wording keeps the list scannable; old probes fall back to the panel's absolute form. */
export function checkedAtLabel(at: number | null, now = Date.now()): string {
  if (at === null) return '尚未检测'
  const elapsed = Math.max(0, now - at)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  return when(at)
}
/** The current entry first, then entries awaiting confirmation, then the most recently probed. */
export function sortPublicNodes(nodes: readonly PublicNode[], current: string | null): PublicNode[] {
  const rank = (node: PublicNode) => node.id === current ? 0 : node.pending ? 1 : 2
  return [...nodes].sort((left, right) => rank(left) - rank(right)
    || (right.lastCheckAt ?? 0) - (left.lastCheckAt ?? 0)
    || right.addedAt - left.addedAt
    || left.url.localeCompare(right.url))
}
export function serviceStateLabel(service: Pick<ServiceNodeState, 'connected' | 'lastError'>): { label: string; tone: NodeTone; reason: string } {
  if (service.connected) return { label: '已连接', tone: 'ok', reason: '' }
  if (service.lastError) return { label: '未连接', tone: 'danger', reason: service.lastError }
  return { label: '正在连接…', tone: 'warn', reason: '' }
}
