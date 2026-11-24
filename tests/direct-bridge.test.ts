import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
import { bootScript } from '../src/boot.js'
import { DirectBridge } from '../src/direct/bridge.js'
import { controlPayload, decodeDirectFrame, encodeDirectFrame, type DirectFrame } from '../src/direct/protocol.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

/** One fake DataChannel: frames delivered to the bridge, and everything the bridge sends back. */
function channel() {
  const out: DirectFrame[] = []
  let deliver: ((data: Uint8Array) => void) | undefined
  let holding = false, queued = 0, low = 0
  let drained: (() => void) | undefined
  return {
    out,
    hold() { holding = true },
    drain(to = 0, keepHolding = false) {
      const previous = queued
      queued = to
      holding = keepHolding
      if (previous > low && to <= low) drained?.()
    },
    transport: {
      get bufferedAmount() { return queued },
      onBufferedAmountLow(threshold: number, listener: () => void) {
        low = threshold
        drained = listener
        return () => { drained = undefined }
      },
      send(data: Uint8Array) { if (holding) queued += data.length; out.push(decodeDirectFrame(data)) },
      close() {},
    },
    wire: (handle: { handle: (data: Uint8Array) => void }) => { deliver = handle.handle },
    send: (frame: DirectFrame) => { if (!deliver) throw new Error('channel not attached'); deliver(encodeDirectFrame(frame)) },
    async until(predicate: (frames: DirectFrame[]) => boolean, timeoutMs = 4000) {
      const started = Date.now()
      while (!predicate(out)) {
        if (Date.now() - started > timeoutMs) throw new Error('等待直连帧超时：' + JSON.stringify(out.map(frame => frame.t)))
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return out
    },
  }
}

async function fixture(mark = 'mark-1', requestTimeoutMs?: number) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-direct-')); cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const seen: Array<{ path: string; cookie?: string; body: number }> = []
  const pairing = new PairingService({ file: join(folder, 'devices.json') })
  const claim = pairing.request(pairing.issue().token, 'Android'); pairing.approve(claim.id)
  const credential = pairing.claim(claim.id, claim.key).credential!
  const deviceId = pairing.list()[0]!.id
  const upstream = createServer((req, res) => {
    let size = 0
    req.on('data', chunk => { size += chunk.length })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', cookie: req.headers.cookie, body: size })
      if (req.url === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('id: 1\ndata: 第一条\n\n')
        setTimeout(() => { res.write('id: 2\ndata: 第二条\n\n'); res.end() }, 800)
        return
      }
      res.setHeader('set-cookie', 'host-secret=never')
      res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null, size }))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const upstreamPort = (upstream.address() as { port: number }).port
  let gateway: Gateway
  gateway = new Gateway({
    pairing, upstreamPort, upstreamCookie: () => 'host-private=secret',
    manage: async () => ({}),
    index: async () => '<!doctype html><title>Host</title>',
    boot: () => bootScript(),
    direct: { offer: async () => ({ sessionId: 'unused', sdp: '' }), resolve: value => value === mark ? deviceId : undefined },
  })
  await gateway.listen('127.0.0.1'); cleanup.push(() => gateway.close())
  const bridge = new DirectBridge({ port: () => gateway.port, mark: () => mark, requestTimeoutMs })
  const wire = channel()
  const session = bridge.attach(wire.transport)
  cleanup.push(session.dispose)
  wire.wire(session)
  return { upstream, gateway, bridge, wire, session, deviceId, credential, seen, folder }
}

const open = (wire: ReturnType<typeof channel>, id: string, method: string, path: string, headers: Record<string, string> = {}) =>
  wire.send({ t: 'open', id, payload: controlPayload({ method, path, headers }) })

describe('direct bridge', () => {
  it('opens a direct SVG preview at a sandboxed capability URL', async () => {
    const f = await fixture()
    const image = join(f.folder, 'preview.svg')
    writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    open(f.wire, 'resolve', 'GET', '/rc/workspace-file?p=' + encodeURIComponent(image) + '&preview=1')
    const frames = await f.wire.until(items => items.some(frame => frame.id === 'resolve' && frame.t === 'done'))
    const resolved = JSON.parse(Buffer.from(frames.find(frame => frame.id === 'resolve' && frame.t === 'result')!.payload).toString())
    expect(resolved.status).toBe(303)
    expect(resolved.headers.location).toMatch(/^\/rc\/workspace-preview\/.+\/preview\.svg$/)
    open(f.wire, 'preview', 'GET', resolved.headers.location)
    const preview = await f.wire.until(items => items.some(frame => frame.id === 'preview' && frame.t === 'done'))
    const result = JSON.parse(Buffer.from(preview.find(frame => frame.id === 'preview' && frame.t === 'result')!.payload).toString())
    expect(result).toMatchObject({ status: 200, headers: { 'content-security-policy': 'sandbox' } })
  })

  it('carries a Host response over frames, admitted by the channel mark alone', async () => {
    const f = await fixture()
    open(f.wire, 'r1', 'GET', '/api/hello', { accept: 'application/json' })
    const frames = await f.wire.until(list => list.some(frame => frame.t === 'done'))
    const result = JSON.parse(Buffer.from(frames.find(frame => frame.t === 'result')!.payload).toString())
    expect(result.status).toBe(200)
    const body = Buffer.concat(frames.filter(frame => frame.t === 'chunk').map(frame => Buffer.from(frame.payload))).toString()
    expect(JSON.parse(body)).toMatchObject({ path: '/api/hello', size: 0 })
    // The device's own cookie never travels inward: the Host sees only the gateway's session cookie,
    // and the Host's own set-cookie never travels back out to the phone.
    expect(JSON.parse(body).cookie).toBe('host-private=secret')
    expect(JSON.stringify(result.headers)).not.toContain('host-secret')
    // The request did reach the Host, and it was counted on the direct line.
    expect(f.seen.map(entry => entry.path)).toEqual(['/api/hello'])
    expect(f.bridge.snapshot().requests).toBe(1)
    expect(f.session).toBeDefined()
  })

  it('keeps an idle event stream live past the request budget and delivers its later event', async () => {
    const f = await fixture('mark-1', 400)
    open(f.wire, 'r2', 'GET', '/api/stream')
    await f.wire.until(list => list.some(frame => frame.t === 'done' || frame.t === 'fail'))
    const chunks = f.wire.out.filter(frame => frame.t === 'chunk').map(frame => Buffer.from(frame.payload).toString())
    expect(chunks.join('')).toContain('第一条')
    expect(chunks.join('')).toContain('第二条')
    expect(f.wire.out.at(-1)!.t).toBe('done')
  })

  it('streams a request body inward and reports its size to the Host', async () => {
    const f = await fixture()
    open(f.wire, 'r3', 'POST', '/api/upload', { 'content-type': 'application/octet-stream' })
    const payload = new Uint8Array(40_000).fill(7)
    for (let offset = 0; offset < payload.length; offset += 16 * 1024) f.wire.send({ t: 'body', id: 'r3', payload: payload.subarray(offset, offset + 16 * 1024) })
    f.wire.send({ t: 'end', id: 'r3', payload: new Uint8Array() })
    await f.wire.until(list => list.some(frame => frame.t === 'done'))
    const body = Buffer.concat(f.wire.out.filter(frame => frame.t === 'chunk').map(frame => Buffer.from(frame.payload))).toString()
    expect(JSON.parse(body).size).toBe(40_000)
  })

  it('pauses files at high water, keeps control frames live and resumes just the remaining request at low water', async () => {
    const { wire, folder } = await fixture()
    const data = Buffer.alloc(512 * 1024 + 37)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >>> 12)) & 255
    const path = join(folder, 'payload.bin')
    writeFileSync(path, data)
    const url = '/rc/workspace-file?p=' + encodeURIComponent(path)
    wire.hold()
    open(wire, 'file', 'GET', url)
    await wire.until(() => wire.transport.bufferedAmount >= 128 * 1024)
    const held = wire.out.filter(frame => frame.t === 'chunk').length
    expect(wire.transport.bufferedAmount).toBeLessThan(145 * 1024)
    open(wire, 'other', 'GET', url)
    await wire.until(frames => frames.some(frame => frame.id === 'other' && frame.t === 'result'))
    wire.send({ t: 'cancel', id: 'other', payload: new Uint8Array() })
    wire.send({ t: 'ping', id: 'alive', payload: controlPayload({}) })
    expect(wire.out.at(-1)).toMatchObject({ id: 'alive', t: 'pong' })
    wire.drain(32 * 1024 + 1, true)
    expect(wire.out.filter(frame => frame.t === 'chunk')).toHaveLength(held)
    wire.drain(32 * 1024)
    await wire.until(frames => frames.some(frame => frame.id === 'file' && frame.t === 'done'))
    expect(wire.out.filter(frame => frame.id === 'other').map(frame => frame.t)).toEqual(['result'])
    expect(Buffer.concat(wire.out.filter(frame => frame.id === 'file' && frame.t === 'chunk').map(frame => frame.payload)).equals(data)).toBe(true)
  })

  it('preserves a short message on another socket when a large message does not fit', async () => {
    const { wire, upstream } = await fixture()
    const server = new WebSocketServer({ server: upstream })
    cleanup.push(() => { for (const socket of server.clients) socket.terminate(); server.close() })
    const clients = new Map<string, WebSocket>()
    server.on('connection', (socket, req) => clients.set(req.url!, socket))
    for (const id of ['bulk', 'chat']) {
      wire.send({ t: 'ws.open', id, payload: controlPayload({ path: '/api/socket/' + id }) })
    }
    await wire.until(frames => frames.filter(frame => frame.t === 'ws.ack').length === 2)

    wire.drain(16 * 1024 * 1024 - 129 * 1024, true)
    clients.get('/api/socket/bulk')!.send(Buffer.alloc(48 * 1024))
    await wire.until(frames => frames.some(frame => frame.id === 'bulk' && frame.t === 'ws.close'))
    const message = 'x'.repeat(2 * 1024)
    clients.get('/api/socket/chat')!.send(message)
    const frames = await wire.until(items => items.some(frame => frame.id === 'chat' && (frame.t === 'ws.text' || frame.t === 'ws.close')))
    const reply = frames.find(frame => frame.id === 'chat' && frame.t !== 'ws.ack')!
    expect(reply.t).toBe('ws.text')
    expect(Buffer.from(reply.payload.subarray(1)).toString()).toBe(message)
    expect(frames.filter(frame => frame.id === 'bulk').map(frame => frame.t)).toEqual(['ws.ack', 'ws.close'])
    wire.send({ t: 'ping', id: 'alive', payload: controlPayload({}) })
    expect(wire.out.at(-1)).toMatchObject({ id: 'alive', t: 'pong' })
  })

  it('times out a stalled file by ID and still accepts requests on the channel', async () => {
    const { wire, folder } = await fixture('mark-1', 250)
    const path = join(folder, 'stalled.bin')
    writeFileSync(path, Buffer.alloc(256 * 1024))
    wire.hold()
    open(wire, 'stalled', 'GET', '/rc/workspace-file?p=' + encodeURIComponent(path))
    await wire.until(() => wire.transport.bufferedAmount >= 128 * 1024)
    const failure = (await wire.until(frames => frames.some(frame => frame.id === 'stalled' && frame.t === 'fail'))).find(frame => frame.t === 'fail')!
    expect(JSON.parse(Buffer.from(failure.payload).toString()).code).toBe('TIMEOUT')
    wire.drain()
    open(wire, 'ok', 'GET', '/api/hello')
    await wire.until(frames => frames.some(frame => frame.id === 'ok' && frame.t === 'done'))
    expect(wire.out.filter(frame => frame.id === 'stalled').at(-1)?.t).toBe('fail')
  })

  it('renews the request deadline while an upload makes progress', async () => {
    const { wire } = await fixture('mark-1', 400)
    open(wire, 'slow', 'POST', '/api/upload')
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 110))
      wire.send({ t: 'body', id: 'slow', payload: new Uint8Array([i]) })
    }
    wire.send({ t: 'end', id: 'slow', payload: new Uint8Array() })
    const frames = await wire.until(items => items.some(frame => frame.t === 'done' || frame.t === 'fail'))
    expect(frames.at(-1)?.t).toBe('done')
    expect(JSON.parse(Buffer.concat(frames.filter(frame => frame.t === 'chunk').map(frame => frame.payload)).toString()).size).toBe(5)
  })

  it('refuses a channel whose mark is not bound to a live device', async () => {
    const f = await fixture('mark-1')
    const stranger = new DirectBridge({ port: () => f.gateway.port, mark: () => 'forged' })
    const wire = channel()
    wire.wire(stranger.attach(wire.transport))
    open(wire, 'r4', 'GET', '/api/hello')
    const answer = (await wire.until(list => list.some(frame => frame.t === 'fail' || frame.t === 'result'))).find(frame => frame.t === 'result' || frame.t === 'fail')!
    expect(answer.t).toBe('result')
    expect(JSON.parse(Buffer.from(answer.payload).toString()).status).toBe(403)
  })
})
