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
  type ClientLocale,
  type PublicNode,
  type Status,
} from '../model.js'
import { CardIcon, InlineNotice, NodeIcon, useText } from './Primitives.js'

interface PublicNodesSectionProps {
  state: Status
  disabled: boolean
  workingAction: string
  workingNode: string
  act: (action: string, fields?: Record<string, unknown>) => Promise<boolean>
  locale?: ClientLocale
}

/** Public entries recorded for this Host: probe, confirm, choose or delete them without leaving the panel. */
export function PublicNodesSection({
  state,
  disabled,
  workingAction,
  workingNode,
  act,
  locale,
}: PublicNodesSectionProps): React.ReactElement | null {
  const text = useText(locale)
  const [nodeDraft, setNodeDraft] = React.useState('')
  const [nodeError, setNodeError] = React.useState('')

  const entries = state.publicNodes
  if (!entries) return null
  const list = sortPublicNodes(entries.list, entries.current)
  const service = state.serviceNode
  const serviceState = service ? serviceStateLabel(service, locale) : null
  // Only the Host itself may change the list; a panel opened through an entry gets a read-only view.
  const manageDisabled = disabled || !state.local

  const submitNode = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = parsePublicNodeAddress(nodeDraft, locale)
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
    <section className="dsrc-nodes" aria-label={text('公网节点', 'Public nodes')} data-section="nodes">
      <div className="dsrc-card-head">
        <CardIcon tone="teal">
          <NodeIcon />
        </CardIcon>
        <h3>{text('公网节点', 'Public nodes')}</h3>
        {list.length ? <span className="dsrc-count">{String(list.length)}</span> : null}
      </div>
      {service && serviceState ? (
        <div className="dsrc-service-state" data-tone={serviceState.tone}>
          <span className="dsrc-service-dot" aria-hidden="true" />
          <span>{text('自托管节点', 'Self-hosted node')}</span>
          <strong role="status">{serviceState.label}</strong>
          {serviceState.reason ? (
            <span className="dsrc-service-reason">{`${text('原因：', 'Reason: ')}${serviceState.reason}`}</span>
          ) : null}
          <span className="dsrc-service-origin" title={service.origin}>
            {address(service.origin)}
          </span>
        </div>
      ) : null}
      {entries.pendingReview ? (
        <InlineNotice tone="warn">
          {text('检测到旧公网地址，确认后才会使用。', 'A legacy public address was found; confirm it before use.')}
        </InlineNotice>
      ) : null}
      {list.length ? (
        <ul className="dsrc-node-list" aria-label={text('公网节点', 'Public nodes')}>
          {list.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              current={node.id === entries.current}
              busy={workingNode === node.id}
              manageDisabled={manageDisabled}
              act={act}
              locale={locale}
            />
          ))}
        </ul>
      ) : (
        <p className="dsrc-empty">
          {text(
            '还没有公网节点。填写 https 地址后先检测，确认指纹再使用。',
            'No public nodes yet. Enter an https URL to probe and verify its fingerprint.',
          )}
        </p>
      )}
      <div className="dsrc-node-add">
        <label className="dsrc-field-label" htmlFor="dsrc-node-url">
          {text('添加节点', 'Add node')}
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
            aria-label={text('公网节点 HTTPS 地址', 'Public node HTTPS URL')}
            onChange={(event) => {
              setNodeDraft(event.target.value)
              if (nodeError) setNodeError('')
            }}
          />
          <button type="submit" className="dsrc-button dsrc-primary" disabled={manageDisabled || !nodeDraft.trim()}>
            {workingAction === 'addPublicNode' ? text('正在添加…', 'Adding…') : text('添加', 'Add')}
          </button>
        </form>
        {nodeError ? (
          <p className="dsrc-error" role="alert">
            {nodeError}
          </p>
        ) : null}
        <p className="dsrc-note">
          {state.local
            ? text(
                '只填写 https:// 域名（可带端口），不能包含路径、查询参数或账号密码。',
                'Enter an https:// origin (optional port) with no path, query, or credentials.',
              )
            : text('公网节点只能在本机面板添加、检测或切换。', 'Public nodes can only be managed on the computer.')}
        </p>
        <p className="dsrc-note dsrc-node-trust">
          {text(
            '通过 HTTPS 连接该节点。节点或隧道运营者可能看到转发给本机的请求与内容，本插件不提供端到端加密。请只添加你信任的节点。',
            'Traffic travels over HTTPS through this node. Node or tunnel operators may read forwarded requests and content; no end-to-end encryption is added. Add only nodes you trust.',
          )}
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
  locale,
}: {
  node: PublicNode
  current: boolean
  busy: boolean
  manageDisabled: boolean
  act: (action: string, fields?: Record<string, unknown>) => Promise<boolean>
  locale?: ClientLocale
}): React.ReactElement {
  const text = useText(locale)
  const check = nodeCheckStatus(node, locale)
  const host = nodeHost(node.url)
  const change = node.identityChange

  return (
    <li className="dsrc-node dsrc-row">
      <div className="dsrc-node-main">
        <div className="dsrc-node-title">
          <span className="dsrc-node-name">{node.name?.trim() || host}</span>
          <span className="dsrc-tag dsrc-node-kind" data-kind={node.kind ?? 'unknown'}>
            {nodeKindLabel(node.kind, locale)}
          </span>
          <span
            className="dsrc-tag dsrc-node-protocol"
            data-protocol={node.protocol === 2 ? 'v2' : node.protocol === 1 ? 'v1' : 'unknown'}
          >
            {publicNodeProtocolLabel(node.protocol, locale)}
          </span>
          {current ? <span className="dsrc-tag dsrc-online">{text('当前使用', 'Current')}</span> : null}
          {node.pending ? <span className="dsrc-tag dsrc-pending">{text('待确认', 'Pending')}</span> : null}
          {change ? <span className="dsrc-tag dsrc-pending">{text('身份待确认', 'Identity changed')}</span> : null}
        </div>
        <code className="dsrc-node-url" title={node.url}>
          {address(node.url)}
        </code>
        <div className="dsrc-node-meta">
          <span className="dsrc-node-check" role="status" data-tone={check.tone}>
            {check.label}
          </span>
          <span>{`${text('最近检测 ', 'Checked ')}${checkedAtLabel(node.lastCheckAt, Date.now(), locale)}`}</span>
          {/* A v2 node names its own identity; a v1 record is a single-host gateway and keeps the old label. */}
          {node.protocol === 2 ? (
            <span className="dsrc-node-fingerprint">
              {`${text('节点指纹 ', 'Node fingerprint ')}${nodeFingerprintGroups(publicNodeFingerprint(node), locale)}`}
            </span>
          ) : node.protocol === 1 ? (
            <span className="dsrc-node-fingerprint">
              {`${text('Host 指纹 ', 'Host fingerprint ')}${nodeFingerprintGroups(node.fingerprint, locale)}`}
            </span>
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
              {text('节点身份已变化，需要重新确认。', 'Node identity changed and requires re-confirmation.')}
            </p>
            <p className="dsrc-node-fingerprints">
              {`${text('原节点指纹 ', 'Previous fingerprint ')}${nodeFingerprintGroups(change.from.fingerprint, locale)}`}
            </p>
            <p className="dsrc-node-fingerprints">
              {`${text('新节点指纹 ', 'New fingerprint ')}${nodeFingerprintGroups(change.to.fingerprint, locale)}`}
            </p>
            <button
              type="button"
              className="dsrc-button dsrc-primary"
              disabled={manageDisabled}
              aria-label={text(`重新确认节点 ${host} 的身份`, `Reconfirm identity for ${host}`)}
              onClick={() => {
                if (
                  confirm(
                    text(
                      `确认 ${host} 的新节点指纹？确认前不会通过该节点连接。`,
                      `Confirm the new fingerprint for ${host}? Connections remain blocked until confirmed.`,
                    ),
                  )
                ) {
                  void act('confirmPublicNodeIdentity', { id: node.id })
                }
              }}
            >
              {busy ? text('正在确认…', 'Confirming…') : text('重新确认', 'Reconfirm')}
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
            aria-label={text(`确认使用节点 ${host}`, `Use node ${host}`)}
            onClick={() => {
              void act('setCurrentPublicNode', { id: node.id })
            }}
          >
            {busy ? text('正在确认…', 'Confirming…') : text('确认使用', 'Confirm & use')}
          </button>
          <button
            type="button"
            className="dsrc-button dsrc-ghost"
            disabled={manageDisabled}
            aria-label={text(`忽略节点 ${host}`, `Ignore node ${host}`)}
            onClick={() => {
              void act('removePublicNode', { id: node.id })
            }}
          >
            {busy ? text('正在忽略…', 'Ignoring…') : text('忽略', 'Ignore')}
          </button>
        </div>
      ) : (
        <div className="dsrc-actions dsrc-node-actions">
          <button
            type="button"
            className="dsrc-button dsrc-ghost"
            disabled={manageDisabled}
            aria-label={text(`检测节点 ${host}`, `Check node ${host}`)}
            onClick={() => {
              void act('checkPublicNode', { id: node.id })
            }}
          >
            {busy ? text('正在检测…', 'Checking…') : text('检测', 'Check')}
          </button>
          <button
            type="button"
            className="dsrc-button"
            disabled={manageDisabled || current || !!change}
            aria-label={text(`将节点 ${host} 设为当前`, `Set ${host} as current`)}
            onClick={() => {
              void act('setCurrentPublicNode', { id: node.id })
            }}
          >
            {current
              ? text('当前使用', 'Current')
              : change
                ? text('需先确认身份', 'Confirm identity first')
                : busy
                  ? text('正在切换…', 'Switching…')
                  : text('设为当前', 'Use node')}
          </button>
          <button
            type="button"
            className="dsrc-button dsrc-danger"
            disabled={manageDisabled}
            aria-label={text(`删除节点 ${host}`, `Remove node ${host}`)}
            onClick={() => {
              if (
                confirm(
                  text(
                    `删除公网节点 ${address(node.url)}？通过该节点授权的设备会被撤销。`,
                    `Remove public node ${address(node.url)}? Devices authorized through it will be revoked.`,
                  ),
                )
              ) {
                void act('removePublicNode', { id: node.id })
              }
            }}
          >
            {busy ? text('正在删除…', 'Removing…') : text('删除', 'Remove')}
          </button>
        </div>
      )}
    </li>
  )
}
