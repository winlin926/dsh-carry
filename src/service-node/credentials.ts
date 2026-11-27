import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NODE_API, type HostRegistration } from '../remote/node-api.js'

/** The durable per-node credential file inside the plugin storage directory. */
export const SERVICE_NODES_FILE = 'service-nodes.json'
const SERVICE_NODES_VERSION = 1
/** Name the Host registers with, so the node's panel can tell what kind of client it is. */
const REGISTER_NAME = 'DeepSeek Harness'
const REGISTER_TIMEOUT_MS = 20_000
/** Windows can briefly refuse a rename while another process holds the destination open. */
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface StoredNode {
  credential: string
  hostId: string
  registeredAt: number
  lastConnectedAt: number | null
}

/** Which Host identity a saved credential must belong to before it may delete that registration. */
export interface ServiceNodeIdentity {
  hostId: string
}

/** A failure whose message is already the Chinese text shown by the panel. */
export class ServiceNodeError extends Error {}

function storedNodeOf(value: unknown): StoredNode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  // An entry that cannot be used is ignored, never allowed to abort the whole credentials file.
  if (typeof row.credential !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(row.credential)) return null
  if (typeof row.hostId !== 'string' || !row.hostId) return null
  if (typeof row.registeredAt !== 'number' || !Number.isFinite(row.registeredAt)) return null
  const lastConnectedAt =
    row.lastConnectedAt === null || row.lastConnectedAt === undefined
      ? null
      : typeof row.lastConnectedAt === 'number' && Number.isFinite(row.lastConnectedAt)
        ? row.lastConnectedAt
        : undefined
  if (lastConnectedAt === undefined) return null
  return { credential: row.credential, hostId: row.hostId, registeredAt: row.registeredAt, lastConnectedAt }
}

/** Credentials are opaque tokens: printable, unbroken, and short enough for an HTTP header. */
function validCredential(value: string): string {
  if (!/^[\x21-\x7e]{1,512}$/.test(value)) throw new ServiceNodeError('节点返回的凭据格式不正确。')
  return value
}

async function rmQuietly(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch {
    /* already gone */
  }
}

export async function readNodes(file: string): Promise<Record<string, StoredNode>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ServiceNodeError(`服务节点凭据文件无法读取：${file}。`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  if (row.version !== SERVICE_NODES_VERSION || !row.nodes || typeof row.nodes !== 'object' || Array.isArray(row.nodes))
    return {}
  const nodes: Record<string, StoredNode> = {}
  for (const [origin, record] of Object.entries(row.nodes as Record<string, unknown>)) {
    const node = storedNodeOf(record)
    if (node) nodes[origin] = node
  }
  return nodes
}

export async function writeNodes(file: string, nodes: Record<string, StoredNode>): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ version: SERVICE_NODES_VERSION, nodes }), { mode: 0o600 })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, file)
        return
      } catch (failure) {
        const code = (failure as NodeJS.ErrnoException).code ?? ''
        if (attempt >= 4 || !TRANSIENT_WRITE_CODES.has(code)) throw failure
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
      }
    }
  } catch (failure) {
    await rmQuietly(temporary)
    throw failure
  }
}

/**
 * Delete one node's saved credential without a running tunnel, e.g. after the user removes that
 * node from the list. A missing file or entry is a no-op.
 */
export async function forgetServiceNode(storage: string, origin: string): Promise<void> {
  const file = join(storage, SERVICE_NODES_FILE)
  const nodes = await readNodes(file)
  if (!(origin in nodes)) return
  delete nodes[origin]
  await writeNodes(file, nodes)
}

/**
 * Delete this Host's registration on the node. 204 means the node removed it and 404 means it was
 * already gone; every other answer (or a network failure) leaves the registration behind and is
 * reported to the caller so the panel can explain what is still there.
 */
export async function deleteHostRegistration(origin: string, hostId: string, credential: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${origin}${NODE_API.host.url({ hostId })}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    })
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code
    throw new ServiceNodeError(
      code ? `无法连接服务节点以撤销主机注册（${code}）。` : '无法连接服务节点以撤销主机注册。',
    )
  }
  response.body?.cancel().catch(() => undefined)
  if (response.status === 204 || response.status === 404) return
  const message =
    response.status === 401 || response.status === 403
      ? `节点拒绝了撤销主机注册（HTTP ${response.status}），节点上的注册可能仍在。`
      : `节点没有撤销主机注册（HTTP ${response.status}），节点上的注册可能仍在。`
  throw new ServiceNodeError(message)
}

/**
 * Delete one node's Host registration without a running tunnel, e.g. when the user removes a node
 * that is not currently connected. A missing entry (or one saved for another identity) is a no-op;
 * the local credential is dropped once the node confirms the deletion.
 */
export async function unregisterServiceNode(
  storage: string,
  origin: string,
  identity?: ServiceNodeIdentity,
): Promise<void> {
  const file = join(storage, SERVICE_NODES_FILE)
  const nodes = await readNodes(file)
  const stored = nodes[origin]
  if (!stored) return
  if (identity && stored.hostId !== identity.hostId) return
  await deleteHostRegistration(origin, stored.hostId, stored.credential)
  delete nodes[origin]
  await writeNodes(file, nodes)
}

export async function registerHostOnNode(options: {
  origin: string
  hostId: string
  identityKey: string
  clientVersion: string
}): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${options.origin}${NODE_API.hosts.url()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: options.hostId,
        name: REGISTER_NAME,
        identityKey: options.identityKey,
        clientVersion: options.clientVersion,
      } satisfies HostRegistration),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    })
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code
    throw new ServiceNodeError(code ? `无法连接服务节点注册接口（${code}）。` : '无法连接服务节点注册接口。')
  }
  if (response.status === 409) {
    const body = await response.text().catch(() => '')
    let code = ''
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed && typeof parsed === 'object') {
        const value = (parsed as Record<string, unknown>).code
        if (typeof value === 'string') code = value
      }
    } catch {
      /* the message below covers an opaque 409 */
    }
    if (code === 'IDENTITY_IN_USE') throw new ServiceNodeError('该主机身份已被其他注册占用，请检查节点配置。')
    if (code === 'HOST_ALREADY_REGISTERED')
      throw new ServiceNodeError(
        '节点上已存在该主机的注册记录，但本机没有保存凭据。请在节点上重置该主机，或恢复本机的服务节点凭据文件。',
      )
    throw new ServiceNodeError('节点拒绝了本机注册（HTTP 409）。')
  }
  if (response.status !== 201) {
    response.body?.cancel().catch(() => undefined)
    throw new ServiceNodeError(`节点注册失败（HTTP ${response.status}）。`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ServiceNodeError('节点返回的注册结果不是有效的 JSON。')
  }
  if (!body || typeof body !== 'object') throw new ServiceNodeError('节点返回的注册结果格式不正确。')
  const row = body as Record<string, unknown>
  // The node's answer must name this Host: a credential for somebody else's fingerprint is never used.
  const host = row.host && typeof row.host === 'object' ? (row.host as Record<string, unknown>) : undefined
  const returnedHostId = host && typeof host.hostId === 'string' ? host.hostId : undefined
  if (returnedHostId !== options.hostId)
    throw new ServiceNodeError('节点返回的主机指纹与本机不一致，已拒绝使用该节点。')
  if (typeof row.credential !== 'string') throw new ServiceNodeError('节点没有返回可用的凭据。')
  return validCredential(row.credential)
}

export async function issueNodePairingTicket(options: {
  origin: string
  credential: string
  identityKey: string
  onUnauthorized: () => void
}): Promise<{ url: string; expiresAt: number }> {
  let response: Response
  try {
    response = await fetch(`${options.origin}${NODE_API.pairings.url()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.credential}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    })
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code
    throw new ServiceNodeError(code ? `无法连接服务节点的配对接口（${code}）。` : '无法连接服务节点的配对接口。')
  }
  if (response.status === 401 || response.status === 403) options.onUnauthorized()
  if (response.status !== 201) {
    response.body?.cancel().catch(() => undefined)
    throw new ServiceNodeError(`节点没有签发配对票据（HTTP ${response.status}）。`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ServiceNodeError('节点返回的配对票据不是有效的 JSON。')
  }
  const row = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
  const ticket =
    row && typeof row.ticket === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(row.ticket) ? row.ticket : undefined
  const expiresAt =
    row && typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt) && row.expiresAt > 0
      ? row.expiresAt
      : undefined
  if (!ticket || expiresAt === undefined) throw new ServiceNodeError('节点返回的配对票据格式不正确。')
  const hash = new URLSearchParams({ v: '1', ticket, key: options.identityKey })
  return { url: `${options.origin}/pair#${hash.toString()}`, expiresAt }
}
