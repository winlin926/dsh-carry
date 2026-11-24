import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest, type RequestListener } from 'node:http'
import { Readable, pipeline } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RTCPeerConnection } from 'werift'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
import { bootScript } from '../src/boot.js'
import { DirectHost } from '../src/direct/peer.js'
import { remoteDirect } from '../src/boot-direct.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

/** The phone end of the loop: the shipping boot client, over a real WebRTC channel. */
async function scene(keepAliveMs?: number, fileHandler?: RequestListener) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-e2e-')); cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const seen: string[] = []
  const upstream = createServer((req, res) => {
    seen.push(req.url ?? '')
    if (fileHandler) return fileHandler(req, res)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url }))
  })
  const webSockets = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/socket') { socket.destroy(); return }
    webSockets.handleUpgrade(req, socket, head, client => {
      client.on('message', (data, binary) => client.send(data, { binary }))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { webSockets.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const pairing = new PairingService({ file: join(folder, 'devices.json') })
  const claim = pairing.request(pairing.issue().token, 'Pixel'); pairing.approve(claim.id)
  const credential = pairing.claim(claim.id, claim.key).credential!
  const host = new DirectHost({ port: () => gateway.port, ...(keepAliveMs === undefined ? {} : { keepAliveMs }) })
  cleanup.push(() => host.close())
  let gateway: Gateway
  gateway = new Gateway({
    pairing, upstreamPort: (upstream.address() as { port: number }).port, upstreamCookie: () => 'host-private=secret',
    manage: async () => ({}), index: async () => '<!doctype html><title>Host</title>', boot: () => bootScript(),
    direct: { offer: (deviceId, sdp) => host.offer(deviceId, sdp), resolve: mark => host.mark(mark), closeDevice: id => host.closeDevice(id), preference: () => 'lan' },
  })
  await gateway.listen('127.0.0.1'); cleanup.push(() => gateway.close())
  const origin = 'http://127.0.0.1:' + gateway.port
  // Browsers honour iceServers: []; werift must also disable its built-in public STUN fallback.
  vi.stubGlobal('RTCPeerConnection', class extends RTCPeerConnection {
    constructor() { super({ iceServers: [], iceUseDefaultStunServer: false }) }
  })
  cleanup.push(() => vi.unstubAllGlobals())
  const link = remoteDirect({
    signalPath: '/rc/direct/signal',
    fetch: (path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const payload = String(init?.body ?? '')
      const request = httpRequest({ host: '127.0.0.1', port: gateway.port, method: init?.method ?? 'POST', path: new URL(path, origin).pathname,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), cookie: 'dsh_rc=' + credential, origin, host: '127.0.0.1:' + gateway.port } },
      response => {
        let text = ''; response.setEncoding('utf8')
        response.on('data', chunk => { text += chunk })
        response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : text, { status: response.statusCode, headers: { 'content-type': 'application/json' } })))
      })
      request.on('error', reject); request.end(payload)
    }),
    setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as never,
    clearTimeout: ((handle: never) => clearTimeout(handle)) as never,
    setInterval: ((fn: () => void, ms: number) => setInterval(fn, ms)) as never,
    clearInterval: ((handle: never) => clearInterval(handle)) as never,
    baseUrl: () => origin + '/',
    preference: () => 'lan',
  })
  cleanup.push(() => link.stop())
  return { link, host, gateway, seen, credential }
}

const until = async (predicate: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) { if (Date.now() - started > timeoutMs) throw new Error('等待直连线路超时。'); await new Promise(resolve => setTimeout(resolve, 50)) }
}

describe('direct line end to end', () => {
  it('carries a real Host request over the channel the phone opened', async () => {
    const s = await scene()
    await s.link.start()
    await until(() => s.link.ready)
    expect(s.host.state().filter(channel => channel.connected)).toHaveLength(1)
    const response = await s.link.fetch('/api/hello', { headers: { accept: 'application/json' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: '/api/hello' })
    // The request reached the Host through the loopback bridge, counted on the direct line.
    expect(s.seen).toContain('/api/hello')
    expect(s.host.state()[0]!.stats.requests).toBe(1)
  }, 40_000)

  it('carries standards-compliant WebSocket messages and browser events over the channel', async () => {
    const s = await scene()
    await s.link.start()
    await until(() => s.link.ready)
    const socket = s.link.socket('ws://127.0.0.1:' + s.gateway.port + '/api/socket', ['echo.v1']) as WebSocket
    const message = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket echo timed out')), 5000)
      socket.addEventListener('open', () => {
        expect(socket.protocol).toBe('echo.v1')
        socket.send('direct channel message '.repeat(1200))
      }, { once: true })
      socket.addEventListener('message', event => { clearTimeout(timeout); resolve(event.data) }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed')) }, { once: true })
    })
    expect(await message).toBe('direct channel message '.repeat(1200))
    socket.close()
    expect(s.host.state()[0]!.stats.sockets).toBe(1)
  }, 40_000)

  it('keeps the same chat socket and RTC session through 20 MiB uploads, downloads and cancellations', async () => {
    const file = Buffer.allocUnsafe(20 * 1024 * 1024)
    for (let i = 0; i < file.length; i += 4) file.writeUInt32LE(i, i)
    const expected = createHash('sha256').update(file).digest('hex')
    const uploadTail = Promise.withResolvers<void>(), downloadTail = Promise.withResolvers<void>()
    const chunkSize = 64 * 1024
    async function* chunks(tail: Promise<void>) {
      yield file.subarray(0, chunkSize)
      await tail
      for (let i = chunkSize; i < file.length; i += chunkSize) yield file.subarray(i, i + chunkSize)
    }
    let uploaded = 0, cancelUploadStarted = false, uploadAborted = false, downloadAborted = false
    const s = await scene(undefined, (req, res) => {
      if (req.url === '/file' && req.method === 'POST') {
        const hash = createHash('sha256')
        req.on('data', (part: Buffer) => { uploaded += part.length; hash.update(part) })
        req.on('end', () => res.end(hash.digest('hex')))
      } else if (req.url === '/file') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.length })
        pipeline(Readable.from(chunks(downloadTail.promise), { objectMode: false }), res, error => { if (error) res.destroy(error) })
      } else if (req.url === '/cancel-upload') {
        req.on('data', () => { cancelUploadStarted = true })
        req.on('aborted', () => { uploadAborted = true })
      } else if (req.url === '/cancel-download') {
        res.once('close', () => { downloadAborted = !res.writableEnded })
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(file.subarray(0, chunkSize))
      } else { res.writeHead(404); res.end() }
    })
    cleanup.push(() => { uploadTail.resolve(); downloadTail.resolve() })
    await s.link.start()
    await until(() => s.link.ready)
    const sessionId = s.link.state().session
    expect(sessionId).toBeTruthy()
    const socket = s.link.socket('ws://127.0.0.1:' + s.gateway.port + '/api/socket')
    await until(() => socket.readyState === 1)
    const echo = async (text: string) => {
      const reply = once(socket, 'message', { signal: AbortSignal.timeout(10_000) })
      socket.send(text)
      expect((await reply)[0].data).toBe(text)
      expect(s.host.state().filter(peer => peer.connected).map(peer => peer.sessionId)).toEqual([sessionId])
      expect(s.link.state().session).toBe(sessionId)
    }

    // The receiver must observe the first bytes before the sender releases the rest.
    const body = Readable.toWeb(Readable.from(chunks(uploadTail.promise), { objectMode: false })) as ReadableStream<Uint8Array>
    const init = { method: 'POST', body, duplex: 'half' }
    const [upload] = await Promise.all([s.link.fetch('/file', init), (async () => {
      try {
        await until(() => uploaded > 0)
        expect(uploaded).toBeLessThan(file.length)
        await echo('during upload')
      } finally { uploadTail.resolve() }
    })()])
    expect(upload.status).toBe(200)
    expect(await upload.text()).toBe(expected)
    expect(uploaded).toBe(file.length)

    const download = await s.link.fetch('/file')
    expect(download.status).toBe(200)
    const reader = download.body!.getReader(), hash = createHash('sha256')
    const first = await reader.read()
    expect(first.value?.length).toBeGreaterThan(0)
    hash.update(first.value!)
    await echo('during download')
    downloadTail.resolve()
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      hash.update(part.value)
    }
    expect(hash.digest('hex')).toBe(expected)

    const abort = new AbortController()
    let sourceCancelled = false
    const partial = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(file.subarray(0, chunkSize)) },
      cancel() { sourceCancelled = true },
    })
    const cancelInit = { method: 'POST', body: partial, duplex: 'half', signal: abort.signal }
    const cancelled = expect(s.link.fetch('/cancel-upload', cancelInit)).rejects.toMatchObject({ name: 'AbortError' })
    await until(() => cancelUploadStarted)
    abort.abort()
    await cancelled
    await until(() => uploadAborted && sourceCancelled)
    await echo('after upload cancellation')

    const unfinished = (await s.link.fetch('/cancel-download')).body!.getReader()
    expect((await unfinished.read()).value?.length).toBeGreaterThan(0)
    await unfinished.cancel()
    await until(() => downloadAborted)
    await echo('after download cancellation')
    socket.close()
  }, 180_000)

  it('resets the Host keepalive only after receiving its matching pong', async () => {
    const s = await scene(80)
    await s.link.start()
    await until(() => s.link.ready)
    const initial = s.host.state().find(item => item.connected)?.sessionId
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(s.host.state().find(item => item.connected)?.sessionId).toBe(initial)
  }, 40_000)

  it('refuses a direct channel for a device that was just revoked', async () => {
    const s = await scene()
    await s.link.start()
    await until(() => s.link.ready)
    s.gateway.revoke(s.host.state()[0]!.deviceId)
    await until(() => s.host.state().length === 0, 5_000)
    expect(s.host.state()).toHaveLength(0)
  }, 40_000)
})
