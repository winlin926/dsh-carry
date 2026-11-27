import type { LanTlsConfig } from '../lan-tls.js'
import type { PublicNodeRecord } from '../public-node-config.js'

export type Mode = 'public' | 'lan'
/** Where outbound domain checks and certificate requests get their proxy. */
export type ProxyMode = 'system' | 'manual' | 'off'
/** The line a phone prefers when both are reachable; it decides nothing on this computer. */
export type Line = 'lan' | 'public'

export interface HostPluginConfig {
  gatewayPort?: number
  lanTls?: LanTlsConfig
  certificateDir?: string
  websocketCompression?: boolean
}

export interface Preferences {
  autoStart: boolean
  mode: Mode
  line: Line
  proxy?: string
  proxyMode: ProxyMode
  /** The port last used, tried again so the address a phone knows keeps working after a restart. */
  port?: number
}

export type PublicTarget =
  | { kind: 'none' }
  | { kind: 'gateway'; origin: string }
  | { kind: 'service'; record: PublicNodeRecord }

export interface LaunchPlan {
  mode: Mode
  target: PublicTarget
  fixedPublicPort: boolean
  wantedPort: number
}

/** A node that presents a new identity stays blocked until the user confirms it in the panel. */
export const IDENTITY_CHANGE_ERROR = '公网节点的身份已变化，请先在面板确认。'
/** The same reason persisted on the record so it survives a panel reload. */
export const IDENTITY_CHANGE_CHECK = '节点身份已变化，需要重新确认。'
/** A confirmed protocol-2 node may not silently fall back to the flat protocol-1 shape. */
export const DOWNGRADE_CHECK = '节点已降级为旧版协议，需要重新检测。'
