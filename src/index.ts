import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MANAGE_PATH, REMOTE_MARK } from './gateway.js'
import { loadHostIdentity } from './host-identity.js'
import { HostController } from './host/controller.js'
import { createManageHandler } from './host/manage.js'
import { hostCookie, lanAddresses } from './host/network.js'
import type { HostPluginConfig } from './host/types.js'
import { body, isLoopback, json, sameOrigin } from './http.js'
import { FRPC_CERTIFICATE_DIR } from './public-access.js'
import { PUBLIC_NODE_CAPABILITIES, PUBLIC_NODE_PROTOCOL_V2, type PublicNodeDiscovery } from './public-node.js'

export { hostCookie, lanAddresses }

/** Advertised by discovery; read from the installed package so it always matches the running build. */
const NODE_VERSION = (() => {
  try {
    const value: unknown = createRequire(import.meta.url)('../package.json').version
    return typeof value === 'string' && value ? value : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

export const name = '@winlin926/dsh-carry'
export const inject = ['connection']
export const Config = z.object({
  gatewayPort: z
    .natural()
    .max(65535)
    .default(0)
    .i18n({ 'zh-CN': { $description: '局域网网关端口；0 表示自动选择空闲端口。' } }),
  lanTls: z
    .object({
      hostname: z.string().required(),
      certFile: z.string().required(),
      keyFile: z.string().required(),
    })
    .default(undefined as never)
    .i18n({
      'zh-CN': {
        $description:
          '局域网 HTTPS：可信域名、PEM 证书及私钥文件路径；需固定网关端口并配置局域网 DNS。证书由外部签发和续期。',
      },
    }),
  certificateDir: z
    .string()
    .default('')
    .i18n({ 'zh-CN': { $description: '证书部署目录；留空使用 SakuraFrp 的 FrpcWorkingDirectory。' } }),
  websocketCompression: z
    .boolean()
    .default(true)
    .i18n({
      'zh-CN': {
        $description: '压缩远程连接的 WebSocket 消息，减少长会话历史的传输量；连接两端不再压缩时更省电但更费流量。',
      },
    }),
})
export interface Config extends HostPluginConfig {}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const profile = ctx.get('profileContext') as { name?: string } | undefined
  const baseHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileName = String(profile?.name || process.env.DSH_PROFILE || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  const storage = join(baseHome, 'dsh-remote-connect', profileName)
  const legacyStorage = join(baseHome, 'dsh-roam')
  mkdirSync(storage, { recursive: true })

  // One identity per profile: the gateway advertises it now, and any future local service reuses the
  // same file, so the Host keeps one hostId across restarts and never shares a pairing/cache scope.
  const hostIdentity = await loadHostIdentity(join(storage, 'host-identity.json'))
  // Protocol 2: one self-certifying node identity, plus the flat aliases protocol-1 clients still read.
  const discovery: PublicNodeDiscovery = {
    protocol: PUBLIC_NODE_PROTOCOL_V2,
    kind: 'gateway',
    name: 'DeepSeek Harness',
    version: NODE_VERSION,
    capabilities: [...PUBLIC_NODE_CAPABILITIES],
    node: { id: hostIdentity.hostId, fingerprint: hostIdentity.fingerprint, publicKey: hostIdentity.publicKey },
    hostId: hostIdentity.hostId,
    fingerprint: hostIdentity.fingerprint,
  }

  const ownedServer = !ctx.get('webServer')
  if (ownedServer) ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })

  let disposed = false
  let controller: HostController | undefined
  ctx.effect(
    () => () => {
      disposed = true
      controller?.markDisposed()
      return controller?.stop() ?? Promise.resolve()
    },
    'remote-control cleanup',
  )

  ctx.inject(['webServer'], async (ready) => {
    const upstreamPort = ready.webServer.port
    if (!upstreamPort) throw new Error('DSH WebServer 尚未就绪。')

    let activeController!: HostController
    const manage = createManageHandler(() => activeController)
    activeController = new HostController({
      storage,
      legacyStorage,
      config: {
        ...config,
        certificateDir: config.certificateDir || process.env.DSH_RC_CERTIFICATE_DIR || FRPC_CERTIFICATE_DIR,
      },
      hostIdentity,
      discovery,
      nodeVersion: NODE_VERSION,
      connection: ready.connection,
      upstreamPort,
      logWarn: (message) => ready.logger?.warn?.(message),
      onManage: manage,
    })
    controller = activeController
    if (disposed) activeController.markDisposed()

    await activeController.init()

    const localHandler = async (req: IncomingMessage, res: ServerResponse) => {
      const rejection = ready.connection.requestRejection(req)
      // The gateway is itself a loopback caller holding the Host session; what it forwards is never local.
      if (
        rejection ||
        req.headers[REMOTE_MARK] !== undefined ||
        !isLoopback(req.socket.remoteAddress) ||
        !sameOrigin(req)
      ) {
        json(res, rejection ?? 403, { error: '本机面板需要宿主认证和本机连接。' })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' })
        return
      }
      try {
        json(res, 200, await manage(await body(req), true))
      } catch (failure) {
        json(res, 400, { error: failure instanceof Error ? failure.message : '操作失败。' })
      }
    }

    ready.effect(() => () => activeController.disposeResources(), 'remote-control public access')
    ready.effect(
      () => ready.webServer.register({ kind: 'exact', path: MANAGE_PATH, handler: localHandler }),
      'remote-control local management',
    )
    // Desktop's trusted IPC/Fetch carrier bypasses node:http. The outer gateway
    // handles this exact route itself and never forwards remote approval requests.
    ready.effect(
      () =>
        ready.connection.fetch.register({
          path: MANAGE_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            if (request.headers.has(REMOTE_MARK))
              return Response.json({ error: '本机面板需要宿主认证和本机连接。' }, { status: 403 })
            try {
              const input = await request.json()
              return Response.json(await manage(input as Record<string, unknown>, true), {
                headers: { 'cache-control': 'no-store' },
              })
            } catch (failure) {
              return Response.json(
                { error: failure instanceof Error ? failure.message : '操作失败。' },
                { status: 400 },
              )
            }
          },
        }),
      'remote-control Desktop management',
    )

    await activeController.maybeAutoStart()
  })
}
