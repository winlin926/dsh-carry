import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  TUNNEL_MAX_REQUESTS_PER_DEVICE,
  TUNNEL_MAX_REQUESTS_PER_HOST,
  type TunnelFrame,
} from '../../../src/remote/tunnel-protocol.js'
import type { AuthService } from '../auth.js'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { RateLimiter } from '../rate-limit.js'
import type { Repositories } from '../repositories.js'
import type { SessionContext } from '../sessions.js'
import type { TunnelFrameHandler, TunnelHub } from './hub.js'
import { HttpTunnelProxy } from './http-proxy.js'
import { type TunnelCapacity, hostOfflineError, tooManyTunnelRequestsError } from './shared.js'
import { WsTunnelProxy } from './ws-proxy.js'

export interface TunnelProxyDeps {
  config: Config
  logger: Logger
  auth: AuthService
  repos: Repositories
  limiter: RateLimiter
  hub: TunnelHub
}

/**
 * Reverse proxy for paired devices: HTTP requests and WebSocket upgrades are
 * forwarded over the Host tunnel instead of being served by this node.
 *
 * It is a {@link TunnelFrameHandler}: every Host → node frame for a request or
 * socket this class created is consumed here.
 */
export class TunnelProxy implements TunnelFrameHandler {
  private readonly deviceRequests = new Map<string, number>()
  private readonly hostRequests = new Map<string, number>()
  private readonly http: HttpTunnelProxy
  private readonly ws: WsTunnelProxy
  private closed = false

  constructor(private readonly deps: TunnelProxyDeps) {
    const capacity: TunnelCapacity = {
      selectHost: (session) => this.selectHost(session),
      assertCapacity: (deviceId, hostId) => this.assertCapacity(deviceId, hostId),
      acquire: (deviceId, hostId) => this.acquire(deviceId, hostId),
      release: (deviceId, hostId) => this.release(deviceId, hostId),
    }
    this.http = new HttpTunnelProxy({ logger: deps.logger, hub: deps.hub, capacity })
    this.ws = new WsTunnelProxy({
      config: deps.config,
      logger: deps.logger,
      auth: deps.auth,
      limiter: deps.limiter,
      hub: deps.hub,
      capacity,
    })
  }

  /**
   * Close every live WebSocket this device holds through the tunnel. Called when
   * its relationship is revoked so the phone cannot keep streaming on a dead grant.
   */
  closeDevice(deviceId: string): void {
    this.ws.closeDevice(deviceId)
  }

  /** Proxy one HTTP request for an already-authenticated paired device. */
  async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL, session: SessionContext): Promise<void> {
    await this.http.handleRequest(req, res, url, session)
  }

  /** Proxy one WebSocket upgrade request for an already-authenticated paired device. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    await this.ws.handleUpgrade(req, socket, head)
  }

  onFrame(hostId: string, frame: TunnelFrame, payload: Uint8Array): boolean {
    switch (frame.t) {
      case 'http.response':
        this.http.onResponse(hostId, frame)
        return true
      case 'http.chunk':
        this.http.onChunk(hostId, frame.id, payload)
        return true
      case 'http.end':
        this.http.onEnd(hostId, frame.id)
        return true
      case 'http.error':
        this.http.onError(hostId, frame)
        return true
      case 'http.cancel':
        this.http.onCancel(hostId, frame)
        return true
      case 'ws.ack':
        this.ws.onAck(hostId, frame)
        return true
      case 'ws.frame':
        this.ws.onHostFrame(hostId, frame, payload)
        return true
      case 'ws.close':
        this.ws.onHostClose(hostId, frame)
        return true
      default:
        return false
    }
  }

  /** Called by the hub when the Host tunnel goes away: fail everything in flight. */
  onClose(hostId: string): void {
    this.http.failHost(hostId)
    this.ws.failHost(hostId)
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.http.shutdown()
    this.ws.shutdown()
  }

  private selectHost({ session, device }: SessionContext): string {
    const relationships = this.deps.repos.listRelationshipsForDevice(device.device_id)
    const hostId = session.bound_host_id ?? (relationships.length === 1 ? relationships[0]?.host_id : undefined)
    if (!hostId || !relationships.some((row) => row.host_id === hostId) || !this.deps.hub.isHostOnline(hostId))
      throw hostOfflineError()
    return hostId
  }

  private assertCapacity(deviceId: string, hostId: string): void {
    if ((this.deviceRequests.get(deviceId) ?? 0) >= TUNNEL_MAX_REQUESTS_PER_DEVICE) throw tooManyTunnelRequestsError()
    if ((this.hostRequests.get(hostId) ?? 0) >= TUNNEL_MAX_REQUESTS_PER_HOST) throw tooManyTunnelRequestsError()
  }

  private acquire(deviceId: string, hostId: string): void {
    this.deviceRequests.set(deviceId, (this.deviceRequests.get(deviceId) ?? 0) + 1)
    this.hostRequests.set(hostId, (this.hostRequests.get(hostId) ?? 0) + 1)
  }

  private release(deviceId: string, hostId: string): void {
    const devices = (this.deviceRequests.get(deviceId) ?? 1) - 1
    if (devices <= 0) this.deviceRequests.delete(deviceId)
    else this.deviceRequests.set(deviceId, devices)
    const hosts = (this.hostRequests.get(hostId) ?? 1) - 1
    if (hosts <= 0) this.hostRequests.delete(hostId)
    else this.hostRequests.set(hostId, hosts)
  }
}
