import * as React from 'react'
import {
  address,
  checkedAtLabel,
  nodeCheckStatus,
  nodeFingerprintGroups,
  nodeHost,
  nodeKindLabel,
  parsePublicNodeAddress,
  publicNodeFingerprint,
  publicNodeProtocolLabel,
  serviceStateLabel,
  sortPublicNodes,
  type PublicNode,
  type Status,
} from '../model.js'
import { CardIcon, InlineNotice, NodeIcon } from './Primitives.js'

interface PublicNodesSectionProps {
  state: Status
  disabled: boolean
  workingAction: string
  workingNode: string
  act: (action: string, fields?: Record<string, unknown>) => Promise<boolean>
}

/** Public entries recorded for this Host: probe, confirm, choose or delete them without leaving the panel. */
export function PublicNodesSection({
  state,
  disabled,
  workingAction,
  workingNode,
  act,
}: PublicNodesSectionProps): React.ReactElement | null {
  const [nodeDraft, setNodeDraft] = React.useState('')
  const [nodeError, setNodeError] = React.useState('')

  const entries = state.publicNodes
  if (!entries) return null
  const list = sortPublicNodes(entries.list, entries.current)
  const service = state.serviceNode
  const serviceState = service ? serviceStateLabel(service) : null
  // Only the Host itself may change the list; a panel opened through an entry gets a read-only view.
  const manageDisabled = disabled || !state.local

  const submitNode = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = parsePublicNodeAddress(nodeDraft)
    if (!parsed.ok) {
      setNodeError(parsed.error)
      return
    }
    setNodeError('')
    void act('addPublicNode', { url: parsed.url }).then((saved) => {
      if (saved) setNodeDraft('')
    })
  }

  return (
    <section className="dsrc-nodes" aria-label="公网节点" data-section="nodes">
      <div className="dsrc-card-head">
        <CardIcon tone="teal">
          <NodeIcon />
        </CardIcon>
        <h3>公网节点</h3>
        {list.length ? <span className="dsrc-count">{String(list.length)}</span> : null}
      </div>
      {service && serviceState ? (
        <div className="dsrc-service-state" data-tone={serviceState.tone}>
          <span className="dsrc-service-dot" aria-hidden="true" />
          <span>自托管节点</span>
          <strong role="status">{serviceState.label}</strong>
          {serviceState.reason ? <span className="dsrc-service-reason">{`原因：${serviceState.reason}`}</span> : null}
          <span className="dsrc-service-origin" title={service.origin}>
            {address(service.origin)}
          </span>
        </div>
      ) : null}
      {entries.pendingReview ? <InlineNotice tone="warn">检测到旧公网地址，确认后才会使用。</InlineNotice> : null}
      {list.length ? (
        <ul className="dsrc-node-list" aria-label="公网节点">
          {list.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              current={node.id === entries.current}
              busy={workingNode === node.id}
              manageDisabled={manageDisabled}
              act={act}
            />
          ))}
        </ul>
      ) : (
        <p className="dsrc-empty">还没有公网节点。填写 https 地址后先检测，确认指纹再使用。</p>
      )}
      <div className="dsrc-node-add">
        <label className="dsrc-field-label" htmlFor="dsrc-node-url">
          添加节点
        </label>
        {/* noValidate keeps the browser bubble out of the way: the Host-style wording above is the only feedback. */}
        <form className="dsrc-input" noValidate onSubmit={submitNode}>
          <input
            id="dsrc-node-url"
            type="url"
            value={nodeDraft}
            placeholder="https://node.example.com"
            spellCheck={false}
            autoComplete="off"
            disabled={manageDisabled}
            aria-invalid={!!nodeError}
            aria-label="公网节点 HTTPS 地址"
            onChange={(event) => {
              setNodeDraft(event.target.value)
              if (nodeError) setNodeError('')
            }}
          />
          <button type="submit" className="dsrc-button dsrc-primary" disabled={manageDisabled || !nodeDraft.trim()}>
            {workingAction === 'addPublicNode' ? '正在添加…' : '添加'}
          </button>
        </form>
        {nodeError ? (
          <p className="dsrc-error" role="alert">
            {nodeError}
          </p>
        ) : null}
        <p className="dsrc-note">
          {state.local
            ? '只填写 https:// 域名（可带端口），不能包含路径、查询参数或账号密码。'
            : '公网节点只能在本机面板添加、检测或切换。'}
        </p>
        <p className="dsrc-note dsrc-node-trust">
          {
            '通过 HTTPS 连接该节点。节点或隧道运营者可能看到转发给本机的请求与内容，本插件不提供端到端加密。请只添加你信任的节点。'
          }
        </p>
      </div>
    </section>
  )
}

function NodeRow({
  node,
  current,
  busy,
  manageDisabled,
  act,
}: {
  node: PublicNode
  current: boolean
  busy: boolean
  manageDisabled: boolean
  act: (action: string, fields?: Record<string, unknown>) => Promise<boolean>
}): React.ReactElement {
  const check = nodeCheckStatus(node)
  const host = nodeHost(node.url)
  const change = node.identityChange

  return (
    <li className="dsrc-node dsrc-row">
      <div className="dsrc-node-main">
        <div className="dsrc-node-title">
          <span className="dsrc-node-name">{node.name?.trim() || host}</span>
          <span className="dsrc-tag dsrc-node-kind" data-kind={node.kind ?? 'unknown'}>
            {nodeKindLabel(node.kind)}
          </span>
          <span
            className="dsrc-tag dsrc-node-protocol"
            data-protocol={node.protocol === 2 ? 'v2' : node.protocol === 1 ? 'v1' : 'unknown'}
          >
            {publicNodeProtocolLabel(node.protocol)}
          </span>
          {current ? <span className="dsrc-tag dsrc-online">当前使用</span> : null}
          {node.pending ? <span className="dsrc-tag dsrc-pending">待确认</span> : null}
          {change ? <span className="dsrc-tag dsrc-pending">身份待确认</span> : null}
        </div>
        <code className="dsrc-node-url" title={node.url}>
          {address(node.url)}
        </code>
        <div className="dsrc-node-meta">
          <span className="dsrc-node-check" role="status" data-tone={check.tone}>
            {check.label}
          </span>
          <span>{`最近检测 ${checkedAtLabel(node.lastCheckAt)}`}</span>
          {/* A v2 node names its own identity; a v1 record is a single-host gateway and keeps the old label. */}
          {node.protocol === 2 ? (
            <span className="dsrc-node-fingerprint">{`节点指纹 ${nodeFingerprintGroups(publicNodeFingerprint(node))}`}</span>
          ) : node.protocol === 1 ? (
            <span className="dsrc-node-fingerprint">{`Host 指纹 ${nodeFingerprintGroups(node.fingerprint)}`}</span>
          ) : null}
        </div>
        {!node.pending && !node.lastCheckOk && node.lastCheckError ? (
          <p className="dsrc-node-error" role="alert">
            {node.lastCheckError}
          </p>
        ) : null}
        {change ? (
          <div className="dsrc-node-identity">
            <p className="dsrc-node-error" role="alert">
              节点身份已变化，需要重新确认。
            </p>
            <p className="dsrc-node-fingerprints">{`原节点指纹 ${nodeFingerprintGroups(change.from.fingerprint)}`}</p>
            <p className="dsrc-node-fingerprints">{`新节点指纹 ${nodeFingerprintGroups(change.to.fingerprint)}`}</p>
            <button
              type="button"
              className="dsrc-button dsrc-primary"
              disabled={manageDisabled}
              aria-label={`重新确认节点 ${host} 的身份`}
              onClick={() => {
                if (confirm(`确认 ${host} 的新节点指纹？确认前不会通过该节点连接。`)) {
                  void act('confirmPublicNodeIdentity', { id: node.id })
                }
              }}
            >
              {busy ? '正在确认…' : '重新确认'}
            </button>
          </div>
        ) : null}
      </div>
      {node.pending ? (
        <div className="dsrc-actions dsrc-node-actions">
          <button
            type="button"
            className="dsrc-button dsrc-primary"
            disabled={manageDisabled || !!change}
            aria-label={`确认使用节点 ${host}`}
            onClick={() => {
              void act('setCurrentPublicNode', { id: node.id })
            }}
          >
            {busy ? '正在确认…' : '确认使用'}
          </button>
          <button
            type="button"
            className="dsrc-button dsrc-ghost"
            disabled={manageDisabled}
            aria-label={`忽略节点 ${host}`}
            onClick={() => {
              void act('removePublicNode', { id: node.id })
            }}
          >
            {busy ? '正在忽略…' : '忽略'}
          </button>
        </div>
      ) : (
        <div className="dsrc-actions dsrc-node-actions">
          <button
            type="button"
            className="dsrc-button dsrc-ghost"
            disabled={manageDisabled}
            aria-label={`检测节点 ${host}`}
            onClick={() => {
              void act('checkPublicNode', { id: node.id })
            }}
          >
            {busy ? '正在检测…' : '检测'}
          </button>
          <button
            type="button"
            className="dsrc-button"
            disabled={manageDisabled || current || !!change}
            aria-label={`将节点 ${host} 设为当前`}
            onClick={() => {
              void act('setCurrentPublicNode', { id: node.id })
            }}
          >
            {current ? '当前使用' : change ? '需先确认身份' : busy ? '正在切换…' : '设为当前'}
          </button>
          <button
            type="button"
            className="dsrc-button dsrc-danger"
            disabled={manageDisabled}
            aria-label={`删除节点 ${host}`}
            onClick={() => {
              if (confirm(`删除公网节点 ${address(node.url)}？通过该节点授权的设备会被撤销。`)) {
                void act('removePublicNode', { id: node.id })
              }
            }}
          >
            {busy ? '正在删除…' : '删除'}
          </button>
        </div>
      )}
    </li>
  )
}
