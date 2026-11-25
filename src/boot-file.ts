/** Serialized into the gateway boot script. The caller supplies a validated ordinary-file URL. */
export async function openRemoteFile(address: string, fetchFile: typeof fetch, language: 'zh' | 'en'): Promise<void> {
  let popup: Window | null = null
  let view = document
  try {
    popup = window.open('about:blank', '_blank')
    if (popup) {
      popup.opener = null
      view = popup.document
    }
  } catch {
    popup?.close()
    popup = null
  }

  const en = language === 'en'
  const name = new URL(address, window.location.href).searchParams.get('p')?.split(/[\\/]/).pop() || 'file'
  const loading = en ? 'Downloading file…' : '正在下载文件…'
  const tooLarge = en ? 'This file exceeds 48 MiB. Open it on the computer.' : '文件超过 48 MiB，请在电脑上打开。'
  const failed = en ? 'Could not open the file. Check the connection to the computer.' : '无法打开文件，请检查与电脑的连接。'
  const close = en ? 'Close' : '关闭'
  const limit = 48 * 1024 * 1024
  const container = view.body ?? view.documentElement
  const panel = view.createElement('section')
  panel.setAttribute('aria-label', en ? 'File preview' : '文件预览')
  panel.style.cssText = 'display:grid;gap:8px;padding:16px;background:var(--dsw-alias-background-primary,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,GrayText);border-radius:12px;font:14px/1.5 system-ui;overflow-wrap:anywhere'
  const title = view.createElement('strong')
  title.textContent = name
  const status = view.createElement('div')
  status.setAttribute('role', 'status')
  status.textContent = loading
  const progress = view.createElement('progress')
  progress.setAttribute('aria-label', loading)
  progress.style.width = '100%'
  const actions = view.createElement('div')
  actions.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:12px;min-height:44px'
  const dismiss = view.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = en ? 'Cancel' : '取消'
  dismiss.style.minHeight = '44px'
  actions.append(dismiss)
  panel.append(title, status, progress, actions)

  let stack: HTMLElement | null = null
  if (popup) {
    view.title = name
    view.documentElement.lang = en ? 'en' : 'zh-CN'
    view.documentElement.style.colorScheme = 'light dark'
    const viewport = view.createElement('meta')
    viewport.name = 'viewport'
    viewport.content = 'width=device-width, initial-scale=1'
    view.head.append(viewport)
    panel.style.cssText += ';max-width:480px;margin:24px auto'
    container.append(panel)
  } else {
    stack = view.getElementById('dsh-rc-file-previews')
    if (!stack) {
      stack = view.createElement('div')
      stack.id = 'dsh-rc-file-previews'
      stack.style.cssText = 'position:fixed;z-index:2147483646;inset-inline-end:12px;bottom:max(12px,env(safe-area-inset-bottom));width:min(360px,calc(100vw - 24px));max-height:50vh;overflow:auto;display:grid;gap:8px'
      container.append(stack)
    }
    stack.append(panel)
  }

  const transfer = new AbortController()
  let body: Response['body']
  let reader: ReturnType<NonNullable<Response['body']>['getReader']> | undefined
  let objectUrl: string | undefined
  let closed = false
  const stopTransfer = () => {
    transfer.abort()
    void (reader ? reader.cancel() : body?.cancel())?.catch(() => {})
  }
  const dispose = () => {
    if (closed) return
    closed = true
    stopTransfer()
    clearInterval(checkClosed)
    window.removeEventListener('pagehide', dispose)
    popup?.removeEventListener('pagehide', dispose)
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    panel.remove()
    if (stack && !stack.childElementCount) stack.remove()
    popup?.close()
  }
  const checkClosed = popup ? setInterval(() => { if (popup.closed) dispose() }, 500) : undefined
  window.addEventListener('pagehide', dispose)
  popup?.addEventListener('pagehide', dispose)
  dismiss.onclick = dispose

  try {
    const response = await fetchFile(address, { cache: 'no-store', redirect: 'error', signal: transfer.signal })
    body = response.body
    if (closed) {
      void body?.cancel().catch(() => {})
      return
    }
    if (!response.ok) throw new Error(response.status === 413 ? tooLarge : failed)
    const size = Number(response.headers.get('content-length'))
    if (size > limit) throw new Error(tooLarge)
    const total = size > 0 && !response.headers.get('content-encoding') ? size : undefined
    if (total) progress.max = total

    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    // Keep executable and unknown documents out of the gateway's Blob URL origin.
    const text = ['text/plain', 'text/csv', 'application/json'].includes(mime)
    const media = /^(?:image\/(?:png|jpeg|gif|webp|x-icon|avif|bmp)|video\/(?:mp4|webm|quicktime)|audio\/(?:mpeg|wav|ogg|mp4)|application\/pdf)$/.test(mime)
    const inline = (text || media) && !/^\s*attachment\b/i.test(response.headers.get('content-disposition') ?? '')
    const type = inline ? text ? 'text/plain;charset=utf-8' : mime : 'application/octet-stream'
    let blob: Blob
    if (typeof body?.getReader === 'function') {
      const streamReader = body.getReader()
      reader = streamReader
      const chunks: BlobPart[] = []
      let received = 0
      let lastUpdate = -Infinity
      while (true) {
        const { done, value } = await streamReader.read()
        if (closed) return
        if (done) break
        received += value.byteLength
        if (received > limit) throw new Error(tooLarge)
        chunks.push(value)
        const now = performance.now()
        if (now - lastUpdate < 125) continue
        lastUpdate = now
        if (total) progress.value = received
        const amount = received < 1024 * 1024 ? `${(received / 1024).toFixed(1)} KiB` : `${(received / 1024 / 1024).toFixed(1)} MiB`
        status.textContent = total ? `${loading} ${Math.min(100, Math.floor(received / total * 100))}%` : `${loading} ${amount}`
      }
      blob = new Blob(chunks, { type })
    } else {
      const received = await response.blob()
      if (closed) return
      if (received.size > limit) throw new Error(tooLarge)
      blob = received.slice(0, received.size, type)
    }

    objectUrl = URL.createObjectURL(blob)
    progress.remove()
    dismiss.textContent = close
    status.textContent = en ? 'File ready.' : '文件已就绪。'
    if (inline) {
      const open = view.createElement('a')
      open.href = objectUrl
      open.target = '_blank'
      open.rel = 'noopener noreferrer'
      open.textContent = en ? 'Open file' : '打开文件'
      actions.prepend(open)
    }
    const download = view.createElement('a')
    download.href = objectUrl
    download.download = name
    download.textContent = en ? 'Download' : '下载'
    actions.insertBefore(download, dismiss)
    if (inline && popup) {
      popup.removeEventListener('pagehide', dispose)
      try { popup.location.replace(objectUrl) }
      catch { popup.addEventListener('pagehide', dispose) }
    }
  } catch (error) {
    if (!closed) {
      stopTransfer()
      progress.remove()
      status.textContent = error instanceof Error && error.message === tooLarge ? tooLarge : failed
      dismiss.textContent = close
    }
  } finally {
    reader?.releaseLock()
    reader = undefined
    body = null
  }
}
