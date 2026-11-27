import { openRemoteFile } from '../boot-file.js'
import type { remoteDirect } from '../boot-direct.js'
import { localFilePath } from '../local-file.js'
import type { SayFn } from './types.js'

export function showNotice(message: string): void {
  const existing = document.getElementById('dsh-rc-notice')
  if (existing) existing.remove()
  const toast = document.createElement('div')
  toast.id = 'dsh-rc-notice'
  toast.setAttribute('role', 'status')
  toast.style.cssText =
    'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;max-width:min(86vw,420px);padding:10px 16px;border-radius:999px;background:#242938;color:#fff;font:13px/1.6 system-ui,sans-serif;text-align:center;box-shadow:0 8px 28px #00000047'
  toast.textContent = message
  ;(document.body ?? document.documentElement).append(toast)
  setTimeout(() => toast.remove(), 2600)
}

export function installFileLinkInterceptor(options: {
  link: ReturnType<typeof remoteDirect> | undefined
  language: 'zh' | 'en'
  say: SayFn
}): void {
  const { link, language, say } = options

  /** Open computer files on the remote device instead of invoking the Desktop handler. */
  async function openLocalFile(href: string): Promise<void> {
    const path = localFilePath(href)
    if (!path) {
      showNotice(say('链接不是本机文件路径。', 'This is not a local file link.'))
      return
    }
    const address = `/rc/workspace-file?p=${encodeURIComponent(path)}`
    if (/\.html?$/i.test(path) || /\.svg$/i.test(path)) {
      // These documents keep the gateway's sandbox CSP. A blob would drop that header.
      if (link?.line === 'direct' && navigator.serviceWorker?.controller) {
        const preview = window.open('about:blank', '_blank')
        if (preview) preview.opener = null
        try {
          const response = await link.fetch(`${address}&preview=1`)
          const locationHeader = response.headers.get('location')
          const target = locationHeader && new URL(locationHeader, location.href)
          if (
            response.status !== 303 ||
            !target ||
            target.origin !== location.origin ||
            !target.pathname.startsWith('/rc/workspace-preview/')
          ) {
            throw new Error('Invalid preview')
          }
          if (preview) preview.location.replace(target.href)
          else location.assign(target.href)
        } catch {
          preview?.close()
          showNotice(say('无法打开文件预览。', 'Could not open the file preview.'))
        }
        return
      }
      const preview = window.open(address, '_blank')
      if (preview) preview.opener = null
      else location.assign(address)
      return
    }
    await openRemoteFile(address, window.fetch, language)
  }

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!/^file:/i.test(href)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void openLocalFile(anchor.href)
    },
    true,
  )
}
