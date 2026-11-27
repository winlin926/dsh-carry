import type { Context } from '@deepseek-ai/cordis'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'

const INTERNAL_COOKIE_NAME = 'dsh-rc-internal'

interface LegacyHostConnection {
  authenticatedUrl?: (base: string) => string
  authorizeIndex?: (
    req: { method: string; url: string; headers: { host: string } },
    res: { writeHead(status: number, headers?: Record<string, string>): void; end(): void },
  ) => void
}

interface ModernPeer {
  readonly signal?: AbortSignal
  readonly principal?: { readonly kind?: string }
  dispose?: () => Promise<unknown> | unknown
}

interface ModernHostConnection {
  createPeer?: (options: { readonly principal: { readonly kind: 'owner' } }) => ModernPeer
  authentication?: {
    register(provider: {
      authenticate(request: {
        readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
      }): ModernPeer | undefined
    }): (() => unknown) | undefined
  }
}

export interface HostUpstreamAuth {
  cookie(): string
  refresh(): string
  isInternalRequest(req: IncomingMessage): boolean
  dispose(): void
}

function readCookiePair(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  let raw: string | undefined
  if (headers instanceof Headers) {
    raw = headers.get('cookie') ?? undefined
  } else {
    const value = headers.cookie ?? headers.Cookie
    raw = typeof value === 'string' ? value : Array.isArray(value) ? value.join('; ') : undefined
  }
  if (!raw) return undefined
  let found: string | undefined
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=')
    if (eq < 0 || segment.slice(0, eq).trim() !== name) continue
    if (found !== undefined) return undefined
    found = segment.slice(eq + 1).trim()
  }
  return found
}

function secretsMatch(actual: string, expected: Buffer): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(actual)) return false
  const actualBuf = Buffer.from(actual, 'ascii')
  return actualBuf.length === expected.length && timingSafeEqual(actualBuf, expected)
}

/** Adapters that are rarely the network a phone is on: virtual switches, VPN / proxy tunnels. */
const VIRTUAL_ADAPTER =
  /vethernet|wsl|hyper-v|vmware|virtualbox|vbox|docker|loopback|tailscale|zerotier|tap|tun|vpn|clash|meta|wintun|utun|bluetooth/i

/** This computer's IPv4 addresses, the ones a phone on the same network can most likely reach first. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const rows = Object.entries(interfaces).flatMap(([name, list]) =>
    (list ?? []).filter((row) => row.family === 'IPv4' && !row.internal).map((row) => ({ name, address: row.address })),
  )
  const rank = (row: { name: string; address: string }) => {
    const [a = 0, b = 0] = row.address.split('.').map(Number)
    // Link-local and the 198.18/15 range used by TUN proxies are not reachable from a phone.
    if ((a === 169 && b === 254) || (a === 198 && (b === 18 || b === 19))) return 3
    if (VIRTUAL_ADAPTER.test(row.name)) return 2
    return (a === 192 && b === 168) || a === 10 || (a === 172 && b >= 16 && b <= 31) ? 0 : 1
  }
  const ranked = rows
    .map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((x, y) => x.rank - y.rank || x.index - y.index)
  // Addresses no phone can reach are left out, unless there is nothing else.
  const usable = ranked.filter((item) => item.rank < 3)
  return (usable.length ? usable : ranked).map((item) => item.row.address)
}

/** Exchange the Host's launch token entirely inside the process. */
export function hostCookie(connection: Context['connection'], port: number): string {
  const legacy = connection as unknown as LegacyHostConnection
  if (typeof legacy.authenticatedUrl !== 'function' || typeof legacy.authorizeIndex !== 'function') {
    throw new Error('DSH 宿主认证接口不提供 legacy launch token。')
  }
  const base = `http://127.0.0.1:${port}/`
  const authenticated = new URL(legacy.authenticatedUrl(base))
  let cookie = ''
  legacy.authorizeIndex(
    {
      method: 'GET',
      url: authenticated.pathname + authenticated.search,
      headers: { host: `127.0.0.1:${port}` },
    },
    {
      writeHead(_status, headers) {
        cookie = headers?.['set-cookie']?.split(';')[0] ?? ''
      },
      end() {},
    },
  )
  if (!cookie) throw new Error('DSH 宿主认证接口无法建立内部会话。')
  return cookie
}

/**
 * Establish loopback authentication for the gateway against the Host's WebServer.
 * Supports both DSH 0.2.2 (`authenticatedUrl`/`authorizeIndex`) and DSH 0.2.3+
 * (`connection.authentication.register` + `connection.createPeer`).
 */
export function createHostUpstreamAuth(connection: Context['connection'], port: number): HostUpstreamAuth {
  const legacy = connection as unknown as LegacyHostConnection
  if (typeof legacy.authenticatedUrl === 'function' && typeof legacy.authorizeIndex === 'function') {
    let current = hostCookie(connection, port)
    return {
      cookie: () => current,
      refresh: () => {
        current = hostCookie(connection, port)
        return current
      },
      isInternalRequest: () => false,
      dispose: () => {},
    }
  }
  const modern = connection as unknown as ModernHostConnection
  if (typeof modern.createPeer === 'function' && typeof modern.authentication?.register === 'function') {
    const secret = randomBytes(32).toString('base64url')
    const expected = Buffer.from(secret, 'ascii')
    const headerCookie = `${INTERNAL_COOKIE_NAME}=${secret}`
    const peer = modern.createPeer({ principal: { kind: 'owner' } })
    let disposed = false
    const withdraw = modern.authentication.register({
      authenticate(request) {
        if (disposed || peer.signal?.aborted) return undefined
        const token = readCookiePair(request.headers, INTERNAL_COOKIE_NAME)
        return token !== undefined && secretsMatch(token, expected) ? peer : undefined
      },
    })
    return {
      cookie: () => headerCookie,
      refresh: () => headerCookie,
      isInternalRequest: (req) => readCookiePair(req.headers, INTERNAL_COOKIE_NAME) !== undefined,
      dispose: () => {
        if (disposed) return
        disposed = true
        void Promise.resolve(withdraw?.()).catch(() => {})
        void Promise.resolve(peer.dispose?.()).catch(() => {})
      },
    }
  }
  throw new Error('DSH 宿主认证接口无法建立内部会话。')
}

export function fetchUpstreamIndex(port: number, cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, cookie, 'accept-encoding': 'identity' },
      },
      (response) => {
        const status = response.statusCode ?? 502
        if (status !== 200) {
          response.resume()
          reject(Object.assign(new Error(`DSH 宿主首页返回 ${status}`), { status }))
          return
        }
        let html = ''
        response.setEncoding('utf8')
        response.once('error', reject)
        response.on('data', (chunk: string) => {
          html += chunk
        })
        response.once('end', () => resolve(html))
      },
    )
    request.once('error', (failure: NodeJS.ErrnoException) =>
      reject(new Error(failure.code === 'ECONNREFUSED' ? '电脑上的 DSH 没有在监听。' : failure.message)),
    )
    request.setTimeout(10_000, () => request.destroy(new Error('DSH 宿主首页超时。')))
    request.end()
  })
}

export function createQrCache(): (url: string) => Promise<string> {
  let drawn: { url: string; image: string } | undefined
  return async (url: string) => {
    if (drawn?.url !== url) {
      drawn = {
        url,
        image: await (await import('qrcode')).default.toDataURL(url, {
          width: 260,
          margin: 2,
          errorCorrectionLevel: 'M',
        }),
      }
    }
    return drawn.image
  }
}
