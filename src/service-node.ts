/**
 * The Host side of a self-hosted public node's reverse tunnel.
 *
 * The Host never listens on the public internet: it registers its host identity with the node,
 * keeps an outbound WebSocket open to `<node>/v1/tunnel`, and forwards every frame the node asks
 * for to its own loopback WebServer. The node therefore reaches this DSH exactly as a LAN phone
 * would, while the Host's firewall stays closed.
 *
 * Everything in this file is driven by the shared frame protocol in `remote/tunnel-protocol.ts`;
 * the node's implementation of the other end is documented by that same file.
 */
import { join } from 'node:path'
import type { RawData, WebSocket as TunnelSocket } from 'ws'
import {
  TUNNEL_BACKPRESSURE_LOW_WATER,
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_TIMEOUT_MS,
  TUNNEL_PATH,
  TunnelFrameError,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type TunnelFrame,
  type TunnelRelayDevice,
} from './remote/tunnel-protocol.js'
import {
  SERVICE_NODES_FILE,
  ServiceNodeError,
  type ServiceNodeIdentity,
  type StoredNode,
  deleteHostRegistration,
  forgetServiceNode,
  issueNodePairingTicket,
  readNodes,
  registerHostOnNode,
  unregisterServiceNode,
  writeNodes,
} from './service-node/credentials.js'
import { bytesOf, resolveForwardTarget, type ServiceTunnelIo } from './service-node/forward-shared.js'
import { ServiceHttpForwarder } from './service-node/http-forwarder.js'
import { ServiceWsForwarder, closeReason } from './service-node/ws-forwarder.js'

export { SERVICE_NODES_FILE, forgetServiceNode, unregisterServiceNode, type ServiceNodeIdentity }

const HANDSHAKE_TIMEOUT_MS = 15_000
const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 60_000

export interface ServiceNodeLogger {
  (event: string, fields: Record<string, unknown>): void
}

export interface ServiceNodeReconnect {
  /** First retry delay; every failed attempt doubles it. */
  baseDelayMs?: number
  /** Retry ceiling. */
  maxDelayMs?: number
  /** A value in [0, 1] choosing where in the 0–20% jitter band this delay lands. */
  jitter?: () => number
}

export interface ServiceNodeOptions {
  /** Normalized node origin, e.g. `https://node.example.com`. */
  origin: string
  /** This Host's identity (43-character base64url) as advertised by discovery. */
  hostId: string
  /** SPKI DER public key, base64url, as handed to the node at registration. */
  identityKey: string
  /** Version shown to the node, from package.json. */
  clientVersion: string
  /** The Host WebServer's loopback port. */
  upstreamPort: number
  /** The Host session cookie used to speak to its own loopback WebServer. */
  upstreamCookie: () => string
  /** Plugin storage directory; the credential file lives directly inside it. */
  storage: string
  /** Structured diagnostics; never receives credentials, cookies, paths or bodies. */
  log?: ServiceNodeLogger
  /** Called after every successful tunnel handshake (initial connect and reconnects). */
  onConnected?: () => void
  /** Only upgraded relay nodes send device identity on a frame. */
  relayTarget?: (device: TunnelRelayDevice) => { port: number; mark: string } | undefined
  relayPairComplete?: (clientId: string) => void
  relayPairRevoked?: (clientId: string) => void
  now?: () => number
  reconnect?: ServiceNodeReconnect
}

/** One device waiting for this computer's answer in the panel. */
export interface ServicePairing {
  requestId: string
  deviceName: string
  expiresAt: number
}

export interface ServiceNodeStatus {
  origin: string
  connected: boolean
  lastError?: string
  pendingPairings: ServicePairing[]
}

function tunnelEndpoint(origin: string): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = TUNNEL_PATH
  url.search = ''
  url.hash = ''
  return url.toString()
}

export class ServiceNode {
  private readonly origin: string
  private readonly hostId: string
  private readonly identityKey: string
  private readonly clientVersion: string
  private readonly upstreamPort: number
  private readonly upstreamCookie: () => string
  private readonly storage: string
  private readonly file: string
  private readonly log: ServiceNodeLogger
  private readonly onConnected: (() => void) | undefined
  private readonly now: () => number
  private readonly reconnectBase: number
  private readonly reconnectMax: number
  private readonly jitter: () => number
  private readonly http: ServiceHttpForwarder
  private readonly ws: ServiceWsForwarder

  /** Saved per-origin credentials; loaded before the first attempt. */
  private nodes: Record<string, StoredNode> = {}
  /** A serialized writer so two saves can never race on the credential file. */
  private writing: Promise<void> = Promise.resolve()
  private active = false
  private connected = false
  private lastError: string | undefined
  private wsModule?: typeof import('ws')
  private socket?: TunnelSocket
  private attempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private heartbeatWatchdog?: ReturnType<typeof setInterval>
  private lastFrameAt = 0
  private drainTimer?: ReturnType<typeof setTimeout>
  private readonly pairings = new Map<string, { deviceName: string; expiresAt: number }>()

  constructor(private readonly options: ServiceNodeOptions) {
    this.origin = options.origin
    this.hostId = options.hostId
    this.identityKey = options.identityKey
    this.clientVersion = options.clientVersion
    this.upstreamPort = options.upstreamPort
    this.upstreamCookie = options.upstreamCookie
    this.storage = options.storage
    this.file = join(options.storage, SERVICE_NODES_FILE)
    this.log = options.log ?? (() => {})
    this.onConnected = options.onConnected
    this.now = options.now ?? Date.now
    this.reconnectBase = options.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_MS
    this.reconnectMax = options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS
    this.jitter = options.reconnect?.jitter ?? Math.random

    const io: ServiceTunnelIo = {
      send: (frame, payload) => this.send(frame, payload),
      resolveTarget: (headers, device) =>
        resolveForwardTarget(
          {
            upstreamPort: this.upstreamPort,
            upstreamCookie: this.upstreamCookie,
            relayTarget: this.options.relayTarget,
          },
          headers,
          device,
        ),
      outboundBuffered: () => this.socket?.bufferedAmount ?? 0,
      armDrain: () => this.armDrain(),
    }
    this.http = new ServiceHttpForwarder(io)
    this.ws = new ServiceWsForwarder(io, () => this.loadWs())
  }

  /** Load saved credentials, then open the tunnel; a first failure only schedules a retry. */
  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.lastError = undefined
    try {
      this.nodes = await readNodes(this.file)
    } catch (failure) {
      this.lastError = failure instanceof Error ? failure.message : '服务节点凭据读取失败。'
      this.nodes = {}
    }
    try {
      await this.connect()
    } catch (failure) {
      if (!this.active) return
      this.lastError = this.describe(failure)
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: this.lastError })
      this.scheduleReconnect()
    }
  }

  /** Close the tunnel and every timer; no automatic reconnect happens afterwards. */
  async stop(): Promise<void> {
    this.active = false
    this.connected = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
    }
    this.stopHeartbeat()
    const socket = this.socket
    this.socket = undefined
    if (socket) {
      try {
        socket.terminate()
      } catch {
        /* already gone */
      }
    }
    this.failAll()
    this.pairings.clear()
  }

  status(): ServiceNodeStatus {
    this.prunePairings()
    return {
      origin: this.origin,
      connected: this.connected,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      pendingPairings: [...this.pairings].map(([requestId, pairing]) => ({
        requestId,
        deviceName: pairing.deviceName,
        expiresAt: pairing.expiresAt,
      })),
    }
  }

  /** Answer the node's pairing request; a request that already expired is silently ignored. */
  approvePairing(requestId: string): void {
    if (!this.takePairing(requestId)) return
    this.send({ t: 'pair.approve', requestId })
  }

  rejectPairing(requestId: string): void {
    if (!this.takePairing(requestId)) return
    this.send({ t: 'pair.reject', requestId })
  }

  /**
   * Ask the node for a single-use pairing ticket and build the page URL the panel shows as a QR.
   * The node's pairing page reads `v`, `ticket` and this Host's identity key from the URL hash, so the
   * phone can verify the fingerprint it is about to pair with.
   */
  async issueTicket(): Promise<{ url: string; expiresAt: number }> {
    try {
      const credential = await this.ensureCredential()
      const ticket = await issueNodePairingTicket({
        origin: this.origin,
        credential,
        identityKey: this.identityKey,
        onUnauthorized: () => {
          void this.forgetCredential(credential)
        },
      })
      this.lastError = undefined
      return ticket
    } catch (failure) {
      this.lastError = failure instanceof Error && failure.message ? failure.message : '签发配对票据失败。'
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: this.lastError })
      throw failure instanceof ServiceNodeError ? failure : new ServiceNodeError(this.lastError)
    }
  }

  /** Forget one origin's credential (atomic rewrite); a missing entry is a no-op. */
  async forget(origin: string): Promise<void> {
    if (origin in this.nodes) {
      delete this.nodes[origin]
      await this.persist()
      return
    }
    await forgetServiceNode(this.storage, origin)
  }

  /**
   * Delete this Host's registration on the node, so a later re-add can register again instead of
   * being rejected with `HOST_ALREADY_REGISTERED`. The caller still owns forgetting the credential.
   */
  async unregister(): Promise<void> {
    const stored = this.nodes[this.origin]
    if (!stored || stored.hostId !== this.hostId) return
    await deleteHostRegistration(this.origin, stored.hostId, stored.credential)
  }

  private takePairing(requestId: string): boolean {
    this.prunePairings()
    return this.pairings.delete(requestId)
  }

  private prunePairings(): void {
    const now = this.now()
    for (const [id, pairing] of this.pairings) if (now >= pairing.expiresAt) this.pairings.delete(id)
  }

  private describe(failure: unknown): string {
    if (failure instanceof ServiceNodeError) return failure.message
    const code = (failure as NodeJS.ErrnoException).code
    if (code) return `无法连接服务节点（${code}）。`
    if (failure instanceof Error && failure.message) return failure.message
    return '无法连接服务节点。'
  }

  private async loadWs(): Promise<typeof import('ws')> {
    this.wsModule ??= await import('ws')
    return this.wsModule
  }

  private async connect(): Promise<void> {
    const credential = await this.ensureCredential()
    if (!this.active) throw new ServiceNodeError('隧道已停止。')
    const ws = await this.loadWs()
    const socket = new ws.WebSocket(tunnelEndpoint(this.origin), {
      headers: { authorization: `Bearer ${credential}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: 32 * 1024 * 1024,
    })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let handshake: Error | undefined
      const settle = (failure?: Error): void => {
        if (settled) return
        settled = true
        if (failure) reject(failure)
        else resolve()
      }
      socket.on('open', () => {
        this.connected = true
        this.attempts = 0
        this.lastError = undefined
        this.lastFrameAt = this.now()
        this.startHeartbeat()
        this.send({
          t: 'hello',
          hostId: this.hostId,
          version: this.clientVersion,
          capabilities: this.options.relayTarget ? ['http', 'ws', 'assets', 'direct'] : ['http', 'ws', 'assets'],
        })
        this.log('service-node-connect', { origin: this.origin, hostId: this.hostId })
        void this.touchConnectedAt()
        try {
          this.onConnected?.()
        } catch (failure) {
          this.log('service-node-error', {
            origin: this.origin,
            hostId: this.hostId,
            message: failure instanceof Error ? failure.message : '服务节点连接回调失败。',
          })
        }
        settle()
      })
      socket.on('message', (data: RawData, isBinary: boolean) => this.receive(socket, data, isBinary))
      socket.on('error', (failure: Error) => {
        // Errors before the handshake decide why the attempt failed; later ones are reported by close.
        if (!settled) handshake ??= failure
      })
      socket.on('unexpected-response', (request, response) => {
        const status = response.statusCode ?? 0
        response.resume()
        request.destroy()
        const authFailure = status === 401 || status === 403 || status === 404
        if (authFailure) void this.forgetCredential(credential)
        const message = authFailure
          ? `节点拒绝了本机凭据（HTTP ${status}），将重新注册。`
          : `节点拒绝了隧道连接（HTTP ${status}）。`
        handshake = new ServiceNodeError(message)
        socket.terminate()
      })
      socket.on('close', (code: number, reason: Buffer) => {
        const wasConnected = this.connected
        this.connected = false
        this.stopHeartbeat()
        if (this.socket === socket) this.socket = undefined
        this.failAll()
        const text = closeReason(reason)
        const message = handshake?.message ?? (text ? `与节点的连接已断开：${text}` : `与节点的连接已断开（${code}）。`)
        if (wasConnected)
          this.log('service-node-disconnect', { origin: this.origin, hostId: this.hostId, code, message })
        if (!settled) {
          settled = true
          reject(handshake ?? new ServiceNodeError(message))
          return
        }
        if (this.active) this.scheduleReconnect()
      })
    })
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer) return
    const raw = Math.min(this.reconnectMax, this.reconnectBase * 2 ** Math.min(this.attempts, 30))
    const factor = 1 + Math.min(0.2, Math.max(0, this.jitter()))
    this.attempts += 1
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined
        if (!this.active) return
        void this.connect().catch((failure) => {
          if (!this.active) return
          this.lastError = this.describe(failure)
          this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: this.lastError })
          this.scheduleReconnect()
        })
      },
      Math.max(0, Math.round(raw * factor)),
    )
    this.reconnectTimer.unref?.()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ t: 'ping', at: this.now() })
    }, TUNNEL_HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
    this.heartbeatWatchdog = setInterval(() => {
      if (!this.socket) return
      if (this.now() - this.lastFrameAt < TUNNEL_HEARTBEAT_TIMEOUT_MS) return
      this.lastError = '长时间没有收到节点的数据，正在重新连接。'
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: this.lastError })
      try {
        this.socket?.terminate()
      } catch {
        /* close handler reconnects */
      }
    }, TUNNEL_HEARTBEAT_INTERVAL_MS)
    this.heartbeatWatchdog.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.heartbeatWatchdog) {
      clearInterval(this.heartbeatWatchdog)
      this.heartbeatWatchdog = undefined
    }
  }

  private async ensureCredential(): Promise<string> {
    const stored = this.nodes[this.origin]
    // A credential belongs to the identity that registered it; a changed host identity must register again.
    if (stored && stored.hostId === this.hostId) return stored.credential
    const credential = await registerHostOnNode({
      origin: this.origin,
      hostId: this.hostId,
      identityKey: this.identityKey,
      clientVersion: this.clientVersion,
    })
    this.nodes[this.origin] = { credential, hostId: this.hostId, registeredAt: this.now(), lastConnectedAt: null }
    await this.persist()
    this.log('service-node-register', { origin: this.origin, hostId: this.hostId })
    return credential
  }

  private async forgetCredential(credential: string): Promise<void> {
    const stored = this.nodes[this.origin]
    if (!stored || stored.credential !== credential) return
    delete this.nodes[this.origin]
    try {
      await this.persist()
    } catch {
      /* the next registration overwrites the file anyway */
    }
  }

  private async touchConnectedAt(): Promise<void> {
    const stored = this.nodes[this.origin]
    if (!stored) return
    this.nodes[this.origin] = { ...stored, lastConnectedAt: this.now() }
    try {
      await this.persist()
    } catch {
      /* bookkeeping only */
    }
  }

  private persist(): Promise<void> {
    const snapshot: Record<string, StoredNode> = JSON.parse(JSON.stringify(this.nodes)) as Record<string, StoredNode>
    // A failed attempt must not poison the queue: the next save still runs (and reports its own failure).
    this.writing = this.writing.then(
      () => writeNodes(this.file, snapshot),
      () => writeNodes(this.file, snapshot),
    )
    return this.writing
  }

  private send(frame: TunnelFrame, payload?: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== socket.OPEN) return
    let data: Buffer
    try {
      data = encodeTunnelFrame(frame, payload)
    } catch (failure) {
      // An oversized frame is a programming error: log the reason, never the payload.
      this.log('service-node-error', {
        origin: this.origin,
        hostId: this.hostId,
        message: failure instanceof Error ? failure.message : '发送隧道帧失败。',
      })
      return
    }
    socket.send(data, { binary: true }, (failure) => {
      if (!failure) return
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: '向节点发送数据失败。' })
    })
  }

  private receive(socket: TunnelSocket, data: RawData, isBinary: boolean): void {
    if (socket !== this.socket) return
    this.lastFrameAt = this.now()
    try {
      if (!isBinary) throw new TunnelFrameError('FRAME_INVALID', '节点发送了非二进制帧。')
      const { frame, payload } = decodeTunnelFrame(bytesOf(data))
      this.handle(frame, payload)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '无法解析节点的数据。'
      this.lastError = '与节点的通信格式不正确，正在重新连接。'
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message })
      try {
        socket.terminate()
      } catch {
        /* the close handler reconnects */
      }
    }
  }

  private handle(frame: TunnelFrame, payload: Uint8Array): void {
    switch (frame.t) {
      case 'ping':
        this.send({ t: 'pong', at: frame.at })
        break
      case 'pong':
        break
      case 'http.request':
        this.http.open(frame.id, frame.method, frame.path, frame.headers, frame.relayDevice)
        break
      case 'http.body':
        this.http.write(frame.id, payload)
        break
      case 'http.body.end':
        this.http.end(frame.id)
        break
      case 'http.cancel':
        this.http.cancel(frame.id)
        break
      case 'ws.open':
        void this.ws.open(frame.id, frame.path, frame.headers, frame.protocol, frame.relayDevice)
        break
      case 'ws.frame':
        this.ws.deliver(frame.id, frame.binary, frame.fin, payload)
        break
      case 'ws.close':
        this.ws.close(frame.id, frame.code, frame.reason)
        break
      case 'pair.request':
        this.addPairing(frame.requestId, frame.clientName, frame.expiresAt)
        break
      case 'pair.revoked':
        this.options.relayPairRevoked?.(frame.clientDeviceId)
        break
      case 'pair.complete':
        this.options.relayPairComplete?.(frame.clientDeviceId)
        this.pairings.delete(frame.requestId)
        break
      case 'pair.reject':
        this.pairings.delete(frame.requestId)
        break
      // Node-bound frame types never travel to the Host; a peer sending one is simply ignored.
      default:
        break
    }
  }

  private armDrain(): void {
    if (this.drainTimer) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined
      const socket = this.socket
      if (!socket) return
      if (socket.bufferedAmount >= TUNNEL_BACKPRESSURE_LOW_WATER) {
        this.armDrain()
        return
      }
      this.http.resume()
      this.ws.resume()
    }, 25)
    this.drainTimer.unref?.()
  }

  private addPairing(requestId: string, clientName: string, expiresAt: number): void {
    this.prunePairings()
    const expires = Number.isFinite(expiresAt) && expiresAt > this.now() ? expiresAt : this.now() + 5 * 60_000
    this.pairings.set(requestId, { deviceName: clientName.slice(0, 80), expiresAt: expires })
  }

  private failAll(): void {
    this.http.failAll()
    this.ws.failAll()
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
    }
  }
}
