import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { safePath } from '../gateway.js'
import {
  TUNNEL_BACKPRESSURE_HIGH_WATER,
  TUNNEL_MAX_REQUESTS_PER_HOST,
  TUNNEL_REQUEST_TIMEOUT_MS,
  splitTunnelPayload,
  type TunnelHeaders,
  type TunnelRelayDevice,
} from '../remote/tunnel-protocol.js'
import type { ServiceTunnelIo } from './forward-shared.js'

/** Connection response headers that describe the Host<->node hop, never the response itself. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'])

interface HttpCall {
  request: ClientRequest
  response?: IncomingMessage
  paused: boolean
  finished: boolean
}

/** Forwards tunneled HTTP requests to loopback DSH and streams chunks back with backpressure. */
export class ServiceHttpForwarder {
  private readonly calls = new Map<string, HttpCall>()

  constructor(private readonly io: ServiceTunnelIo) {}

  open(id: string, method: string, path: string, headers: TunnelHeaders, device?: TunnelRelayDevice): void {
    if (this.calls.size >= TUNNEL_MAX_REQUESTS_PER_HOST) {
      this.io.send({ t: 'http.error', id, code: 'TOO_MANY_REQUESTS', message: '同时进行的远程请求过多，请稍后再试。' })
      return
    }
    let request: ClientRequest
    try {
      const target = safePath(path) ? this.io.resolveTarget(headers, device) : undefined
      if (!target) {
        this.io.send({
          t: 'http.response',
          id,
          status: 403,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
        this.io.send({ t: 'http.chunk', id }, Buffer.from('{"code":"unpaired"}'))
        this.io.send({ t: 'http.end', id })
        return
      }
      request = httpRequest({ hostname: '127.0.0.1', port: target.port, path, method, headers: target.headers })
    } catch {
      this.io.send({ t: 'http.error', id, code: 'UPSTREAM_FAILED', message: '本机 DSH 没有接受这个请求。' })
      return
    }
    const call: HttpCall = { request, paused: false, finished: false }
    this.calls.set(id, call)
    const fail = (): void => {
      if (call.finished) return
      call.finished = true
      this.calls.delete(id)
      this.io.send({ t: 'http.error', id, code: 'UPSTREAM_FAILED', message: '本机 DSH 没有完成这个请求。' })
    }
    request.setTimeout(TUNNEL_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('上游请求超时。')))
    request.on('error', fail)
    request.on('response', (response) => {
      if (call.finished) {
        response.destroy()
        return
      }
      call.response = response
      const outgoing: TunnelHeaders = {}
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue
        outgoing[name] = value
      }
      this.io.send({ t: 'http.response', id, status: response.statusCode ?? 502, headers: outgoing })
      response.on('data', (chunk: Buffer) => {
        if (call.finished) return
        // Streamed, never buffered: an SSE response must reach the phone chunk by chunk.
        for (const part of splitTunnelPayload(chunk)) this.io.send({ t: 'http.chunk', id }, part)
        if (call.paused) return
        if (this.io.outboundBuffered() > TUNNEL_BACKPRESSURE_HIGH_WATER) {
          call.paused = true
          response.pause()
          this.io.armDrain()
        }
      })
      response.on('end', () => {
        if (call.finished) return
        call.finished = true
        this.calls.delete(id)
        this.io.send({ t: 'http.end', id })
      })
      response.on('error', () => {
        response.destroy()
        fail()
      })
    })
    request.on('close', () => {
      // The upstream connection can close before the response stream ends; the error path reports it.
      if (call.finished) return
      if (!call.response) fail()
    })
  }

  write(id: string, payload: Uint8Array): void {
    const call = this.calls.get(id)
    if (!call || call.finished || payload.length === 0) return
    call.request.write(payload)
  }

  end(id: string): void {
    const call = this.calls.get(id)
    if (!call || call.finished) return
    call.request.end()
  }

  cancel(id: string): void {
    const call = this.calls.get(id)
    if (!call) return
    call.finished = true
    this.calls.delete(id)
    call.response?.destroy()
    call.request.destroy()
  }

  resume(): void {
    for (const call of this.calls.values()) {
      if (!call.paused) continue
      call.paused = false
      call.response?.resume()
    }
  }

  failAll(): void {
    for (const [id, call] of this.calls) {
      call.finished = true
      this.calls.delete(id)
      call.response?.destroy()
      call.request.destroy()
    }
  }
}
