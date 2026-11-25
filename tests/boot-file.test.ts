import { expect, it, vi } from 'vitest'
import { openRemoteFile } from '../src/boot-file.js'

class Element extends EventTarget {
  children: Element[] = []
  parent?: Element
  readonly style: Record<string, string> = {}
  readonly attrs = new Map<string, string>()
  id = ''
  textContent = ''
  onclick?: () => void
  href?: string
  download?: string
  constructor(readonly tag: string) { super() }
  setAttribute(name: string, value: string) { this.attrs.set(name, value) }
  append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  prepend(node: Element) { node.parent = this; this.children.unshift(node) }
  insertBefore(node: Element, other: Element) { node.parent = this; this.children.splice(this.children.indexOf(other), 0, node) }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  all(predicate: (node: Element) => boolean): Element[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap(node => node.all(predicate))]
  }
}

function view() {
  const html = new Element('html'), body = new Element('body'), head = new Element('head')
  html.append(head, body)
  return { body, head, documentElement: html, createElement: (tag: string) => new Element(tag), getElementById: (id: string) => body.all(node => node.id === id)[0] ?? null }
}

function fixture(blocked = false) {
  const document = view()
  const popup = Object.assign(new EventTarget(), {
    document: view(), opener: document as unknown, closed: false,
    close: vi.fn(() => { popup.closed = true }),
    location: { replace: vi.fn() },
  })
  const window = Object.assign(new EventTarget(), {
    open: vi.fn(() => blocked ? null : popup),
    location: { href: 'http://carry.test/', assign: vi.fn(), replace: vi.fn() },
  })
  const url = 'blob:http://carry.test/test'
  class PreviewURL extends URL {
    static override createObjectURL = vi.fn((_blob: Blob) => url)
    static override revokeObjectURL = vi.fn()
  }
  let check: (() => void) | undefined
  const stop = vi.fn(() => { check = undefined })
  // Run the emitted function with explicit browser globals. A captured module variable would fail here.
  const run = new Function('window', 'document', 'URL', 'setInterval', 'clearInterval', `return (${openRemoteFile.toString()})`)(window, document, PreviewURL, (fn: () => void) => { check = fn; return 1 }, stop) as typeof openRemoteFile
  const body = blocked ? document.body : popup.document.body
  const statuses = () => body.all(node => node.attrs.get('role') === 'status')
  const buttons = () => body.all(node => node.tag === 'button')
  const links = () => body.all(node => node.tag === 'a')
  return { run, window, popup, url, statuses, buttons, links, stop, urls: PreviewURL, tick: () => check?.() }
}

const address = '/rc/workspace-file?p=C%3A%2Fworkspace%2Freport.txt'

it('opens synchronously, updates from streamed bytes, and retains the Blob until the preview closes', async () => {
  const f = fixture()
  let source!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({ start: controller => { source = controller } }), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': '4' },
  })
  let signal: AbortSignal | null | undefined
  const finished = f.run(address, async (_address, init) => {
    expect(f.popup.opener).toBeNull()
    expect(f.statuses()[0]?.textContent).toBe('正在下载文件…')
    signal = init?.signal
    return response
  }, 'zh')
  expect(f.window.open).toHaveBeenCalledWith('about:blank', '_blank')
  source.enqueue(Uint8Array.of(65))
  await expect.poll(() => f.statuses()[0]?.textContent).toContain('25%')
  expect(f.urls.createObjectURL).not.toHaveBeenCalled()
  source.enqueue(Uint8Array.of(66, 67, 68))
  source.close()
  await finished
  const blob = f.urls.createObjectURL.mock.calls[0]?.[0]
  expect(blob?.type).toBe('text/plain;charset=utf-8')
  expect(await blob?.text()).toBe('ABCD')
  expect(response.body?.locked).toBe(false)
  expect(f.popup.location.replace).toHaveBeenCalledWith(f.url)
  expect(f.urls.revokeObjectURL).not.toHaveBeenCalled()
  expect(signal?.aborted).toBe(false)
  f.popup.closed = true
  f.tick()
  expect(f.urls.revokeObjectURL).toHaveBeenCalledWith(f.url)
  expect(f.stop).toHaveBeenCalledWith(1)
})

it.each(['button', 'popup', 'owner'] as const)('cancels the pending read and releases its lock on %s close', async action => {
  const f = fixture()
  const canceled = vi.fn()
  const response = new Response(new ReadableStream({ cancel: canceled }))
  let signal: AbortSignal | null | undefined
  const finished = f.run(address, async (_address, init) => { signal = init?.signal; return response }, 'zh')
  await expect.poll(() => response.body?.locked).toBe(true)
  if (action === 'button') f.buttons()[0]?.onclick?.()
  else if (action === 'popup') { f.popup.closed = true; f.tick() }
  else f.window.dispatchEvent(new Event('pagehide'))
  await finished
  expect(signal?.aborted).toBe(true)
  expect(canceled).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
  expect(f.statuses()).toHaveLength(0)
  expect(f.urls.createObjectURL).not.toHaveBeenCalled()
  expect(f.stop).toHaveBeenCalledWith(1)
})

it.each([
  { mime: 'text/plain', inline: true },
  { mime: 'text/html', inline: false },
  { mime: 'image/svg+xml', inline: false },
  { mime: 'application/unknown', inline: false },
])('keeps chat when popups are blocked and serves $mime safely', async ({ mime, inline }) => {
  const f = fixture(true)
  const oldSafariResponse = { ok: true, headers: new Headers({ 'content-type': mime }), blob: async () => new Blob(['file'], { type: mime }) } as Response
  await f.run(address, async () => oldSafariResponse, 'en')
  expect(f.statuses()[0]?.textContent).toBe('File ready.')
  expect(f.links().map(link => link.textContent)).toEqual(inline ? ['Open file', 'Download'] : ['Download'])
  expect(f.links().at(-1)?.download).toBe('report.txt')
  expect(f.urls.createObjectURL.mock.calls[0]?.[0].type).toBe(inline ? 'text/plain;charset=utf-8' : 'application/octet-stream')
  expect(f.window.location.assign).not.toHaveBeenCalled()
  expect(f.window.location.replace).not.toHaveBeenCalled()
  f.buttons()[0]?.onclick?.()
  expect(f.statuses()).toHaveLength(0)
  expect(f.urls.revokeObjectURL).toHaveBeenCalledWith(f.url)
})

it('rejects a response over 48 MiB even without Content-Length', async () => {
  const f = fixture(true)
  const canceled = vi.fn(), chunk = new Uint8Array(1024 * 1024)
  const response = new Response(new ReadableStream({ pull: controller => controller.enqueue(chunk), cancel: canceled }))
  await f.run(address, async () => response, 'zh')
  expect(f.statuses()[0]?.textContent).toContain('超过 48 MiB')
  expect(canceled).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
  expect(f.urls.createObjectURL).not.toHaveBeenCalled()
  f.window.dispatchEvent(new Event('pagehide'))
  expect(f.statuses()).toHaveLength(0)
})

it('releases the previous inline preview whether it finished or is still downloading', async () => {
  const f = fixture(true)
  await f.run(address, async () => new Response('first file'), 'en')

  const cancel = vi.fn()
  const pending = new Response(new ReadableStream({ cancel }))
  const download = f.run(address, async () => pending, 'en')
  await expect.poll(() => pending.body?.locked).toBe(true)
  expect(f.urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(f.url)
  expect(f.statuses()).toHaveLength(1)

  await f.run(address, async () => new Response('latest file'), 'en')
  await download
  expect(cancel).toHaveBeenCalledOnce()
  expect(pending.body?.locked).toBe(false)
  expect(f.statuses().map(status => status.textContent)).toEqual(['File ready.'])
})
