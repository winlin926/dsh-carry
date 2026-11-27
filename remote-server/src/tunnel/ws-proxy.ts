import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
import {
  TUNNEL_IDLE_TIMEOUT_MS,
  TUNNEL_WS_MESSAGE_MAX,
  assembleTunnelWsFrame,
  splitTunnelWsPayload,
  toTunnelHeaders,
  type TunnelWsAckFrame,
  type TunnelWsCloseFrame,
  type TunnelWsFrameFrame,
  type TunnelWsMessageAssembly,
  type TunnelWsOpenFrame,
} from '../../../src/remote/tunnel-protocol.js'
import type { AuthService } from '../auth.js'
import type { Config } from '../config.js'
import { ApiError, errorBody } from '../errors.js'
import type { Logger } from '../logger.js'
import type { RateLimiter } from '../rate-limit.js'
import { clientIp, originAllowed } from '../security.js'
import type { TunnelHub } from './hub.js'
import { isNodeOwnedPath } from './paths.js'
import { HOST_OFFLINE_MESSAGE, SESSION_REQUIRED_MESSAGE, type TunnelCapacity } from './shared.js'

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export interface WsProxyDeps {
  config: Config
  logger: Logger
  auth: AuthService
  limiter: RateLimiter
  hub: TunnelHub
  capacity: TunnelCapacity
}

interface WsExchange {
  id: string
  hostId: string
  deviceId: string
  req: IncomingMessage
  socket: Duplex
  head: Buffer
  client: WebSocket | null
  done: boolean
  timer: NodeJS.Timeout | null
  pendingMessage?: TunnelWsMessageAssembly
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/** A close code we are allowed to put on the wire. */
function sendableCloseCode(code: number | undefined, fallback: number): number {
  if (code === undefined) return fallback
  if (code >= 3000 && code <= 4999) return code
  if (code >= 1000 && code <= 1014 && code !== 1005 && code !== 1006) return code
  return fallback
}

function readProtocols(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw.join(',') : (raw ?? '')
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function closeEndpoint(client: WebSocket | null, socket: Duplex, code: number, reason?: string): void {
  if (client) {
    try {
      client.close(code, reason)
    } catch {
      client.terminate()
    }
    return
  }
  try {
    socket.destroy()
  } catch {
    // The socket is already gone.
  }
}

/** Proxies paired-device WebSocket upgrades and binary/text frames over the Host reverse tunnel. */
export class WsTunnelProxy {
  private readonly wss: WebSocketServer
  private readonly preferredProtocols = new WeakMap<IncomingMessage, string>()
  private readonly exchanges = new Map<string, WsExchange>()

  constructor(private readonly deps: WsProxyDeps) {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: TUNNEL_WS_MESSAGE_MAX,
      handleProtocols: (protocols, request) => {
        const preferred = this.preferredProtocols.get(request)
        this.preferredProtocols.delete(request)
        if (preferred !== undefined && protocols.has(preferred)) return preferred
        const first = [...protocols][0]
        return first ?? false
      },
    })
  }

  closeDevice(deviceId: string): void {
    for (const exchange of this.exchanges.values()) {
      if (exchange.deviceId !== deviceId || !exchange.client) continue
      exchange.client.close(4004, 'relationship revoked')
    }
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (isNodeOwnedPath(url.pathname)) {
        this.rejectSocket(socket, 404, errorBody('NOT_FOUND', 'The requested resource does not exist.'))
        return
      }
      if (req.method !== 'GET') {
        this.rejectSocket(socket, 405, errorBody('METHOD_NOT_ALLOWED', 'Method not allowed.'))
        return
      }
      if (!originAllowed(req, this.deps.config)) {
        this.rejectSocket(socket, 403, errorBody('CROSS_ORIGIN_REJECTED', 'Cross-origin upgrades are not allowed.'))
        return
      }
      const session = this.deps.auth.sessionFromRequest(req)
      if (!session) {
        this.rejectSocket(socket, 401, errorBody('AUTH_REQUIRED', SESSION_REQUIRED_MESSAGE))
        return
      }
      const decision = this.deps.limiter.take(
        'upgrade',
        clientIp(req, this.deps.config),
        this.deps.config.limits.upgrade,
      )
      if (!decision.allowed) {
        this.rejectSocket(socket, 429, errorBody('RATE_LIMITED', 'Too many upgrade attempts; retry later.', true))
        return
      }
      const deviceId = session.device.device_id
      const hostId = this.deps.capacity.selectHost(session)
      this.deps.capacity.assertCapacity(deviceId, hostId)

      const id = randomUUID()
      const exchange: WsExchange = {
        id,
        hostId,
        deviceId,
        req,
        socket,
        head,
        client: null,
        done: false,
        timer: null,
      }
      this.exchanges.set(id, exchange)
      this.deps.capacity.acquire(deviceId, hostId)
      exchange.timer = setTimeout(() => this.onTimeout(exchange), TUNNEL_IDLE_TIMEOUT_MS)
      exchange.timer.unref()

      const protocols = readProtocols(req.headers['sec-websocket-protocol'])
      const frame: TunnelWsOpenFrame = {
        t: 'ws.open',
        id,
        path: req.url ?? url.pathname,
        headers: toTunnelHeaders(req.headers),
        ...(this.deps.hub.supportsDirect(hostId) ? { relayDevice: { id: deviceId, name: session.device.name } } : {}),
      }
      const protocol = protocols[0]
      if (protocol !== undefined) frame.protocol = protocol
      if (!this.deps.hub.sendHostFrame(hostId, frame)) {
        this.settle(exchange)
        this.rejectSocket(socket, 503, errorBody('HOST_OFFLINE', HOST_OFFLINE_MESSAGE))
      }
    } catch (error) {
      if (error instanceof ApiError) {
        this.rejectSocket(
          socket,
          error.status,
          errorBody(error.code, error.message, error.retryAfterMs !== undefined ? true : undefined),
        )
      } else {
        this.deps.logger.warn({ event: 'tunnel.ws.upgrade.failed', error })
        try {
          socket.destroy()
        } catch {
          // The socket is already gone.
        }
      }
    }
  }

  onAck(hostId: string, frame: TunnelWsAckFrame): void {
    const exchange = this.exchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) {
      this.deps.logger.debug({ event: 'tunnel.frame.unknown', hostId, type: 'ws.ack', id: frame.id })
      return
    }
    if (exchange.done) return
    this.touch(exchange)
    if (!frame.ok) {
      const status =
        typeof frame.status === 'number' && Number.isInteger(frame.status) && frame.status >= 400 && frame.status <= 599
          ? frame.status
          : 502
      this.settle(exchange)
      this.rejectSocket(exchange.socket, status, errorBody('TUNNEL_UPGRADE_FAILED', '上游 WebSocket 拒绝连接。'))
      return
    }
    if (typeof frame.protocol === 'string' && frame.protocol.length > 0) {
      this.preferredProtocols.set(exchange.req, frame.protocol)
    }
    try {
      this.wss.handleUpgrade(exchange.req, exchange.socket, exchange.head, (client) => {
        this.onClientOpen(exchange, client)
      })
    } catch (error) {
      this.deps.logger.warn({ event: 'tunnel.ws.accept.failed', hostId, id: exchange.id, error })
      this.settle(exchange)
      try {
        exchange.socket.destroy()
      } catch {
        // The socket is already gone.
      }
    }
  }

  onHostFrame(hostId: string, frame: TunnelWsFrameFrame, payload: Uint8Array): void {
    const exchange = this.exchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) {
      this.deps.logger.debug({ event: 'tunnel.frame.unknown', hostId, type: 'ws.frame', id: frame.id })
      return
    }
    const client = exchange.client
    if (!client || exchange.done) return
    this.touch(exchange)
    const assembled = assembleTunnelWsFrame(exchange.pendingMessage, frame, payload)
    if (assembled.status === 'error') {
      this.deps.hub.sendHostFrame(exchange.hostId, {
        t: 'ws.close',
        id: exchange.id,
        code: assembled.code,
        reason: assembled.reason,
      })
      this.settle(exchange)
      closeEndpoint(client, exchange.socket, assembled.code, assembled.reason)
      return
    }
    exchange.pendingMessage = assembled.pending
    if (assembled.status !== 'message') return
    try {
      client.send(Buffer.from(assembled.data), { binary: assembled.binary })
    } catch (error) {
      this.deps.logger.warn({ event: 'tunnel.ws.send.failed', hostId, id: exchange.id, error })
      this.settle(exchange)
      try {
        client.terminate()
      } catch {
        // The client socket is already gone.
      }
    }
  }

  onHostClose(hostId: string, frame: TunnelWsCloseFrame): void {
    const exchange = this.exchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId || exchange.done) return
    const client = exchange.client
    this.settle(exchange)
    closeEndpoint(client, exchange.socket, sendableCloseCode(frame.code, 1000), frame.reason?.slice(0, 120))
  }

  failHost(hostId: string): void {
    for (const exchange of [...this.exchanges.values()]) {
      if (exchange.hostId !== hostId) continue
      const client = exchange.client
      this.settle(exchange)
      closeEndpoint(client, exchange.socket, 1011, 'tunnel closed')
    }
  }

  shutdown(): void {
    for (const exchange of [...this.exchanges.values()]) {
      const client = exchange.client
      this.settle(exchange)
      closeEndpoint(client, exchange.socket, 1001, 'server shutting down')
    }
    try {
      this.wss.close()
    } catch {
      // The ws server may already be closed.
    }
  }

  private onClientOpen(exchange: WsExchange, client: WebSocket): void {
    if (exchange.done) {
      closeEndpoint(client, exchange.socket, 1001, 'tunnel closed')
      return
    }
    exchange.client = client
    this.touch(exchange)
    client.on('message', (data, isBinary) => {
      this.touch(exchange)
      if (exchange.done) return
      const buffer = toBuffer(data)
      for (const slice of splitTunnelWsPayload(buffer)) {
        this.deps.hub.sendHostFrame(
          exchange.hostId,
          { t: 'ws.frame', id: exchange.id, binary: isBinary, ...(slice.fin ? {} : { fin: false }) },
          slice.payload,
        )
      }
    })
    client.on('close', (code, reason) => {
      if (exchange.done) return
      this.deps.hub.sendHostFrame(exchange.hostId, {
        t: 'ws.close',
        id: exchange.id,
        code: sendableCloseCode(code, 1000),
        reason: reason.toString().slice(0, 120),
      })
      this.settle(exchange)
    })
    client.on('error', () => {
      // A socket error is always followed by close.
    })
    client.on('pong', () => this.touch(exchange))
  }

  private touch(exchange: WsExchange): void {
    if (exchange.done) return
    if (exchange.timer) clearTimeout(exchange.timer)
    exchange.timer = setTimeout(() => this.onTimeout(exchange), TUNNEL_IDLE_TIMEOUT_MS)
    exchange.timer.unref()
  }

  private onTimeout(exchange: WsExchange): void {
    if (exchange.done) return
    this.deps.logger.warn({ event: 'tunnel.ws.timeout', hostId: exchange.hostId, id: exchange.id })
    this.deps.hub.sendHostFrame(exchange.hostId, { t: 'ws.close', id: exchange.id, code: 1001, reason: 'idle timeout' })
    const client = exchange.client
    this.settle(exchange)
    closeEndpoint(client, exchange.socket, 1001, 'idle timeout')
  }

  private settle(exchange: WsExchange): void {
    if (exchange.done) return
    exchange.done = true
    if (exchange.timer) {
      clearTimeout(exchange.timer)
      exchange.timer = null
    }
    this.exchanges.delete(exchange.id)
    this.deps.capacity.release(exchange.deviceId, exchange.hostId)
  }

  private rejectSocket(socket: Duplex, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    const lines = [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'content-type: application/json; charset=utf-8',
      `content-length: ${Buffer.byteLength(payload)}`,
      'connection: close',
      '',
      payload,
    ]
    try {
      socket.write(lines.join('\r\n'))
    } catch {
      // The peer may already be gone.
    }
    socket.destroy()
  }
}
