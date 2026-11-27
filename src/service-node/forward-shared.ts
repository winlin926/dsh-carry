import type { RawData } from 'ws'
import { RELAY_MARK } from '../direct/protocol.js'
import type { TunnelFrame, TunnelHeaders, TunnelRelayDevice } from '../remote/tunnel-protocol.js'
import { upstreamRequestHeaders } from '../upstream-http.js'

/** Bridge from HTTP/WS forwarders back to the active ServiceNode tunnel socket. */
export interface ServiceTunnelIo {
  send: (frame: TunnelFrame, payload?: Uint8Array) => void
  resolveTarget: (
    headers: TunnelHeaders,
    device?: TunnelRelayDevice,
  ) => { port: number; headers: TunnelHeaders } | undefined
  outboundBuffered: () => number
  armDrain: () => void
}

export function resolveForwardTarget(
  options: {
    upstreamPort: number
    upstreamCookie: () => string
    relayTarget?: (device: TunnelRelayDevice) => { port: number; mark: string } | undefined
  },
  headers: TunnelHeaders,
  device?: TunnelRelayDevice,
): { port: number; headers: TunnelHeaders } | undefined {
  if (device !== undefined && options.relayTarget) {
    const target = options.relayTarget(device)
    if (!target) return undefined
    const outgoing = upstreamRequestHeaders({ headers }, { upstreamPort: target.port, cookie: '' })
    delete outgoing.cookie
    return { port: target.port, headers: { ...outgoing, [RELAY_MARK]: target.mark } }
  }
  return {
    port: options.upstreamPort,
    headers: upstreamRequestHeaders(
      { headers },
      { upstreamPort: options.upstreamPort, cookie: options.upstreamCookie() },
    ),
  }
}

export function bytesOf(data: RawData): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}
