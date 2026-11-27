import { existsSync, readFileSync } from 'node:fs'
import type { BootContext } from './boot/types.js'

export type { BootContext, BootDirect, LanFallback } from './boot/types.js'

let cachedBootBundle: string | undefined

function readBootBundle(): string {
  if (cachedBootBundle !== undefined) return cachedBootBundle
  const candidates = [new URL('./boot.js', import.meta.url), new URL('../lib/boot.js', import.meta.url)]
  for (const url of candidates) {
    if (existsSync(url)) {
      cachedBootBundle = readFileSync(url, 'utf8')
      return cachedBootBundle
    }
  }
  throw new Error('缺少远程启动脚本产物 lib/boot.js，请先构建插件。')
}

/** The Host serves the compiled boot runtime as a self-contained browser script. */
export function bootScript(context?: BootContext): string {
  return `${readBootBundle()}\n__dshBootBundle.runRemoteBoot(${JSON.stringify(context ?? null)});`
}

/** The boot script is a same-origin file, not an inline script, so a Host CSP cannot block it. */
export const BOOT_PATH = '/rc/boot.js'
const BOOT_TAG = `<script src="${BOOT_PATH}"></script>`

export function injectBoot(html: string): string {
  // Host injections precede the original viewport; the transport must precede them too.
  if (!/<head(?:\s[^>]*)?>/i.test(html)) return html
  const viewport = /<meta\b[^>]*\bname=["']viewport["'][^>]*>/i.exec(html)
  const body = viewport ? html.slice(0, viewport.index) + html.slice(viewport.index + viewport[0].length) : html
  return body.replace(
    /<head(?:\s[^>]*)?>/i,
    (match) =>
      `${match}${viewport?.[0] ?? '<meta name="viewport" content="width=device-width, initial-scale=1">'}${BOOT_TAG}`,
  )
}
