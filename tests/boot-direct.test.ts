import { afterEach, describe, expect, it, vi } from 'vitest'
import { remoteDirect } from '../src/boot-direct.js'

/** One fake DataChannel: what the page sends, and a way to hand frames back. */
function fakePeer() {
  const sent: Array<{ t: number; id: string; payload: Uint8Array }> = []
  const events = new EventTarget()
  const channel = {
    readyState: 'connecting' as string,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    drain() {
      this.bufferedAmount = 0
      events.dispatchEvent(new Event('bufferedamountlow'))
    },
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    send(data: Uint8Array) {
      this.bufferedAmount += data.byteLength
      sent.push({ t: data[0]!, id: '', payload: data })
    },
    close() {
      this.readyState = 'closed'
    },
  }
  class Peer {
    iceGatheringState = 'complete'
    localDescription: { sdp: string } | null = null
    createDataChannel() {
      return channel
    }
    addEventListener() {}
    removeEventListener() {}
    async createOffer() {
      return { type: 'offer', sdp: 'v=0' }
    }
    async setLocalDescription() {
      this.localDescription = { sdp: 'v=0\r\n' }
    }
    async setRemoteDescription() {}
    close() {}
  }
  ;(globalThis as Record<string, unknown>).RTCPeerConnection = Peer as never
  return { channel, sent }
}

const TYPES = [
  'open',
  'body',
  'end',
  'result',
  'chunk',
  'done',
  'fail',
  'cancel',
  'ws.open',
  'ws.ack',
  'ws.text',
  'ws.bin',
  'ws.cont',
  'ws.close',
  'ping',
  'pong',
  'hello',
]
const encode = (t: string, id: string, payload: Uint8Array) => {
  const out = new Uint8Array(3 + id.length + payload.length)
  out[0] = TYPES.indexOf(t) + 1
  out[1] = id.length >> 8
  out[2] = id.length & 0xff
  for (let i = 0; i < id.length; i++) out[3 + i] = id.charCodeAt(i)
  out.set(payload, 3 + id.length)
  return out
}
const control = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const readId = (bytes: Uint8Array) => {
  const length = (bytes[1]! << 8) | bytes[2]!
  let id = ''
  for (let i = 0; i < length; i++) id += String.fromCharCode(bytes[3 + i]!)
  return id
}
const readType = (bytes: Uint8Array) => TYPES[bytes[0]! - 1]!

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const healthy = () => new Response(null, { status: 204 })

async function connectedPhone() {
  const { channel, sent } = fakePeer()
  const get = vi.fn(async () => healthy())
  const link = remoteDirect({
    signalPath: '/rc/direct/signal',
    baseUrl: () => 'https://phone.test/',
    preference: () => 'public',
    fetch: async (_input, init) => (init?.method === 'POST' ? Response.json({ sessionId: 's', sdp: 'v=0' }) : get()),
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
  })
  const frames = (type: string) => sent.map(({ payload }) => payload).filter((bytes) => readType(bytes) === type)
  const receive = (type: string, id: string, data = new Uint8Array()) =>
    channel.onmessage?.({ data: encode(type, id, data).buffer as ArrayBuffer })
  await link.start()
  channel.readyState = 'open'
  channel.onopen?.()
  receive('pong', readId(frames('ping')[0]!))
  await link.probe()
  return { channel, link, get, frames, receive }
}

describe('phone direct client', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).RTCPeerConnection
  })

  it('opens only after a probe answers, then carries a whole request over the channel', async () => {
    const peer = fakePeer()
    const created = remoteDirect({
      signalPath: '/rc/direct/signal',
      baseUrl: () => 'http://127.0.0.1:18443/',
      preference: () => 'lan',
      fetch: async (_input, init) =>
        init?.method === 'GET'
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ sessionId: 's-1', sdp: 'v=0' }), { status: 200 }),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as never,
      clearTimeout: (handle) => clearTimeout(handle),
      setInterval: () => 0 as never,
      clearInterval: () => {},
    })
    await created.start()
    expect(created.ready).toBe(false)
    peer.channel.readyState = 'open'
    peer.channel.onopen?.()
    await settle()
    const hello = peer.sent.find((frame) => readType(frame.payload) === 'hello')
    expect(hello).toBeDefined()
    // A pong for the probe is what makes the line usable; a channel that merely exists is not.
    peer.channel.onmessage?.({
      data: encode(
        'pong',
        readId(peer.sent.find((frame) => readType(frame.payload) === 'ping')!.payload),
        new Uint8Array(),
      ).buffer as ArrayBuffer,
    })
    expect(created.ready).toBe(true)
    expect(created.line).toBe('direct')
    const pending = created.fetch('/api/hello?x=1', { method: 'POST', body: 'body-bytes' })
    await settle()
    const open = peer.sent.find((frame) => readType(frame.payload) === 'open')!
    expect(readId(open.payload)).toBeTruthy()
    const requestId = readId(open.payload)
    peer.channel.onmessage?.({
      data: encode('result', requestId, control({ status: 200, headers: { 'content-type': 'text/plain' } }))
        .buffer as ArrayBuffer,
    })
    peer.channel.onmessage?.({
      data: encode('chunk', requestId, new TextEncoder().encode('hello ')).buffer as ArrayBuffer,
    })
    peer.channel.onmessage?.({
      data: encode('chunk', requestId, new TextEncoder().encode('world')).buffer as ArrayBuffer,
    })
    peer.channel.onmessage?.({ data: encode('done', requestId, new Uint8Array()).buffer as ArrayBuffer })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello world')
  })

  it('goes back to the upstream line when the channel closes', async () => {
    const peer = fakePeer()
    const created = remoteDirect({
      signalPath: '/rc/direct/signal',
      baseUrl: () => 'http://127.0.0.1:18443/',
      preference: () => 'lan',
      fetch: async (_input, init) =>
        init?.method === 'GET'
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ sessionId: 's', sdp: 'v=0' }), { status: 200 }),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as never,
      clearTimeout: (handle) => clearTimeout(handle),
      setInterval: () => 0 as never,
      clearInterval: () => {},
    })
    await created.start()
    peer.channel.readyState = 'open'
    peer.channel.onopen?.()
    peer.channel.onmessage?.({
      data: encode(
        'pong',
        readId(peer.sent.find((frame) => readType(frame.payload) === 'ping')!.payload),
        new Uint8Array(),
      ).buffer as ArrayBuffer,
    })
    expect(created.line).toBe('direct')
    peer.channel.onclose?.()
    expect(created.ready).toBe(false)
    expect(created.line).toBe('upstream')
    created.stop()
  })

  it('reuses recent fast probes even during a background check, then joins one fresh probe', async () => {
    vi.useFakeTimers()
    const { get, link } = await connectedPhone()
    const background = Promise.withResolvers<Response>()
    try {
      const started = Date.now()
      get.mockImplementationOnce(() => background.promise)
      const heartbeat = link.probe()
      for (let i = 0; i < 3; i++) expect(await link.preferDirectForWrite()).toBe(false)
      expect(get).toHaveBeenCalledTimes(2) // initial + background, independent of the three writes
      background.resolve(healthy())
      await heartbeat
      vi.setSystemTime(started + 4999)
      expect(await link.preferDirectForWrite()).toBe(false)
      expect(get).toHaveBeenCalledTimes(2)
      vi.setSystemTime(started + 5000)
      const fresh = Promise.withResolvers<Response>()
      get.mockImplementationOnce(() => fresh.promise)
      const writes = [link.preferDirectForWrite(), link.preferDirectForWrite()]
      expect(get).toHaveBeenCalledTimes(3)
      fresh.resolve(healthy())
      expect(await Promise.all(writes)).toEqual([false, false])
    } finally {
      link.stop()
      vi.useRealTimers()
    }
  })

  it('ignores a late old-network result and never reuses slow, failed or revoked probes', async () => {
    vi.useFakeTimers()
    const { get, link } = await connectedPhone()
    try {
      link.invalidateUpstream()
      const old = Promise.withResolvers<Response>(),
        current = Promise.withResolvers<Response>()
      get.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
      const oldWrite = link.preferDirectForWrite()
      link.invalidateUpstream()
      const currentWrite = link.preferDirectForWrite()
      old.resolve(healthy())
      await vi.advanceTimersByTimeAsync(0)
      const joined = link.preferDirectForWrite()
      expect(get).toHaveBeenCalledTimes(3)
      current.resolve(new Response(null, { status: 503 }))
      expect(await Promise.all([oldWrite, currentWrite, joined])).toEqual([true, true, true])
      get.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 1500)
        return healthy()
      })
      expect(await link.preferDirectForWrite()).toBe(false)
      get.mockResolvedValueOnce(Response.json({ code: 'unpaired' }, { status: 403 }))
      expect(await link.preferDirectForWrite()).toBe(false)
      expect(link.ready).toBe(false)
      expect(get).toHaveBeenCalledTimes(5)
    } finally {
      link.stop()
      vi.useRealTimers()
    }
  })

  it('streams the upload within the channel budget and renews the deadline while it makes progress', async () => {
    vi.useFakeTimers()
    const { link, channel, frames, receive } = await connectedPhone()
    const arrayBuffer = vi.spyOn(Request.prototype, 'arrayBuffer').mockRejectedValue(new Error('whole body read'))
    try {
      const bytes = Uint8Array.from({ length: 384 * 1024 }, (_, i) => i % 251)
      const pending = link.fetch('/upload', { method: 'POST', body: bytes })
      await vi.advanceTimersByTimeAsync(0)
      const id = readId(frames('open')[0]!)
      expect(channel.bufferedAmountLowThreshold).toBe(32 * 1024)
      expect(frames('body').length).toBeGreaterThan(0)
      expect(frames('end')).toHaveLength(0)
      receive('ping', 'chat-alive')
      expect(readId(frames('pong').at(-1)!)).toBe('chat-alive')
      for (let i = 0; i < 8 && !frames('end').length; i++) {
        expect(channel.bufferedAmount).toBeLessThanOrEqual(128 * 1024)
        await vi.advanceTimersByTimeAsync(70_000)
        channel.drain()
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(frames('end')).toHaveLength(1)
      expect(frames('open')).toHaveLength(1)
      const parts = frames('body').map((frame) => frame.subarray(3 + id.length))
      expect(Math.max(...parts.map((part) => part.length))).toBe(16 * 1024)
      expect(Buffer.concat(parts).equals(bytes)).toBe(true)
      expect(arrayBuffer).not.toHaveBeenCalled()
      receive('result', id, control({ status: 204 }))
      receive('done', id)
      expect((await pending).status).toBe(204)
    } finally {
      arrayBuffer.mockRestore()
      link.stop()
      vi.useRealTimers()
    }
  })

  it.each(['abort', 'response', 'disconnect'] as const)(
    'cleans up a paused upload on %s, ignoring late drains',
    async (kind) => {
      vi.useFakeTimers()
      const { link, channel, frames, receive } = await connectedPhone()
      try {
        const abort = new AbortController(),
          cancel = vi.fn()
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(256 * 1024))
          },
          cancel,
        })
        const result = link.fetch('/upload', {
          method: 'POST',
          body,
          duplex: 'half',
          signal: abort.signal,
        } as RequestInit)
        await vi.advanceTimersByTimeAsync(0)
        const id = readId(frames('open')[0]!)
        const before = frames('body').length
        expect(before).toBeGreaterThan(0)
        if (kind === 'abort') {
          abort.abort()
          await expect(result).rejects.toMatchObject({ name: 'AbortError' })
          receive('result', id, control({ status: 202 }))
          receive('done', id)
          expect(frames('cancel').map(readId)).toEqual([id])
        } else if (kind === 'response') {
          receive('result', id, control({ status: 413 }))
          receive('chunk', id, new TextEncoder().encode('too large'))
          receive('done', id)
          const response = await result
          expect(response.status).toBe(413)
          expect(await response.text()).toBe('too large')
          expect(frames('cancel')).toHaveLength(0)
        } else {
          channel.onclose?.()
          await expect(result).rejects.toThrow('直连通道已断开')
        }
        channel.drain()
        await vi.advanceTimersByTimeAsync(0)
        expect(frames('body')).toHaveLength(before)
        expect(cancel).toHaveBeenCalledOnce()
        expect(body.locked).toBe(false)
        if (kind !== 'disconnect') {
          const next = link.fetch('/other')
          const otherId = readId(frames('open').at(-1)!)
          receive('result', otherId, control({ status: 204 }))
          receive('done', otherId)
          expect((await next).status).toBe(204)
        }
      } finally {
        link.stop()
        vi.useRealTimers()
      }
    },
  )

  it('rejects a hidden request body before opening the exchange and accepts a genuine empty POST', async () => {
    const { link, frames, receive } = await connectedPhone()
    try {
      const hidesBodies = vi.spyOn(Request.prototype, 'body', 'get').mockReturnValue(null)
      try {
        await expect(link.fetch('/upload', { method: 'POST', body: 'text' })).rejects.toThrow('不支持直连流式上传')
        await expect(
          link.fetch(new Request('https://phone.test/upload', { method: 'POST', body: 'text' })),
        ).rejects.toThrow('不支持直连流式上传')
        expect(frames('open')).toHaveLength(0)
      } finally {
        hidesBodies.mockRestore()
      }
      const response = link.fetch(new Request('https://phone.test/empty', { method: 'POST' }))
      const id = readId(frames('open')[0]!)
      receive('result', id, control({ status: 204 }))
      receive('done', id)
      expect((await response).status).toBe(204)
      expect(frames('body')).toHaveLength(0)
    } finally {
      link.stop()
    }
  })

  it('times out idle file responses from legacy Hosts, but lets a silent event stream stay open', async () => {
    vi.useFakeTimers()
    const { link, frames, receive } = await connectedPhone()
    try {
      const file = link.fetch('/file'),
        events = link.fetch('/events')
      const [a, b] = frames('open').map(readId)
      receive('result', a!, control({ status: 200 }))
      receive('result', b!, control({ status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }))
      const fileError = expect((await file).text()).rejects.toThrow('直连请求超时')
      await vi.advanceTimersByTimeAsync(110_000)
      receive('chunk', a!, new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(119_999)
      expect(frames('cancel')).toHaveLength(0)
      receive('chunk', a!) // empty frames must not prolong a stalled transfer
      await vi.advanceTimersByTimeAsync(1)
      await fileError
      expect(frames('cancel').map(readId)).toEqual([a])
      receive('chunk', b!, new TextEncoder().encode('data: awake\n\n'))
      receive('done', b!)
      expect(await (await events).text()).toBe('data: awake\n\n')
    } finally {
      link.stop()
      vi.useRealTimers()
    }
  })

  it('keeps public preference through one bad probe, fails over, and waits before returning', async () => {
    vi.useFakeTimers()
    const peer = fakePeer()
    let available = true
    const link = remoteDirect({
      signalPath: '/rc/direct/signal',
      baseUrl: () => 'https://example.test/',
      preference: () => 'public',
      fetch: async (_input, init) =>
        init?.method === 'POST'
          ? Response.json({ sessionId: 's', sdp: 'v=0' })
          : new Response(null, { status: available ? 204 : 503 }),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    })
    const answer = () => {
      const ping = peer.sent.findLast((frame) => readType(frame.payload) === 'ping')!
      peer.channel.onmessage?.({ data: encode('pong', readId(ping.payload), new Uint8Array()).buffer as ArrayBuffer })
    }
    try {
      await link.start()
      peer.channel.readyState = 'open'
      peer.channel.onopen?.()
      answer()
      await link.probe()
      expect(link.line).toBe('upstream')
      available = false
      await link.probe()
      expect(link.line).toBe('upstream')
      await link.probe()
      expect(link.line).toBe('direct')
      available = true
      await link.probe()
      expect(link.line).toBe('direct')
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(5000)
        answer()
      }
      expect(link.line).toBe('upstream')
    } finally {
      link.stop()
      vi.useRealTimers()
    }
  })
})
