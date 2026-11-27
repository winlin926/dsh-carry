import type { PublicNodeConfig, PublicNodeRecord } from '../public-node-config.js'
import { PUBLIC_NODE_PROTOCOL_V2, detectPublicNode } from '../public-node.js'
import { DOWNGRADE_CHECK, IDENTITY_CHANGE_CHECK, IDENTITY_CHANGE_ERROR } from './types.js'

export interface PublicNodeDeps {
  nodeStore: () => PublicNodeConfig
  reconcile: () => Promise<void>
  clearUnregisterNoticeIfOrigin: (origin: string) => void
  onSelectGatewayDomain: (url: string) => Promise<void>
  onSwitchToServiceNode: () => Promise<void>
  onRemoveGatewayNode: (origin: string, wasCurrent: boolean) => Promise<void>
  onRemoveServiceNode: (origin: string) => Promise<void>
  onForgetNonServiceNode: (origin: string) => Promise<void>
  onPruneDevicesForOrigin: (origin: string) => void
  onRestartPublicGateway: () => Promise<void>
  isPublicActiveAndBusy: () => { enabledPublic: boolean; busy: boolean }
}

export async function handleAddPublicNode(deps: PublicNodeDeps, input: Record<string, unknown>): Promise<unknown> {
  const store = deps.nodeStore()
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!url) throw new Error('请填写公网节点地址。')
  const detected = await detectPublicNode(url)
  if (!detected.ok) return { ok: false, message: detected.message }
  // A protocol-2 service node may advertise a placeholder identity until this Host registers
  // there, so this only records what the node published; ServiceNode asserts the real hostId
  // during registration. The record is written only after a successful probe.
  if (store.list().some((record) => record.url === detected.node.url))
    return { ok: false, message: '该公网节点已存在。' }
  const record = store.add({
    url: detected.node.url,
    kind: detected.node.kind,
    name: detected.node.name,
    version: detected.node.version,
    protocol: detected.node.protocol,
    capabilities: detected.node.capabilities,
    node: detected.node.node,
    hostId: detected.node.hostId,
    fingerprint: detected.node.fingerprint,
    pending: false,
  })
  deps.clearUnregisterNoticeIfOrigin(record.url)
  return { ok: true, node: record }
}

export async function handleCheckPublicNode(deps: PublicNodeDeps, input: Record<string, unknown>): Promise<unknown> {
  const store = deps.nodeStore()
  const id = String(input.id ?? '')
  const record = store.list().find((item) => item.id === id)
  if (!record) throw new Error('公网节点不存在。')
  const detected = await detectPublicNode(record.url)
  const checkedAt = Date.now()
  if (!detected.ok) {
    store.update(id, { lastCheckAt: checkedAt, lastCheckOk: false, lastCheckError: detected.message })
    return { ok: false, message: detected.message }
  }
  const found = detected.node
  // Rule 5: a confirmed protocol-2 node never falls back to the flat protocol-1 shape in silence.
  if (found.protocol !== PUBLIC_NODE_PROTOCOL_V2) {
    if (record.node !== null) {
      store.update(id, { lastCheckAt: checkedAt, lastCheckOk: false, lastCheckError: DOWNGRADE_CHECK })
      return { ok: false, message: DOWNGRADE_CHECK }
    }
    return {
      ok: true,
      node: store.update(id, {
        url: found.url,
        kind: found.kind,
        name: found.name,
        version: found.version,
        protocol: 1,
        capabilities: found.capabilities,
        hostId: found.hostId,
        fingerprint: found.fingerprint,
        lastCheckAt: checkedAt,
        lastCheckOk: true,
        lastCheckError: null,
        pending: false,
      }),
    }
  }
  const identity = found.node
  if (!identity) return { ok: false, message: '节点身份无效：协议 2 的发现文档缺少 node 身份对象。' }
  // Already waiting for a user decision: never rotate the recorded identity on our own.
  if (record.identityChange !== null) {
    store.update(id, { lastCheckAt: checkedAt, lastCheckOk: false, lastCheckError: IDENTITY_CHANGE_CHECK })
    return { ok: false, message: IDENTITY_CHANGE_ERROR }
  }
  // Rule 3: a different identity is recorded beside the old one and blocks the node until confirmed.
  if (record.node !== null && record.node.id !== identity.id) {
    store.markIdentityChange(id, identity)
    store.update(id, { lastCheckAt: checkedAt, lastCheckOk: false, lastCheckError: IDENTITY_CHANGE_CHECK })
    await deps.reconcile()
    return { ok: false, message: IDENTITY_CHANGE_CHECK }
  }
  // Rule 2: no identity to compare with yet (migrated record or never-probed candidate) — adopt it.
  if (record.node === null) store.adoptIdentity(id, identity)
  return {
    ok: true,
    node: store.update(id, {
      url: found.url,
      kind: found.kind,
      name: found.name,
      version: found.version,
      protocol: 2,
      capabilities: found.capabilities,
      hostId: null,
      fingerprint: null,
      lastCheckAt: checkedAt,
      lastCheckOk: true,
      lastCheckError: null,
      pending: false,
    }),
  }
}

export async function handleConfirmPublicNodeIdentity(
  deps: PublicNodeDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const store = deps.nodeStore()
  const id = String(input.id ?? '')
  const confirmed = store.confirmIdentity(id)
  // Re-probe once so the panel shows a fresh state. The confirmation already happened, so a
  // failed probe only lands in the check fields and never undoes it.
  const detected = await detectPublicNode(confirmed.url)
  const checkedAt = Date.now()
  if (!detected.ok) {
    return {
      ok: true,
      node: store.update(id, { lastCheckAt: checkedAt, lastCheckOk: false, lastCheckError: detected.message }),
    }
  }
  const found = detected.node
  if (found.protocol !== PUBLIC_NODE_PROTOCOL_V2) {
    return {
      ok: true,
      node: store.update(id, { lastCheckAt: checkedAt, lastCheckOk: false, lastCheckError: DOWNGRADE_CHECK }),
    }
  }
  const identity = found.node
  if (!identity) return { ok: true, node: confirmed }
  // The node changed again between confirmation and the probe: record the new change instead of
  // pretending the confirmed identity still matches.
  if (confirmed.node !== null && identity.id !== confirmed.node.id) {
    store.markIdentityChange(id, identity)
    await deps.reconcile()
    return {
      ok: true,
      node: store.update(id, {
        lastCheckAt: checkedAt,
        lastCheckOk: false,
        lastCheckError: IDENTITY_CHANGE_CHECK,
      }),
    }
  }
  const node = store.update(id, {
    url: found.url,
    kind: found.kind,
    name: found.name,
    version: found.version,
    protocol: 2,
    capabilities: found.capabilities,
    hostId: null,
    fingerprint: null,
    lastCheckAt: checkedAt,
    lastCheckOk: true,
    lastCheckError: null,
    pending: false,
  })
  await deps.reconcile()
  return { ok: true, node }
}

export async function handleSetCurrentPublicNode(
  deps: PublicNodeDeps,
  input: Record<string, unknown>,
): Promise<PublicNodeRecord> {
  const store = deps.nodeStore()
  const id = String(input.id ?? '')
  const record = store.list().find((item) => item.id === id)
  if (!record) throw new Error('公网节点不存在。')
  // An unconfirmed identity change means the node the user chose may not be the node at that
  // address any more; it cannot become the current node.
  if (record.identityChange !== null) throw new Error(IDENTITY_CHANGE_ERROR)
  const { enabledPublic, busy } = deps.isPublicActiveAndBusy()
  if (enabledPublic && busy) throw new Error('请等待当前连接操作完成。')
  // A gateway node's public entry still rides on the saved domain; a service node's entry is the
  // tunnel itself and leaves PublicAccess alone (clearing any domain owned by a saved gateway node).
  if (record.kind === 'gateway') await deps.onSelectGatewayDomain(record.url)
  else if (record.kind === 'service') await deps.onSwitchToServiceNode()
  store.setCurrent(id)
  if (enabledPublic) {
    if (record.kind === 'service') {
      await deps.reconcile()
    } else {
      await deps.onRestartPublicGateway()
    }
  } else {
    await deps.reconcile()
  }
  return record
}

export async function handleRemovePublicNode(
  deps: PublicNodeDeps,
  input: Record<string, unknown>,
): Promise<{ origin: string }> {
  const store = deps.nodeStore()
  const id = String(input.id ?? '')
  const wasCurrent = store.current === id
  const record = store.list().find((item) => item.id === id)
  const removed = store.remove(id)
  if (!removed) throw new Error('公网节点不存在。')
  if (record?.kind === 'gateway') await deps.onRemoveGatewayNode(removed.origin, wasCurrent)
  if (record?.kind === 'service') await deps.onRemoveServiceNode(removed.origin)
  else await deps.onForgetNonServiceNode(removed.origin)
  deps.onPruneDevicesForOrigin(removed.origin)
  await deps.reconcile()
  return removed
}
