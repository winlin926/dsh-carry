import type * as React from 'react'
import { address, nodeHost, type ClientLocale, type PublicNode, type RemoteSnapshot, type Status } from '../model.js'
import { ActionFeedback, InlineNotice, useText } from './Primitives.js'
import { PublicNodesSection } from './PublicNodesSection.js'

interface MainConnectionCardProps {
  state: Status | null
  remote: RemoteSnapshot | null
  statusError: string
  error: string
  notice: string
  copyFallback: string | null
  feedback: { target: string; text: string } | null
  workingAction: string
  workingNode: string
  disabled: boolean
  expired: boolean
  domainBlocked: boolean
  connectionState: string
  connectionLabel: string
  shown: 'lan' | 'public' | undefined
  currentNode: PublicNode | null
  locale?: ClientLocale
  refresh: () => Promise<void>
  refreshCode: () => void
  start: () => void
  stopConnection: () => void
  openSettings: (focus?: boolean) => void
  copy: (value: string, target: string) => Promise<void>
  act: (action: string, fields?: Record<string, unknown>) => Promise<boolean>
}

export function MainConnectionCard(props: MainConnectionCardProps): React.ReactElement {
  const {
    state,
    remote,
    statusError,
    error,
    notice,
    copyFallback,
    feedback,
    workingAction,
    workingNode,
    disabled,
    expired,
    domainBlocked,
    connectionState,
    connectionLabel,
    shown,
    currentNode,
    locale,
    refresh,
    refreshCode,
    start,
    stopConnection,
    openSettings,
    copy,
    act,
  } = props
  const text = useText(locale)

  if (!state) {
    return (
      <section className="dsrc-surface dsrc-loading" aria-busy={!statusError} role="status">
        <span className="dsrc-loading-mark" aria-hidden="true" />
        <div>
          <h3>
            {statusError
              ? text('暂时无法读取状态', 'Status unavailable')
              : text('正在读取远程连接', 'Checking Remote Control')}
          </h3>
          <p className="dsrc-note">
            {statusError ||
              text(
                '正在获取连接方式、二维码与授权设备…',
                'Loading the connection details, QR code, and authorized devices…',
              )}
          </p>
        </div>
        {statusError ? (
          <button
            type="button"
            className="dsrc-button"
            onClick={() => {
              void refresh()
            }}
          >
            {text('重试', 'Retry')}
          </button>
        ) : null}
      </section>
    )
  }

  const identityChangePending = currentNode?.identityChange ?? null
  const lanCertificate = state.lanTls
  const lanCertificateDue = !!lanCertificate?.expiresAt && lanCertificate.expiresAt - Date.now() <= 30 * 24 * 3600_000
  const firstURL = state.links[0]?.url
  const online = state.devices.filter((device) => device.online).length
  const localSetup = state.local && shown === 'lan'

  return (
    <section className="dsrc-surface dsrc-workspace" data-section="connection" data-state={connectionState}>
      <div className="dsrc-stage">
        <div className="dsrc-scan">
          {state.qr && !expired ? (
            <div className="dsrc-code" data-ready="true">
              <img
                src={state.qr}
                alt={text('远程连接配对二维码', 'Remote Control pairing QR code')}
                draggable={false}
              />
            </div>
          ) : (
            <div className="dsrc-code">
              <div className="dsrc-placeholder">
                {expired
                  ? text('正在更新二维码…', 'Refreshing QR code…')
                  : state.busy
                    ? text('连接就绪后显示二维码', 'The QR code appears when the connection is ready')
                    : domainBlocked
                      ? text(
                          '配置域名并开启后显示二维码',
                          'Set up a domain and enable the connection to show the QR code',
                        )
                      : text('开启连接后显示配对二维码', 'Enable the connection to show the pairing QR code')}
              </div>
            </div>
          )}
          {state.qr && !expired ? (
            <div className="dsrc-action-with-feedback">
              <button
                type="button"
                className="dsrc-button dsrc-ghost dsrc-code-refresh"
                disabled={disabled}
                onClick={refreshCode}
              >
                {workingAction === 'refresh' ? text('正在刷新…', 'Refreshing…') : text('刷新二维码', 'Refresh QR code')}
              </button>
              <ActionFeedback feedback={feedback} target="qr" />
            </div>
          ) : null}
          {state.enabled && state.qr && !expired ? (
            <p className="dsrc-note">
              {state.entry === 'public' ? text('公网入口', 'Public entry') : text('局域网入口', 'Local network entry')}
            </p>
          ) : null}
        </div>

        <div className="dsrc-brief">
          <div className="dsrc-connection-state">
            <strong>
              {remote
                ? connectionLabel
                : state.busy
                  ? text('正在启动连接…', 'Starting the connection…')
                  : state.enabled
                    ? online
                      ? text('手机已连接，可以继续使用', 'Your phone is connected')
                      : text('连接已就绪，等待手机扫码', 'Ready for your phone to scan')
                    : domainBlocked
                      ? text('还差一个固定公网域名', 'Set up a fixed public domain')
                      : text('开启后，用手机继续操作', 'Continue on your phone')}
            </strong>
            {localSetup ? (
              <p>
                {state.enabled
                  ? text(
                      '手机连到同一 Wi‑Fi 后扫码，再在这台电脑上确认。',
                      'Connect your phone to the same Wi‑Fi, scan the QR code, then approve the request on this computer.',
                    )
                  : text(
                      '让手机和电脑连到同一 Wi‑Fi。开启远程连接后用手机扫码，再在电脑上确认。',
                      'Connect both devices to the same Wi‑Fi. Enable Remote Control, scan with your phone, then approve the request here.',
                    )}
              </p>
            ) : !remote ? (
              <p>
                {state.enabled
                  ? text(
                      '已授权设备可直接使用，新手机请扫码。',
                      'Paired devices can reconnect. Scan the code to pair a new phone.',
                    )
                  : domainBlocked
                    ? text('保存域名后即可开启连接。', 'Save the domain to enable the connection.')
                    : text('开启后，用手机扫描公网二维码。', 'Enable Remote Control and scan the public QR code.')}
              </p>
            ) : null}
          </div>

          {domainBlocked ? (
            <InlineNotice tone="warn" action={{ label: '配置域名', onClick: () => openSettings(true) }}>
              “公网连接”需要固定公网域名，请在“连接设置”里填写。
            </InlineNotice>
          ) : null}

          {identityChangePending && currentNode ? (
            <div className="dsrc-pane-message">
              <InlineNotice tone="danger">
                {`当前公网节点「${currentNode.name?.trim() || nodeHost(currentNode.url)}」的身份已变化，请在下方“公网节点”中重新确认；确认前不会通过该节点连接。`}
              </InlineNotice>
            </div>
          ) : null}

          {shown === 'lan' && lanCertificate ? (
            <InlineNotice tone={lanCertificate.error || lanCertificateDue ? 'warn' : 'info'}>
              {lanCertificate.error ||
                (lanCertificateDue
                  ? '局域网证书即将到期，请在外部续期后，在本机连接设置中重载。'
                  : '使用局域网 HTTPS。请将域名解析到电脑的局域网地址，并使用手机信任的证书。')}
            </InlineNotice>
          ) : null}

          {state.error && !identityChangePending ? (
            <div className="dsrc-pane-message">
              <InlineNotice tone="danger">{state.error}</InlineNotice>
            </div>
          ) : null}

          {state.pairingFailure ? (
            <div className="dsrc-pane-message">
              <InlineNotice tone="danger">
                {`配对被拒绝${state.pairingFailure.name ? `（${state.pairingFailure.name}）` : ''}：${state.pairingFailure.reason}`}
              </InlineNotice>
            </div>
          ) : null}

          {state.activeMode === 'public' && state.entry === 'lan' && !identityChangePending ? (
            <InlineNotice tone="warn" action={{ label: '检查设置', onClick: () => openSettings() }}>
              {state.publicUrlCheck?.error ??
                state.serviceNode?.lastError ??
                '正在检测公网入口。当前二维码可在同一 Wi‑Fi 使用。'}
            </InlineNotice>
          ) : null}

          <div className="dsrc-connection-actions">
            {state.enabled ? (
              <button type="button" className="dsrc-button dsrc-stop" disabled={disabled} onClick={stopConnection}>
                {workingAction === 'stop'
                  ? text('正在关闭…', 'Disabling…')
                  : text('关闭远程连接', 'Disable Remote Control')}
              </button>
            ) : (
              <button type="button" className="dsrc-button dsrc-primary dsrc-start" disabled={disabled} onClick={start}>
                {state.busy || workingAction === 'start'
                  ? text('正在开启…', 'Enabling…')
                  : domainBlocked
                    ? text('先配置域名', 'Set up a domain')
                    : text('开启远程连接', 'Enable Remote Control')}
              </button>
            )}
          </div>

          {localSetup ? (
            <button type="button" className="dsrc-button dsrc-ghost" onClick={() => openSettings(true)}>
              {text('离开同一 Wi‑Fi 后也要用？', 'Connect from another network?')}
            </button>
          ) : null}

          <label className="dsrc-toggle">
            <input
              type="checkbox"
              checked={state.autoStart}
              disabled={disabled}
              onChange={(event) => {
                void act('preferences', { autoStart: event.target.checked })
              }}
            />
            {text('随 DSH 自动开启', 'Enable when DSH starts')}
          </label>

          {firstURL && !expired ? (
            <div className="dsrc-pair-link">
              <code className="dsrc-link" title={address(firstURL)}>
                {address(firstURL)}
              </code>
              <div className="dsrc-action-with-feedback">
                <button
                  type="button"
                  className="dsrc-button"
                  onClick={() => {
                    void copy(firstURL, firstURL)
                  }}
                >
                  {text('复制链接', 'Copy link')}
                </button>
                <ActionFeedback feedback={feedback} target={firstURL} />
              </div>
            </div>
          ) : null}

          {state.links.length > 1 ? (
            <details className="dsrc-networks">
              <summary>{`其他网卡（${state.links.length - 1}）`}</summary>
              <div className="dsrc-alt-links">
                {state.links.slice(1).map((link) => (
                  <div key={link.base} className="dsrc-action-with-feedback">
                    <button
                      type="button"
                      className="dsrc-button dsrc-address-button"
                      title="复制此网卡的完整配对链接"
                      disabled={!link.url}
                      onClick={() => {
                        if (link.url) void copy(link.url, link.base)
                      }}
                    >
                      {address(link.base)}
                    </button>
                    <ActionFeedback feedback={feedback} target={link.base} />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </div>

      {state.local || shown === 'public' ? (
        <PublicNodesSection
          state={state}
          disabled={disabled}
          workingAction={workingAction}
          workingNode={workingNode}
          act={act}
        />
      ) : null}

      {statusError ? (
        <div className="dsrc-panel-message" data-tone="warn" role="alert">
          <span>{`状态更新失败，当前显示上次结果。${statusError}`}</span>
          <button
            type="button"
            className="dsrc-button"
            onClick={() => {
              void refresh()
            }}
          >
            重试
          </button>
        </div>
      ) : null}

      {error && error !== state.error ? (
        <div className="dsrc-panel-message" data-tone="danger" role="alert">
          {error}
        </div>
      ) : null}

      {!remote && notice ? (
        <div className="dsrc-panel-message" data-tone="info" role="status">
          {notice}
          {copyFallback !== null ? (
            <textarea
              className="dsrc-copy-fallback"
              readOnly
              aria-label={text('待复制内容，可全选复制', 'Text to copy')}
              value={copyFallback}
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
