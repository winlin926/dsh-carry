import * as React from 'react'
import { routeName, when, type ClientLocale, type Status } from '../model.js'
import { avatarTone, BellIcon, CardIcon, DeviceIcon, InlineNotice, useText } from './Primitives.js'

interface SharedSectionProps {
  state: Status
  disabled: boolean
  act: (action: string, fields?: Record<string, unknown>) => Promise<boolean>
  locale?: ClientLocale
}

export function PairingRequestsSection({
  state,
  disabled,
  act,
  locale,
}: SharedSectionProps): React.ReactElement | null {
  const text = useText(locale)
  if (!state.local || !state.requests.length) return null

  return (
    <section className="dsrc-surface dsrc-requests" data-section="requests">
      <div className="dsrc-card-head">
        <CardIcon tone="warm">
          <BellIcon />
        </CardIcon>
        <h3>{text('待确认配对', 'Pairing requests')}</h3>
        <span className="dsrc-tag dsrc-pending">{String(state.requests.length)}</span>
      </div>
      <p className="dsrc-note">
        {text(
          '手机正在等待本机确认。请核对设备名；公网配对还要核对主机指纹。',
          'Your phone is waiting for approval. Check the device name and, for public connections, compare the host fingerprint.',
        )}
      </p>
      {state.requests.map((request) => (
        <div key={request.id} className="dsrc-device dsrc-row">
          <div className="dsrc-device-main">
            <div className="dsrc-device-name">
              {request.name}
              <span className="dsrc-tag" data-way={request.via}>
                {request.via === 'public' ? text('公网入口', 'Public entry') : text('局域网', 'Local network')}
              </span>
              {request.via === 'public' ? (
                <span className="dsrc-tag">
                  {request.nodeConfirmed
                    ? text('手机已确认本机', 'Confirmed on the phone')
                    : text('手机未确认', 'Waiting for phone confirmation')}
                </span>
              ) : null}
            </div>
            <div className="dsrc-muted">
              {request.via === 'public'
                ? `${text('主机指纹', 'Host fingerprint')} ${state.node.fingerprintGroups}`
                : text('局域网配对请求', 'Local network pairing request')}
            </div>
          </div>
          <div className="dsrc-actions">
            <button
              type="button"
              className="dsrc-button"
              disabled={disabled}
              onClick={() => {
                void act('reject', { id: request.id })
              }}
            >
              {text('拒绝', 'Decline')}
            </button>
            <button
              type="button"
              className="dsrc-button dsrc-primary"
              disabled={disabled}
              onClick={() => {
                void act('approve', { id: request.id, name: request.name, fingerprint: state.node.fingerprint })
              }}
            >
              {text('允许连接', 'Allow connection')}
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}

/** Devices waiting on this Host to confirm a pairing with the self-hosted public node. */
export function ServicePairingsSection({
  state,
  disabled,
  workingAction,
  workingNode,
  act,
  locale,
}: SharedSectionProps & {
  workingAction: string
  workingNode: string
}): React.ReactElement | null {
  const text = useText(locale)
  const pairings = state.serviceNode?.pendingPairings ?? []
  if (!state.local || !pairings.length) return null

  return (
    <section className="dsrc-surface dsrc-requests" data-section="service-pairings">
      <div className="dsrc-card-head">
        <CardIcon tone="warm">
          <BellIcon />
        </CardIcon>
        <h3>{text('待确认配对', 'Pairing requests')}</h3>
        <span className="dsrc-tag dsrc-pending">{String(pairings.length)}</span>
      </div>
      <p className="dsrc-note">
        {text(
          '手机正在等待本机确认。确认后，该设备可以通过自托管公网节点继续连接。',
          'The phone is waiting for your approval. Once approved, it can connect through the self-hosted public node.',
        )}
      </p>
      {pairings.map((pairing) => (
        <div key={pairing.requestId} className="dsrc-device dsrc-row">
          <div className="dsrc-device-main">
            <div className="dsrc-device-name">{pairing.deviceName}</div>
            <div className="dsrc-muted">{`${text('过期时间', 'Expires')} ${when(pairing.expiresAt, locale)}`}</div>
          </div>
          <div className="dsrc-actions">
            <button
              type="button"
              className="dsrc-button"
              disabled={disabled}
              aria-label={text(`拒绝设备 ${pairing.deviceName}`, `Decline ${pairing.deviceName}`)}
              onClick={() => {
                void act('rejectServicePairing', { id: pairing.requestId })
              }}
            >
              {workingNode === pairing.requestId && workingAction === 'rejectServicePairing'
                ? text('正在拒绝…', 'Declining…')
                : text('拒绝', 'Decline')}
            </button>
            <button
              type="button"
              className="dsrc-button dsrc-primary"
              disabled={disabled}
              aria-label={text(`确认设备 ${pairing.deviceName}`, `Approve ${pairing.deviceName}`)}
              onClick={() => {
                void act('approveServicePairing', { id: pairing.requestId })
              }}
            >
              {workingNode === pairing.requestId && workingAction === 'approveServicePairing'
                ? text('正在确认…', 'Approving…')
                : text('确认', 'Approve')}
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}

export function AuthorizedDevicesSection({ state, disabled, act, locale }: SharedSectionProps): React.ReactElement {
  const text = useText(locale)

  return (
    <section className="dsrc-surface dsrc-devices" data-section="devices">
      <div className="dsrc-card-head">
        <CardIcon tone="violet">
          <DeviceIcon />
        </CardIcon>
        <h3>{text('已授权设备', 'Authorized devices')}</h3>
        {state.devices.length ? <span className="dsrc-count">{String(state.devices.length)}</span> : null}
        <span className="dsrc-spacer" aria-hidden="true" />
        {state.devices.length ? (
          <button
            type="button"
            className="dsrc-button dsrc-danger"
            disabled={disabled}
            onClick={() => {
              if (
                confirm(
                  text(
                    `确定撤销全部 ${state.devices.length} 台设备的授权？所有已授权手机都需要重新配对。`,
                    `Revoke authorization for all ${state.devices.length} devices? All paired phones will need to pair again.`,
                  ),
                )
              ) {
                void act('revokeAll')
              }
            }}
          >
            {text('撤销全部', 'Revoke all')}
          </button>
        ) : null}
      </div>
      {state.devices.length ? (
        <div className="dsrc-device-list">
          {state.devices.map((device) => (
            <DeviceRow key={device.id} device={device} disabled={disabled} act={act} locale={locale} />
          ))}
        </div>
      ) : (
        <p className="dsrc-empty">
          {text('暂无设备，扫码确认后会显示在这里。', 'Paired devices appear here after you approve their requests.')}
        </p>
      )}
      {state.repairRequired ? (
        <InlineNotice tone="warn">
          {text(
            `有 ${state.repairRequired} 台设备是通过旧公网入口授权的，升级后已标记为需要重新配对；旧授权不再放行。`,
            `${state.repairRequired} device(s) paired through the legacy public entry require re-pairing and are no longer admitted.`,
          )}
        </InlineNotice>
      ) : null}
      <p className="dsrc-note">
        {text('连续 30 天未使用的设备授权会过期。', 'Device authorizations expire after 30 days of inactivity.')}
      </p>
    </section>
  )
}

function DeviceRow({
  device,
  disabled,
  act,
  locale,
}: {
  device: Status['devices'][number]
  disabled: boolean
  act: (action: string, fields?: Record<string, unknown>) => Promise<unknown>
  locale?: ClientLocale
}): React.ReactElement {
  const text = useText(locale)
  const route = routeName(device.route, locale)
  const [name, setName] = React.useState<string | null>(null)
  const renameInput = React.useRef<HTMLInputElement>(null)
  const finished = React.useRef(false)

  React.useEffect(() => {
    if (name !== null) renameInput.current?.focus()
  }, [name])

  const finish = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    const next = save ? name?.trim() : ''
    setName(null)
    if (next && next !== device.name) void act('rename', { id: device.id, name: next })
  }

  return (
    <div className="dsrc-device dsrc-row">
      <span className="dsrc-avatar" data-tone={avatarTone(device.id)} aria-hidden="true">
        {(device.name.trim().charAt(0) || '·').toUpperCase()}
      </span>
      <div className="dsrc-device-main">
        {name === null ? (
          <div className="dsrc-device-name">
            {device.name}
            {route ? (
              <span className="dsrc-tag" data-way={device.route}>
                {route}
              </span>
            ) : null}
            {device.requiresRepair ? (
              <span className="dsrc-tag dsrc-pending">{text('需重新配对', 'Re-pair required')}</span>
            ) : null}
            {device.online ? <span className="dsrc-tag dsrc-online">{text('在线', 'Online')}</span> : null}
          </div>
        ) : (
          <input
            ref={renameInput}
            className="dsrc-rename"
            aria-label={text(`重命名 ${device.name}`, `Rename ${device.name}`)}
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault()
                finish(event.key === 'Enter')
              }
            }}
          />
        )}
        <div className="dsrc-device-meta">
          {text(
            `配对于 ${when(device.createdAt, locale)} · 最近使用 ${when(device.lastSeenAt, locale)}`,
            `Paired ${when(device.createdAt, locale)} · Last used ${when(device.lastSeenAt, locale)}`,
          )}
        </div>
      </div>
      <div className="dsrc-actions">
        <button
          type="button"
          className="dsrc-button dsrc-ghost"
          disabled={disabled}
          onClick={() => {
            finished.current = false
            setName(device.name)
          }}
        >
          {text('重命名', 'Rename')}
        </button>
        <button
          type="button"
          className="dsrc-button dsrc-danger"
          disabled={disabled}
          onClick={() => {
            if (
              confirm(
                text(
                  `撤销“${device.name}”的授权？这台设备需要重新扫码配对。`,
                  `Revoke authorization for "${device.name}"? This device will need to pair again.`,
                ),
              )
            ) {
              void act('revoke', { id: device.id })
            }
          }}
        >
          {text('撤销授权', 'Revoke')}
        </button>
      </div>
    </div>
  )
}
