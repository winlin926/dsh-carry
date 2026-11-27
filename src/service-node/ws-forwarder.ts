import type { RawData, WebSocket as TunnelSocket } from 'ws'
import { safePath } from '../gateway.js'
import {
  TUNNEL_BACKPRESSURE_HIGH_WATER,
  TUNNEL_IDLE_TIMEOUT_MS,
  TUNNEL_WS_MESSAGE_MAX,
  assembleTunnelWsFrame,
  splitTunnelWsPayload,
  type TunnelHeaders,
  type TunnelRelayDevice,
  type TunnelWsMessageAssembly,
} from '../remote/tunnel-protocol.js'
import { bytesOf, type ServiceTunnelIo } from './forward-shared.js'

const HANDSHAKE_TIMEOUT_MS = 15_000
/** WebSocket close reasons are capped at 123 bytes of UTF-8. */
const CLOSE_REASON_MAX = 123

interface WsCall {
  socket: TunnelSocket
  timer?: ReturnType<typeof setTimeout>
  /** Suppresses the close notification when the node itself asked for the close. */
  remoteClosed: boolean
  pendingMessage?: TunnelWsMessageAssembly
}

export function closeReason(reason: unknown): string | undefined {
  const text =
    typeof reason === 'string'
      ? reason.trim()
      : reason instanceof Uint8Array
        ? Buffer.from(reason).toString('utf8').trim()
        : ''
  if (!text) return undefined
  const encoded = Buffer.from(text)
  return encoded.length <= CLOSE_REASON_MAX ? text : encoded.subarray(0, CLOSE_REASON_MAX).toString('utf8')
}

/** Forwards tunneled WebSocket upgrades and binary/text messages to loopback DSH. */
export class ServiceWsForwarder {
  private readonly calls = new Map<string, WsCall>()

  constructor(
    private readonly io: ServiceTunnelIo,
    private readonly loadWs: () => Promise<typeof import('ws')>,
  ) {}

  async open(
    id: string,
    path: string,
    headers: TunnelHeaders,
    protocol?: string,
    device?: TunnelRelayDevice,
  ): Promise<void> {
    const ws = await this.loadWs().catch(() => undefined)
    if (!ws) {
      this.io.send({ t: 'ws.ack', id, ok: false, status: 502, message: '本机 WebSocket 客户端不可用。' })
      return
    }
    let socket: TunnelSocket
    try {
      const target = safePath(path) ? this.io.resolveTarget(headers, device) : undefined
      if (!target) {
        this.io.send({ t: 'ws.ack', id, ok: false, status: 403, message: '设备未授权。' })
        return
      }
      delete target.headers['sec-websocket-protocol']
      socket = new ws.WebSocket(`ws://127.0.0.1:${target.port}${path}`, protocol ? [protocol] : [], {
        headers: target.headers,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: TUNNEL_WS_MESSAGE_MAX,
      })
    } catch {
      this.io.send({ t: 'ws.ack', id, ok: false, status: 502, message: '本机 WebSocket 服务没有接受连接。' })
      return
    }
    const call: WsCall = { socket, remoteClosed: false }
    this.calls.set(id, call)
    this.touch(id, call)
    socket.on('open', () => {
      const negotiated = socket.protocol || protocol
      this.io.send({ t: 'ws.ack', id, ok: true, ...(negotiated ? { protocol: negotiated } : {}) })
    })
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.calls.get(id) !== call) return
      this.touch(id, call)
      for (const slice of splitTunnelWsPayload(bytesOf(data))) {
        this.io.send({ t: 'ws.frame', id, binary: isBinary, ...(slice.fin ? {} : { fin: false }) }, slice.payload)
      }
      if (this.io.outboundBuffered() > TUNNEL_BACKPRESSURE_HIGH_WATER) {
        socket.pause()
        this.io.armDrain()
      }
    })
    socket.on('close', (code: number, reason: Buffer) => {
      if (this.calls.get(id) !== call) return
      this.calls.delete(id)
      clearTimeout(call.timer)
      if (call.remoteClosed) return
      const text = closeReason(reason)
      this.io.send({ t: 'ws.close', id, code: code || 1005, ...(text ? { reason: text } : {}) })
    })
    socket.on('error', () => {
      if (this.calls.get(id) !== call) return
      // A failed local handshake gets a refusal; an established socket's error is reported by close.
      if (socket.readyState !== socket.OPEN) {
        this.calls.delete(id)
        clearTimeout(call.timer)
        this.io.send({ t: 'ws.ack', id, ok: false, status: 502, message: '本机 WebSocket 服务没有接受连接。' })
        try {
          socket.terminate()
        } catch {
          /* already gone */
        }
      }
    })
  }

  /** Restart one tunneled WebSocket's idle clock; no frame in either direction for 120 s closes it. */
  private touch(id: string, call: WsCall): void {
    clearTimeout(call.timer)
    call.timer = setTimeout(() => {
      if (this.calls.get(id) !== call) return
      this.calls.delete(id)
      this.io.send({ t: 'ws.close', id, code: 1000, reason: '空闲超时。' })
      try {
        call.socket.close(1000, '空闲超时。')
      } catch {
        /* already closed */
      }
    }, TUNNEL_IDLE_TIMEOUT_MS)
    call.timer.unref?.()
  }

  deliver(id: string, binary: boolean, fin: boolean | undefined, payload: Uint8Array): void {
    const call = this.calls.get(id)
    if (!call) return
    this.touch(id, call)
    const assembled = assembleTunnelWsFrame(call.pendingMessage, { binary, fin }, payload)
    if (assembled.status === 'error') {
      this.calls.delete(id)
      clearTimeout(call.timer)
      this.io.send({ t: 'ws.close', id, code: assembled.code, reason: assembled.reason })
      try {
        call.socket.close(assembled.code, assembled.reason)
      } catch {
        /* already closed */
      }
      return
    }
    call.pendingMessage = assembled.pending
    if (assembled.status !== 'message') return
    if (call.socket.readyState !== call.socket.OPEN) return
    call.socket.send(assembled.data, { binary: assembled.binary })
  }

  close(id: string, code?: number, reason?: string): void {
    const call = this.calls.get(id)
    if (!call) return
    call.remoteClosed = true
    this.calls.delete(id)
    clearTimeout(call.timer)
    try {
      call.socket.close(code ?? 1000, reason)
    } catch {
      /* already closed */
    }
  }

  resume(): void {
    for (const call of this.calls.values()) {
      if (call.socket.isPaused) call.socket.resume()
    }
  }

  failAll(): void {
    for (const [id, call] of this.calls) {
      this.calls.delete(id)
      clearTimeout(call.timer)
      try {
        call.socket.terminate()
      } catch {
        /* already gone */
      }
    }
  }
}
