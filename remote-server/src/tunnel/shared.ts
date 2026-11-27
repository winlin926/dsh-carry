import { ApiError } from '../errors.js'
import type { SessionContext } from '../sessions.js'

export const HOST_OFFLINE_MESSAGE = '公网节点已连接，但本机没有响应。请确认 DSH 正在运行。'
export const TUNNEL_CLOSED_MESSAGE = '隧道已断开，请重试。'
export const TUNNEL_TIMEOUT_MESSAGE = '隧道请求超时，请稍后再试。'
export const TUNNEL_CANCELLED_MESSAGE = '隧道请求已取消。'
export const TUNNEL_ERROR_MESSAGE = '隧道返回错误，请稍后再试。'
export const TOO_MANY_TUNNEL_REQUESTS_MESSAGE = '隧道请求过多，请稍后再试。'
export const SESSION_REQUIRED_MESSAGE = '请先完成设备配对后再访问此节点。'

/** Shared host lookup and concurrent-request accounting between HTTP and WebSocket proxies. */
export interface TunnelCapacity {
  selectHost(session: SessionContext): string
  assertCapacity(deviceId: string, hostId: string): void
  acquire(deviceId: string, hostId: string): void
  release(deviceId: string, hostId: string): void
}

export function hostOfflineError(): ApiError {
  return new ApiError(503, 'HOST_OFFLINE', HOST_OFFLINE_MESSAGE)
}

export function tooManyTunnelRequestsError(): ApiError {
  return new ApiError(429, 'TOO_MANY_REQUESTS', TOO_MANY_TUNNEL_REQUESTS_MESSAGE, 1_000)
}
