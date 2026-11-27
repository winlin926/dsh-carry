import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  TUNNEL_IDLE_TIMEOUT_MS,
  TUNNEL_REQUEST_TIMEOUT_MS,
  asTunnelHeaders,
  splitTunnelPayload,
  toTunnelHeaders,
  type TunnelFrame,
  type TunnelHeaders,
  type TunnelHttpCancelFrame,
  type TunnelHttpErrorFrame,
  type TunnelHttpResponseFrame,
} from '../../../src/remote/tunnel-protocol.js'
import { errorBody } from '../errors.js'
import { sendJson } from '../http/util.js'
import type { Logger } from '../logger.js'
import type { SessionContext } from '../sessions.js'
import type { TunnelHub } from './hub.js'
import {
  TUNNEL_CANCELLED_MESSAGE,
  TUNNEL_CLOSED_MESSAGE,
  TUNNEL_ERROR_MESSAGE,
  TUNNEL_TIMEOUT_MESSAGE,
  type TunnelCapacity,
  hostOfflineError,
} from './shared.js'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface HttpProxyDeps {
  logger: Logger
  hub: TunnelHub
  capacity: TunnelCapacity
}

interface HttpExchange {
  id: string
  hostId: string
  deviceId: string
  req: IncomingMessage
  res: ServerResponse
  done: boolean
  headersSent: boolean
  streaming: boolean
  timer: NodeJS.Timeout | null
  /** Serializes response-header/chunk/end writes in wire order. */
  chain: Promise<void>
}

function sanitizeResponseHeaders(headers: TunnelHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    result[lower] = value
  }
  return result
}

/** Proxies paired-device HTTP requests and SSE/chunked responses over the Host reverse tunnel. */
export class HttpTunnelProxy {
  private readonly exchanges = new Map<string, HttpExchange>()

  constructor(private readonly deps: HttpProxyDeps) {}

  async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL, session: SessionContext): Promise<void> {
    const deviceId = session.device.device_id
    const hostId = this.deps.capacity.selectHost(session)
    this.deps.capacity.assertCapacity(deviceId, hostId)
    const id = randomUUID()
    const exchange: HttpExchange = {
      id,
      hostId,
      deviceId,
      req,
      res,
      done: false,
      headersSent: false,
      streaming: false,
      timer: null,
      chain: Promise.resolve(),
    }
    this.exchanges.set(id, exchange)
    this.deps.capacity.acquire(deviceId, hostId)
    exchange.timer = setTimeout(() => this.onTimeout(exchange), TUNNEL_REQUEST_TIMEOUT_MS)
    exchange.timer.unref()
    this.watchClient(exchange)

    const frame: TunnelFrame = {
      t: 'http.request',
      id,
      method: req.method ?? 'GET',
      path: req.url ?? url.pathname,
      headers: toTunnelHeaders(req.headers),
      ...(this.deps.hub.supportsDirect(hostId) ? { relayDevice: { id: deviceId, name: session.device.name } } : {}),
    }
    if (!this.deps.hub.sendHostFrame(hostId, frame)) {
      this.settle(exchange)
      throw hostOfflineError()
    }
    void this.pipeRequestBody(exchange)
  }

  onResponse(hostId: string, frame: TunnelHttpResponseFrame): void {
    this.enqueueFrame(hostId, frame.id, (exchange) => this.writeResponseHead(exchange, frame))
  }

  onChunk(hostId: string, id: string, payload: Uint8Array): void {
    this.enqueueFrame(hostId, id, (exchange) => this.writeChunk(exchange, payload))
  }

  onEnd(hostId: string, id: string): void {
    this.enqueueFrame(hostId, id, (exchange) => this.finish(exchange))
  }

  onError(hostId: string, frame: TunnelHttpErrorFrame): void {
    const exchange = this.exchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) return
    this.enqueue(exchange, () => {
      this.deps.logger.warn({
        event: 'tunnel.http.error',
        hostId,
        code: typeof frame.code === 'string' ? frame.code.slice(0, 64) : 'UNKNOWN',
      })
      this.fail(exchange, 502, 'TUNNEL_ERROR', TUNNEL_ERROR_MESSAGE)
    })
  }

  onCancel(hostId: string, frame: TunnelHttpCancelFrame): void {
    const exchange = this.exchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) return
    this.enqueue(exchange, () => {
      this.fail(exchange, 502, 'TUNNEL_CANCELLED', TUNNEL_CANCELLED_MESSAGE)
    })
  }

  failHost(hostId: string): void {
    for (const exchange of [...this.exchanges.values()]) {
      if (exchange.hostId !== hostId) continue
      this.fail(exchange, 502, 'TUNNEL_CLOSED', TUNNEL_CLOSED_MESSAGE)
    }
  }

  shutdown(): void {
    for (const exchange of [...this.exchanges.values()]) {
      const res = exchange.res
      this.settle(exchange)
      try {
        res.destroy()
      } catch {
        // The response is already gone.
      }
    }
  }

  private watchClient(exchange: HttpExchange): void {
    const cancel = (): void => {
      if (exchange.done) return
      this.deps.hub.sendHostFrame(exchange.hostId, { t: 'http.cancel', id: exchange.id })
      this.settle(exchange)
    }
    exchange.req.on('aborted', cancel)
    exchange.res.on('close', () => {
      if (!exchange.done) cancel()
    })
  }

  private async pipeRequestBody(exchange: HttpExchange): Promise<void> {
    try {
      for await (const chunk of exchange.req) {
        if (exchange.done) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        for (const slice of splitTunnelPayload(buffer)) {
          if (exchange.done) return
          const sent = await this.deps.hub.sendHostFrameAsync(
            exchange.hostId,
            { t: 'http.body', id: exchange.id },
            slice,
          )
          if (!sent) {
            this.fail(exchange, 502, 'TUNNEL_CLOSED', TUNNEL_CLOSED_MESSAGE)
            return
          }
        }
      }
      if (exchange.done) return
      this.deps.hub.sendHostFrame(exchange.hostId, { t: 'http.body.end', id: exchange.id })
    } catch {
      if (exchange.done) return
      this.deps.logger.warn({ event: 'tunnel.request.body.failed', id: exchange.id })
      this.fail(exchange, 502, 'TUNNEL_CLOSED', TUNNEL_CLOSED_MESSAGE)
    }
  }

  private enqueueFrame(hostId: string, id: string, task: (exchange: HttpExchange) => void | Promise<void>): void {
    const exchange = this.exchanges.get(id)
    if (!exchange || exchange.hostId !== hostId) {
      this.deps.logger.debug({ event: 'tunnel.frame.unknown', hostId, type: 'http', id })
      return
    }
    this.enqueue(exchange, () => task(exchange))
  }

  private enqueue(exchange: HttpExchange, task: () => void | Promise<void>): void {
    exchange.chain = exchange.chain.then(task).catch((error) => {
      this.deps.logger.warn({ event: 'tunnel.http.write.failed', hostId: exchange.hostId, id: exchange.id, error })
      this.fail(exchange, 502, 'TUNNEL_ERROR', TUNNEL_ERROR_MESSAGE)
    })
  }

  private writeResponseHead(exchange: HttpExchange, frame: TunnelHttpResponseFrame): void {
    if (exchange.done || exchange.headersSent) return
    const status = Number.isInteger(frame.status) && frame.status >= 200 && frame.status <= 599 ? frame.status : 502
    const headers = sanitizeResponseHeaders(asTunnelHeaders(frame.headers))
    exchange.headersSent = true
    exchange.res.writeHead(status, headers)
    const contentType = String(headers['content-type'] ?? '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      exchange.streaming = true
      this.armIdleTimer(exchange)
    }
  }

  private async writeChunk(exchange: HttpExchange, payload: Uint8Array): Promise<void> {
    if (exchange.done || !exchange.headersSent) return
    if (exchange.res.destroyed || exchange.res.writableEnded) return
    if (exchange.streaming) this.armIdleTimer(exchange)
    await new Promise<void>((resolve) => {
      exchange.res.write(Buffer.from(payload), () => resolve())
    })
  }

  private finish(exchange: HttpExchange): void {
    if (exchange.done) return
    const headersSent = exchange.headersSent || exchange.res.headersSent
    this.settle(exchange)
    if (!headersSent) {
      this.sendError(exchange, 502, 'TUNNEL_INVALID_RESPONSE', TUNNEL_ERROR_MESSAGE)
      return
    }
    try {
      exchange.res.end()
    } catch {
      exchange.res.destroy()
    }
  }

  private armIdleTimer(exchange: HttpExchange): void {
    if (exchange.timer) clearTimeout(exchange.timer)
    exchange.timer = setTimeout(() => this.onTimeout(exchange), TUNNEL_IDLE_TIMEOUT_MS)
    exchange.timer.unref()
  }

  private onTimeout(exchange: HttpExchange): void {
    if (exchange.done) return
    this.deps.logger.warn({ event: 'tunnel.http.timeout', hostId: exchange.hostId, streaming: exchange.streaming })
    this.deps.hub.sendHostFrame(exchange.hostId, { t: 'http.cancel', id: exchange.id })
    const headersSent = exchange.headersSent || exchange.res.headersSent
    this.settle(exchange)
    if (headersSent) {
      exchange.res.destroy()
      return
    }
    this.sendError(exchange, 504, 'TUNNEL_TIMEOUT', TUNNEL_TIMEOUT_MESSAGE)
  }

  private fail(exchange: HttpExchange, status: number, code: string, message: string): void {
    if (exchange.done) return
    const headersSent = exchange.headersSent || exchange.res.headersSent
    this.settle(exchange)
    if (headersSent) {
      exchange.res.destroy()
      return
    }
    this.sendError(exchange, status, code, message)
  }

  private sendError(exchange: HttpExchange, status: number, code: string, message: string): void {
    if (exchange.res.headersSent) {
      exchange.res.destroy()
      return
    }
    try {
      sendJson(exchange.res, status, errorBody(code, message), { head: exchange.req.method === 'HEAD' })
    } catch {
      exchange.res.destroy()
    }
  }

  private settle(exchange: HttpExchange): void {
    if (exchange.done) return
    exchange.done = true
    if (exchange.timer) {
      clearTimeout(exchange.timer)
      exchange.timer = null
    }
    this.exchanges.delete(exchange.id)
    this.deps.capacity.release(exchange.deviceId, exchange.hostId)
  }
}
