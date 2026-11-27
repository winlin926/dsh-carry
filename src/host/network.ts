import type { Context } from '@deepseek-ai/cordis'
import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'

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
  const base = `http://127.0.0.1:${port}/`
  const authenticated = new URL(connection.authenticatedUrl(base))
  let cookie = ''
  connection.authorizeIndex(
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
