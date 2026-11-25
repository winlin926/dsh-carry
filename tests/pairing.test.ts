import { afterEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { IDLE_MS, PairingService, deviceName } from '../src/pairing.js'
import { pairingPage } from '../src/pages.js'
const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
function fixture(onRevoke?: (id: string) => void) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-pair-')); folders.push(folder)
  let now = 1000000
  const file = join(folder, 'devices.json'), service = new PairingService({ file, now: () => now, onRevoke })
  return { service, file, advance: (ms: number) => { now += ms }, now: () => now }
}
function approved(service: PairingService) {
  const qr = service.issue(), claim = service.request(qr.token, 'Android')
  service.approve(claim.id)
  return service.claim(claim.id, claim.key).credential!
}
describe('pairing admission and durable revocation', () => {
  it('binds relayed authorization to its node and preserves local revocation across restart', () => {
    const { service, file, now } = fixture()
    const peer = { id: '01JABCDEF0123456789ABCDEFG', name: 'Android Edge' }
    const a = service.admitRelay('relay-a', peer)!
    const b = service.admitRelay('relay-b', peer)!
    expect(a).not.toBe(b)
    expect(service.admitRelay('relay-a', peer)).toBe(a)
    service.revoke(a)
    const reopened = new PairingService({ file, now })
    expect(reopened.admitRelay('relay-a', peer)).toBeUndefined()
    expect(reopened.admitRelay('relay-b', peer)).toBe(b)
    reopened.confirmRelay('relay-a', peer.id)
    expect(reopened.admitRelay('relay-a', peer)).toBe(a)
    reopened.revokeAll()
    expect(reopened.admitRelay('relay-a', peer)).toBeUndefined()
    expect(reopened.admitRelay('relay-b', peer)).toBeUndefined()
  })

  it('requires local approval and an independent claim key', () => {
    const { service } = fixture(), qr = service.issue(), one = service.request(qr.token, 'Android'), two = service.request(qr.token, 'iPhone')
    expect(service.claim(one.id, one.key)).toEqual({ state: 'pending', credential: undefined })
    expect(() => service.claim(one.id, two.key)).toThrow()
    service.approve(one.id)
    const credential = service.claim(one.id, one.key).credential!
    expect(service.authenticate(credential)?.name).toBe('Android')
    expect(service.claim(two.id, two.key).state).toBe('pending')
    expect(service.claim(one.id, one.key)).toEqual({ state: 'approved', credential })
    expect(() => service.claim(one.id, two.key)).toThrow()
  })
  it('invalidates old QR and pending requests on refresh, and expires tokens', () => {
    const { service, advance } = fixture(), qr = service.issue(), request = service.request(qr.token, '')
    service.issue()
    expect(() => service.request(qr.token, '')).toThrow()
    expect(() => service.approve(request.id)).toThrow()
    const fresh = service.issue(); advance(300001)
    expect(() => service.request(fresh.token, '')).toThrow()
  })
  it('counts the claims a ticket refresh would strand', () => {
    const { service } = fixture(), claim = service.request(service.issue().token, '')
    expect(service.outstanding()).toBe(1)
    service.reject(claim.id)
    expect(service.outstanding()).toBe(0)
    const accepted = service.request(service.issue().token, '')
    service.approve(accepted.id)
    expect(service.outstanding()).toBe(1)   // approved, credential not collected yet
    service.claim(accepted.id, accepted.key)
    expect(service.outstanding()).toBe(0)
  })
  it('rejects requests without granting a credential', () => {
    const { service } = fixture(), claim = service.request(service.issue().token, '')
    service.reject(claim.id)
    expect(service.claim(claim.id, claim.key)).toEqual({ state: 'rejected', credential: undefined })
    expect(service.list()).toEqual([])
  })
  it('persists only hashes and remembers devices across a restart', () => {
    const { service, file, now } = fixture(), credential = approved(service)
    expect(readFileSync(file, 'utf8')).not.toContain(credential.split('.')[1])
    const restarted = new PairingService({ file, now })
    expect(restarted.authenticate(credential)).toBeDefined()
    restarted.revoke(restarted.list()[0]!.id)
    expect(new PairingService({ file, now }).authenticate(credential)).toBeUndefined()
  })
  it('keeps authorization on stop but not on revoke-all', () => {
    const { service } = fixture(), credential = approved(service)
    service.invalidate(); expect(service.authenticate(credential)).toBeDefined()
    service.revokeAll(); expect(service.authenticate(credential)).toBeUndefined()
  })
  it('expires idle devices and notifies active carriers', () => {
    const revoked: string[] = [], { service, advance } = fixture(id => revoked.push(id)), credential = approved(service)
    advance(IDLE_MS - 1000); expect(service.authenticate(credential)).toBeDefined()
    advance(IDLE_MS + 1); expect(service.authenticate(credential)).toBeUndefined()
    expect(revoked).toHaveLength(1)
  })
  it('cannot recover an approved credential after its device is revoked', () => {
    const { service } = fixture(), claim = service.request(service.issue().token, '')
    service.approve(claim.id); service.revoke(service.list()[0]!.id)
    expect(() => service.claim(claim.id, claim.key)).toThrow()
  })
  it.each(['refresh', 'expire', 'stop', 'revokeAll'])('invalidates a collected claim on %s', action => {
    const { service, advance } = fixture(), claim = service.request(service.issue().token, '')
    service.approve(claim.id)
    const first = service.claim(claim.id, claim.key)
    expect(service.claim(claim.id, claim.key)).toEqual(first)
    if (action === 'refresh') service.issue()
    else if (action === 'expire') advance(300001)
    else if (action === 'stop') service.invalidate()
    else service.revokeAll()
    expect(() => service.claim(claim.id, claim.key)).toThrow()
  })
})

it('names a device by model or system and browser', () => {
  expect(deviceName('Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36')).toBe('V2309A · Chrome')
  expect(deviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0')).toBe('Android · Edge')
  expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
  expect(deviceName('')).toBe('远程设备')
  // The model a browser reports on request wins over the reduced User-Agent.
  expect(deviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36', 'V2309A<b>;')).toBe('V2309Ab · Chrome')
})
it('records the pairing address and renames authorized devices', () => {
  const { service } = fixture()
  const pair = (host: string) => { const claim = service.request(service.issue().token, 'Android', host); service.approve(claim.id); return service.claim(claim.id, claim.key).credential! }
  const lan = pair('192.168.1.23:5173'), tunnel = pair('Old-Name.trycloudflare.com')
  expect(service.list().map(device => device.host)).toEqual(['192.168.1.23:5173', 'old-name.trycloudflare.com'])
  service.rename(lan.split('.')[0]!, '  我的手机  ')
  expect(service.list()[0]!.name).toBe('我的手机')
  expect(() => service.rename(lan.split('.')[0]!, ' ')).toThrow()
  service.prune(device => !!device.host?.endsWith('.trycloudflare.com'))
  expect(service.authenticate(tunnel)).toBeUndefined()
  expect(service.authenticate(lan)?.name).toBe('我的手机')
})

function openPairing(page: string, fetch: (path: string, input: { body: string }) => Promise<Response>, hash = '#pair=scan-token') {
  const element = () => ({ textContent: '', hidden: true, disabled: true, lang: '', onclick: undefined as (() => Promise<void> | void) | undefined });
  const elements = { confirm: element(), state: element(), error: element(), progress: element(), enter: element(), language: element(), 'target-fingerprint': element() };
  if (!page.includes('id="confirm"')) Object.assign(elements, { confirm: null, 'target-fingerprint': null });
  const visibility = new Map<string, () => void>();
  const document = {
    hidden: false, title: '', documentElement: { lang: '' },
    querySelectorAll: () => [],
    getElementById: (id: keyof typeof elements) => elements[id] ?? null,
    addEventListener: (name: string, listener: () => void) => { visibility.set(name, listener) },
  };
  const stored = new Map<string, string>();
  const location = { hash, replaced: '', replace(path: string) { this.replaced = path } };
  const clock = { now: Date.now() };
  const timers = new Map<number, () => void>();
  let sequence = 0;
  const ready = runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document, location, history: { replaceState: () => { location.hash = '' } },
    localStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) },
    URLSearchParams, atob, crypto: webcrypto, navigator: {}, AbortSignal, Date: { now: () => clock.now }, fetch,
    setTimeout: (callback: () => void) => { timers.set(++sequence, callback); return sequence },
    clearTimeout: (id: number) => { timers.delete(id) },
  }) as Promise<void>;
  function setHidden(hidden: boolean) {
    document.hidden = hidden;
    visibility.get('visibilitychange')?.();
  }
  return { elements, document, location, stored, clock, timers, ready, setHidden };
}

const unpaired = () => Response.json({ code: 'unpaired' }, { status: 403 });

it.each(['valid', 'wrong key', 'missing token'] as const)('handles public confirmation with %s', async scenario => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const page = pairingPage({ name: 'DSH', kind: 'gateway', fingerprint, fingerprintGroups: fingerprint, publicKey: der.toString('base64url'), protocol: 2 });
  expect(page).toContain('id="confirm" disabled');
  const requests: unknown[] = [];
  const hash = scenario === 'missing token' ? '' : `#pair=scan-token${scenario === 'wrong key' ? '&key=YWJj' : ''}`;
  const view = openPairing(page, async (path, input) => {
    if (path.endsWith('/manage')) return unpaired();
    requests.push(JSON.parse(input.body));
    return Response.json(path.endsWith('/request') ? { id: 'pending', key: 'claim-key', expiresAt: Date.now() + 300000 } : { state: 'approved' });
  }, hash);
  await view.ready;
  const { confirm, state, error, progress } = view.elements;
  expect(requests).toEqual([]);
  expect(confirm.disabled).toBe(scenario !== 'valid');
  if (scenario === 'valid') {
    await confirm.onclick!();
    expect(progress.hidden).toBe(false);
    expect(requests).toEqual([{ token: 'scan-token', model: '', fingerprint }, { id: 'pending', key: 'claim-key' }]);
    expect(view.location.replaced).toBe('/');
  } else if (scenario === 'wrong key') {
    expect(confirm.onclick).toBeUndefined();
    expect(error.textContent).toContain('主机指纹与这台电脑不一致');
  } else {
    expect(confirm.hidden).toBe(true);
    expect(state.textContent).toContain('扫描新的二维码');
  }
})

it.each(['request', 'claim'] as const)('only retries a known claim after a failed %s', async failed => {
  const requests: string[] = []
  const claims: unknown[] = []
  let interrupted = false
  const view = openPairing(pairingPage(), async (path, input) => {
    if (path.endsWith('/manage')) return unpaired()
    const data = JSON.parse(input.body)
    if (path.endsWith('/request')) requests.push(data.token)
    else claims.push(data)
    if (path.endsWith('/' + failed) && !interrupted) { interrupted = true; throw new Error('offline') }
    return Response.json(path.endsWith('/request') ? { id: 'pending-device', key: 'claim-key', expiresAt: Date.now() + 300000 } : { state: 'approved' })
  })
  await view.ready
  const { enter, state } = view.elements
  expect(view.location.hash).toBe('')
  expect(state.textContent).toContain(failed === 'request' ? '无法确认配对请求是否送达' : '请检查网络后重试')
  expect(enter.hidden).toBe(failed === 'request')
  await enter.onclick!()
  expect(view.location.replaced).toBe(failed === 'request' ? '' : '/')
  expect(requests).toEqual(['scan-token'])
  const claim = { id: 'pending-device', key: 'claim-key' }
  expect(claims).toEqual(failed === 'request' ? [] : [claim, claim])
})

it.each([
  [400, 'qr_invalid', '二维码已失效', false],
  [429, undefined, '无法确认配对请求是否送达', false],
  [429, 'pairing_busy', '配对请求过多', true],
] as const)('handles an initial pairing refusal (%s, %s)', async (status, code, message, retry) => {
  let requests = 0
  const view = openPairing(pairingPage(), async path => {
    if (path.endsWith('/manage')) return unpaired()
    expect(path).toBe('/rc/pair/request')
    requests++
    return Response.json({ code }, { status })
  })
  await view.ready
  expect(view.elements.state.textContent).toContain(message)
  expect(view.elements.enter.hidden).toBe(!retry)
  view.setHidden(true)
  view.setHidden(false)
  expect(requests).toBe(1)
  await view.elements.enter.onclick!()
  expect(requests).toBe(retry ? 2 : 1)
})

it('pauses while hidden and resumes the same claim once, keeping the language choice', async () => {
  const polls: unknown[] = []
  const approval = Promise.withResolvers<Response>()
  const view = openPairing(pairingPage(), async (path, input) => {
    if (path.endsWith('/manage')) return unpaired()
    if (path.endsWith('/request')) return Response.json({ id: 'pending', key: 'claim-key', expiresAt: Date.now() + 300000 })
    polls.push(JSON.parse(input.body))
    return polls.length === 1 ? Response.json({ state: 'pending' }) : approval.promise
  })
  await view.ready
  expect(view.timers.size).toBe(1)
  view.setHidden(true)
  expect(view.timers.size).toBe(0)
  view.elements.language.onclick!()
  await view.elements.enter.onclick!()
  expect(view.document.documentElement.lang).toBe('en')
  expect(view.elements.state.textContent).toContain('Waiting for approval')
  expect([...view.stored]).toEqual([['dsh-rc-language', 'en']])
  expect(polls).toHaveLength(1)
  view.setHidden(false)
  view.setHidden(false)
  await view.elements.enter.onclick!()
  expect(polls).toEqual(Array.from({ length: 2 }, () => ({ id: 'pending', key: 'claim-key' })))
  approval.resolve(Response.json({ state: 'approved' }))
  await expect.poll(() => view.location.replaced).toBe('/')
})

it('stops checking a claim that expired in the background', async () => {
  let polls = 0
  const expiry = Date.now() + 300000
  const view = openPairing(pairingPage(undefined, 'en'), async path => {
    if (path.endsWith('/manage')) return unpaired()
    if (path.endsWith('/request')) return Response.json({ id: 'pending', key: 'claim-key', expiresAt: expiry })
    polls++
    return Response.json({ state: 'pending' })
  })
  await view.ready
  view.setHidden(true)
  view.clock.now = expiry
  view.setHidden(false)
  await view.elements.enter.onclick!()
  expect(view.elements.state.textContent).toContain('pairing request is no longer valid')
  expect(view.elements.enter.hidden).toBe(true)
  expect(view.timers.size).toBe(0)
  expect(polls).toBe(1)
})

it('reopens an already authorized device without submitting another pairing', async () => {
  const paths: string[] = []
  const view = openPairing(pairingPage(), async path => {
    paths.push(path)
    return Response.json({ requests: [] })
  }, '')
  await view.ready
  expect(paths).toEqual(['/api/dsh-remote-connect/manage'])
  expect(view.location.replaced).toBe('/')
})

it('marks only historical public-entry authorizations for repair, exactly once', () => {
  const now = 1000000, folder = mkdtempSync(join(tmpdir(), 'dsh-rc-legacy-')); folders.push(folder)
  const file = join(folder, 'devices.json'), secret = 'legacy-secret'
  const hash = createHash('sha256').update(secret).digest('hex')
  const record = (id: string, name: string, host: string) => ({ id, name, createdAt: now - 1000, lastSeenAt: now - 1000, hash, host })
  writeFileSync(file, JSON.stringify({ version: 1, devices: [record('lan-device', '我的手机', '192.168.1.23:5173'), record('public-device', '旧公网手机', 'old-name.trycloudflare.com'), record('other-device', '其他设备', 'other.example.com')] }))
  const service = new PairingService({ file, now: () => now })
  expect(service.migratePublicDevices(['https://old-name.trycloudflare.com'])).toEqual({ marked: 1, already: 0, devices: 3 })
  const listed = service.list()
  // The device name and every record stay readable; only the historical public entry is flagged.
  expect(listed.find(device => device.id === 'public-device')).toMatchObject({ name: '旧公网手机', requiresRepair: true })
  expect(listed.find(device => device.id === 'lan-device')?.requiresRepair).toBeUndefined()
  expect(listed.find(device => device.id === 'other-device')?.requiresRepair).toBeUndefined()
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  expect(stored.version).toBe(1); expect(stored.devices).toHaveLength(3)
  expect(stored.devices.find((device: { id: string }) => device.id === 'public-device')?.name).toBe('旧公网手机')
  // The old public cookie no longer authenticates; the LAN authorization keeps working.
  expect(service.authenticate(`public-device.${secret}`)).toBeUndefined()
  expect(service.authenticate(`lan-device.${secret}`)?.name).toBe('我的手机')
  // A restart sees the flag on disk, and a second migration changes nothing.
  const restarted = new PairingService({ file, now: () => now }), before = readFileSync(file, 'utf8')
  expect(restarted.migratePublicDevices(['https://old-name.trycloudflare.com'])).toEqual({ marked: 0, already: 1, devices: 3 })
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(restarted.authenticate(`public-device.${secret}`)).toBeUndefined()
})

it('cannot approve a public pairing until the browser confirms this host', () => {
  const { service } = fixture()
  const unconfirmed = service.request(service.issue().token, 'Android', 'dsh.example.com', undefined, 'public', false)
  expect(service.requests()).toEqual([expect.objectContaining({ id: unconfirmed.id, via: 'public', nodeConfirmed: false })])
  expect(() => service.approve(unconfirmed.id)).toThrow('浏览器还没有确认本机指纹')
  expect(service.requests()).toHaveLength(1)
  // A LAN request needs no browser confirmation, and a public one may carry it.
  const lan = service.request(service.issue().token, 'Android', '192.168.1.23:5173')
  expect(service.requests()[0]).toMatchObject({ id: lan.id, via: 'lan', nodeConfirmed: true })
  service.approve(lan.id)
  expect(service.claim(lan.id, lan.key).state).toBe('approved')
  const confirmed = service.request(service.issue().token, 'iPhone', 'dsh.example.com', undefined, 'public', true)
  expect(service.requests()[0]).toMatchObject({ id: confirmed.id, via: 'public', nodeConfirmed: true })
  service.approve(confirmed.id)
  expect(service.claim(confirmed.id, confirmed.key).state).toBe('approved')
  expect(service.list().map(device => device.via)).toEqual(['lan', 'public'])
})

it('records a refused confirmation so the panel can show the reason', () => {
  const { service } = fixture()
  expect(service.failure()).toBeUndefined()
  service.reportFailure('旧公网手机', '主机指纹与配对页不一致，本次配对已拒绝。')
  expect(service.failure()).toMatchObject({ name: '旧公网手机', reason: '主机指纹与配对页不一致，本次配对已拒绝。' })
  service.issue()
  expect(service.failure()).toBeUndefined()
})
