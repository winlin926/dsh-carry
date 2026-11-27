import * as React from 'react'
import { nodeHost, when, type ClientLocale, type PublicNode, type Status } from '../model.js'
import { CardIcon, GearIcon, StatusNote, useText } from './Primitives.js'

interface SettingsSectionProps {
  state: Status
  currentNode: PublicNode | null
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  settingsIssue: string
  domainInput: React.RefObject<HTMLInputElement>
  disabled: boolean
  workingAction: string
  setPublicEnabled: (enabled: boolean) => Promise<void>
  act: (action: string, fields?: Record<string, unknown>) => Promise<boolean>
  locale?: ClientLocale
}

export function SettingsSection({
  state,
  currentNode,
  settingsOpen,
  setSettingsOpen,
  settingsIssue,
  domainInput,
  disabled,
  workingAction,
  setPublicEnabled,
  act,
  locale,
}: SettingsSectionProps): React.ReactElement {
  const text = useText(locale)
  const [proxy, setProxy] = React.useState<string | null>(null)
  const [domain, setDomain] = React.useState<string | null>(null)

  if (!state.local) {
    return (
      <section className="dsrc-surface" data-section="settings-readonly" aria-label={text('本机设置', 'Host settings')}>
        <div className="dsrc-card-head">
          <CardIcon tone="slate">
            <GearIcon />
          </CardIcon>
          <h3>{text('连接设置', 'Connection settings')}</h3>
        </div>
        <div className="dsrc-setting-row">
          <StatusNote
            label={text('连接方式', 'Connection mode')}
            value={state.mode === 'public' ? text('公网连接', 'Public connection') : text('同一 Wi‑Fi', 'Same Wi‑Fi')}
          />
          {state.mode === 'public' ? (
            <StatusNote
              label={text('线路偏好', 'Route preference')}
              value={state.line === 'public' ? text('公网优先', 'Public first') : text('局域网优先', 'LAN first')}
            />
          ) : null}
        </div>
        <div className="dsrc-setting-row">
          <StatusNote
            label={text('本机身份', 'Host identity')}
            value={`${state.node.name} · ${state.node.kind === 'gateway' ? text('隧道网关', 'Tunnel gateway') : text('自托管服务', 'Self-hosted relay')}`}
          />
          <StatusNote label={text('主机指纹', 'Host fingerprint')} value={state.node.fingerprintGroups} />
        </div>
        <p className="dsrc-note">
          {text(
            '固定域名、公网节点、开机自启与证书管理只能在电脑端 DSH 修改。',
            'Fixed domains, public nodes, startup preferences, and certificates can only be changed on the computer.',
          )}
        </p>
      </section>
    )
  }

  const proxyMode = state.proxyMode ?? 'off'
  const proxyDraft = proxy ?? state.manualProxy ?? ''
  const proxyDirty = proxy !== null && proxyDraft.trim() !== (state.manualProxy ?? '')
  let proxyInvalid = false
  if (proxyDraft.trim()) {
    try {
      const url = new URL(proxyDraft.trim())
      proxyInvalid = !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password
    } catch {
      proxyInvalid = true
    }
  }

  const publicUrl = state.publicUrl ?? ''
  const isServiceNode = currentNode?.kind === 'service'
  const domainDraft = domain ?? publicUrl
  const domainDirty = domain !== null && domainDraft.trim() !== publicUrl
  let domainInvalid = false
  if (domainDirty && domainDraft.trim()) {
    try {
      const url = new URL(domainDraft.trim())
      domainInvalid =
        url.protocol !== 'https:' ||
        url.pathname !== '/' ||
        !!url.username ||
        !!url.password ||
        !!url.search ||
        !!url.hash ||
        !url.hostname.includes('.')
    } catch {
      domainInvalid = true
    }
  }

  const certificate = state.certificate
  const certificateExpired = !!certificate?.expiresAt && certificate.expiresAt <= Date.now()
  const certificateLabel = !publicUrl
    ? text('配置域名后可管理', 'Available after setting a domain')
    : !certificate
      ? text('正在读取证书状态', 'Reading certificate status')
      : certificate.pending
        ? text('正在申请或续期', 'Issuing or renewing')
        : certificateExpired
          ? text('证书已过期', 'Certificate expired')
          : certificate.selfSigned
            ? text('frpc 自签证书', 'frpc self-signed')
            : certificate.expiresAt
              ? text(
                  `有效至 ${when(certificate.expiresAt, locale)}`,
                  `Valid until ${when(certificate.expiresAt, locale)}`,
                )
              : text('尚未申请', 'Not issued')

  const lanCertificate = state.lanTls
  const lanCertificateExpired = !!lanCertificate?.expiresAt && lanCertificate.expiresAt <= Date.now()
  const lanCertificateDue = !!lanCertificate?.expiresAt && lanCertificate.expiresAt - Date.now() <= 30 * 24 * 3600_000

  const summaryLabel =
    settingsIssue ||
    (isServiceNode && currentNode
      ? text(`自托管节点 · ${nodeHost(currentNode.url)}`, `Self-hosted · ${nodeHost(currentNode.url)}`)
      : publicUrl
        ? text('域名已配置', 'Domain configured')
        : text('域名未配置', 'No domain set'))

  const gatewayConfig = (
    <>
      <div className="dsrc-field dsrc-domain-field">
        <label htmlFor="dsrc-public-url">{text('固定公网域名', 'Fixed public domain')}</label>
        <div className="dsrc-input">
          <input
            id="dsrc-public-url"
            ref={domainInput}
            type="url"
            value={domainDraft}
            placeholder="https://dsh.example.com"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled || state.activeMode === 'public'}
            aria-invalid={domainInvalid}
            onChange={(event) => setDomain(event.target.value)}
          />
          <button
            type="button"
            className="dsrc-button"
            disabled={disabled || !domainDirty || domainInvalid || state.activeMode === 'public'}
            onClick={() => {
              void act('preferences', { publicUrl: domainDraft.trim() }).then((saved) => {
                if (saved) setDomain(null)
              })
            }}
          >
            {text('保存', 'Save')}
          </button>
        </div>
        {domainInvalid ? (
          <p className="dsrc-error">
            {text(
              '请输入不带路径、账号或密码的 https:// 域名。',
              'Enter an https:// domain without path or credentials.',
            )}
          </p>
        ) : null}
        <p className="dsrc-note">
          {state.activeMode === 'public'
            ? text('如需修改域名，请先关闭远程连接。', 'Disable Remote Control before changing the domain.')
            : text(
                `将 frpc 的 80 / 443 转发到本机端口 ${state.publicPort}。`,
                `Forward frpc ports 80 / 443 to local port ${state.publicPort}.`,
              )}
        </p>
      </div>

      <div className="dsrc-setting-row">
        <button
          type="button"
          className="dsrc-button"
          disabled={disabled || !publicUrl || domainDirty}
          onClick={() => {
            void act('checkPublicUrl')
          }}
        >
          {workingAction === 'checkPublicUrl'
            ? text('正在检测…', 'Checking…')
            : state.publicUrlCheck
              ? text('重新检测', 'Check again')
              : text('检测连通性', 'Check connectivity')}
        </button>
        <StatusNote
          label={text('域名', 'Domain')}
          value={
            state.publicUrlCheck
              ? state.publicUrlCheck.reachable
                ? `${text('可访问', 'Reachable')}${state.publicUrlCheck.status ? ` · HTTP ${state.publicUrlCheck.status}` : ''}`
                : `${text('无法访问', 'Unreachable')}${state.publicUrlCheck.error ? ` · ${state.publicUrlCheck.error}` : ''}`
              : text('尚未检测', 'Not checked')
          }
          tone={state.publicUrlCheck ? (state.publicUrlCheck.reachable ? 'ok' : 'danger') : 'neutral'}
        />
      </div>

      <div className="dsrc-field dsrc-certificate">
        <div className="dsrc-setting-row">
          <StatusNote
            label={text('HTTPS 证书', 'HTTPS certificate')}
            value={certificateLabel}
            tone={
              certificateExpired || certificate?.error
                ? 'danger'
                : certificate?.pending
                  ? 'warn'
                  : certificate?.expiresAt && !certificate.selfSigned
                    ? 'ok'
                    : 'neutral'
            }
          />
          <button
            type="button"
            className="dsrc-button"
            disabled={
              disabled || !publicUrl || !!certificate?.pending || !state.enabled || state.activeMode !== 'public'
            }
            title={
              !state.enabled || state.activeMode !== 'public'
                ? text('开启公网连接后可申请证书', 'Enable public connection first to request a certificate')
                : undefined
            }
            onClick={() => {
              void act('certificate')
            }}
          >
            {certificate?.pending || workingAction === 'certificate'
              ? text('正在申请…', 'Requesting…')
              : certificateExpired
                ? text('立即续期', 'Renew now')
                : certificate?.expiresAt
                  ? text('申请 / 续期证书', 'Request / renew')
                  : text('申请证书', 'Request certificate')}
          </button>
        </div>
        {certificate?.error ? (
          <p className="dsrc-error">{`${text('证书错误：', 'Certificate error: ')}${certificate.error}`}</p>
        ) : null}
      </div>
    </>
  )

  return (
    <details
      className="dsrc-surface dsrc-preferences"
      data-needed={!!settingsIssue}
      open={settingsOpen}
      onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="dsrc-settings-title">
          <CardIcon tone="slate">
            <GearIcon />
          </CardIcon>
          {text('连接设置', 'Connection settings')}
        </span>
        <span className={`dsrc-summary-value${settingsIssue ? ' dsrc-needs-attention' : ''}`}>{summaryLabel}</span>
      </summary>
      <div className="dsrc-preferences-body">
        {lanCertificate ? (
          <section className="dsrc-setting-group" aria-label={text('局域网 HTTPS', 'LAN HTTPS')}>
            <div className="dsrc-setting-heading">
              <h3>{text('局域网 HTTPS', 'LAN HTTPS')}</h3>
              <span className="dsrc-setting-kicker">{text('固定域名与外部证书', 'Fixed domain & external cert')}</span>
            </div>
            <StatusNote
              label={text('入口', 'Entry')}
              value={
                lanCertificate.origin ?? text('开启连接并验证证书后显示', 'Shown after starting and verifying cert')
              }
            />
            <div className="dsrc-setting-row">
              <StatusNote
                label={text('证书', 'Certificate')}
                value={
                  lanCertificateExpired
                    ? text('证书已过期', 'Certificate expired')
                    : lanCertificate.expiresAt
                      ? text(
                          `有效至 ${when(lanCertificate.expiresAt, locale)}`,
                          `Valid until ${when(lanCertificate.expiresAt, locale)}`,
                        )
                      : text('尚未读取', 'Not loaded')
                }
                tone={
                  lanCertificateExpired
                    ? 'danger'
                    : lanCertificateDue
                      ? 'warn'
                      : lanCertificate.expiresAt
                        ? 'ok'
                        : 'neutral'
                }
              />
              <button
                type="button"
                className="dsrc-button"
                disabled={disabled || !state.enabled || state.activeMode !== 'lan'}
                onClick={() => {
                  void act('reloadLanCertificate')
                }}
              >
                {workingAction === 'reloadLanCertificate'
                  ? text('正在重载…', 'Reloading…')
                  : text('重载证书', 'Reload cert')}
              </button>
            </div>
            {lanCertificate.error ? (
              <p className="dsrc-error" role="alert">
                {lanCertificate.error}
              </p>
            ) : null}
            <p className="dsrc-note">
              {text(
                '证书由外部签发和续期；更新文件后在本机重载。域名、证书路径和固定端口在插件配置中设置。',
                'Certificates are issued and renewed externally; reload here after updating files. Domain, paths, and port are set in plugin config.',
              )}
            </p>
            <p className="dsrc-note">{state.lanHint}</p>
          </section>
        ) : null}

        <section className="dsrc-setting-group" aria-label={text('公网连接', 'Public connection')}>
          <div className="dsrc-setting-heading">
            <h3>{text('公网连接', 'Public connection')}</h3>
            <span className="dsrc-setting-kicker">
              {isServiceNode ? text('自托管中继', 'Self-hosted relay') : text('固定域名与证书', 'Fixed domain & TLS')}
            </span>
          </div>
          {publicUrl || isServiceNode ? (
            <label className="dsrc-check">
              <input
                type="checkbox"
                checked={state.mode === 'public'}
                disabled={disabled}
                onChange={(event) => {
                  void setPublicEnabled(event.target.checked)
                }}
              />
              {text('启用公网入口', 'Enable public entry')}
            </label>
          ) : null}
          {state.mode === 'public' ? (
            <div className="dsrc-field">
              <label htmlFor="dsrc-line-preference">{text('线路偏好', 'Route preference')}</label>
              <select
                id="dsrc-line-preference"
                value={state.line ?? 'lan'}
                disabled={disabled}
                onChange={(event) => {
                  void act('preferences', { line: event.target.value })
                }}
              >
                <option value="lan">{text('局域网优先', 'LAN first')}</option>
                <option value="public">{text('公网优先', 'Public first')}</option>
              </select>
            </div>
          ) : null}
          {state.mode === 'public' && isServiceNode ? (
            <p className="dsrc-note">
              {text(
                '升级后的自托管节点支持局域网直连和公网自动切换。',
                'Upgraded self-hosted nodes support LAN direct + public failover.',
              )}
            </p>
          ) : null}

          {isServiceNode && !publicUrl ? (
            <details className="dsrc-networks">
              <summary>
                {text(
                  '隧道网关高级设置（仅自建 frpc 网关需要）',
                  'Tunnel gateway settings (only for self-managed frpc)',
                )}
              </summary>
              <div className="dsrc-field">{gatewayConfig}</div>
            </details>
          ) : (
            gatewayConfig
          )}

          <div className="dsrc-setting-row">
            <StatusNote
              label={text('本机身份', 'Host identity')}
              value={`${state.node.name} · ${state.node.kind === 'gateway' ? text('隧道网关', 'Tunnel gateway') : text('自托管服务', 'Self-hosted relay')}`}
            />
            <StatusNote label={text('主机指纹', 'Host fingerprint')} value={state.node.fingerprintGroups} />
          </div>
          <p className="dsrc-note">
            {text(
              '手机首次从公网配对时，页面先显示本机身份与主机指纹；在本机面板确认同一设备名与指纹后，才会下发设备授权。',
              'For public pairing, the phone displays host identity and fingerprint first; verify them here before approving.',
            )}
          </p>
        </section>

        <section
          className="dsrc-setting-group"
          aria-label={text('电脑网络代理与手机入口', 'Desktop proxy & phone entry')}
        >
          <div className="dsrc-setting-heading">
            <h3>{text('电脑网络代理', 'Computer outbound proxy')}</h3>
            <span className="dsrc-setting-kicker">
              {proxyMode === 'system'
                ? text('自动检测', 'Auto-detect')
                : proxyMode === 'manual'
                  ? text('手动设置', 'Manual')
                  : text('不使用', 'Off')}
            </span>
          </div>
          <fieldset className="dsrc-mode" aria-label={text('代理方式', 'Proxy mode')}>
            {(
              [
                ['off', text('不使用', 'Off')],
                ['system', text('自动检测', 'Auto-detect')],
                ['manual', text('手动设置', 'Manual')],
              ] as const
            ).map(([id, name]) => (
              <button
                key={id}
                type="button"
                aria-pressed={proxyMode === id}
                disabled={disabled}
                onClick={() => {
                  void act('preferences', { proxyMode: id })
                }}
              >
                {name}
              </button>
            ))}
          </fieldset>
          {proxyMode === 'system' ? (
            <p className="dsrc-note">
              {state.systemProxy
                ? text(
                    `已检测：${state.systemProxy.url} · ${state.systemProxy.source}`,
                    `Detected: ${state.systemProxy.url} · ${state.systemProxy.source}`,
                  )
                : text('未检测到系统代理，将直接连接。', 'No system proxy detected; connecting directly.')}
            </p>
          ) : null}
          {proxyMode === 'manual' ? (
            <div className="dsrc-field dsrc-proxy-field">
              <div className="dsrc-input">
                <input
                  aria-label={text('电脑端代理地址', 'Computer proxy URL')}
                  placeholder="http://127.0.0.1:7890"
                  value={proxyDraft}
                  aria-invalid={proxyInvalid}
                  disabled={disabled}
                  onChange={(event) => setProxy(event.target.value)}
                />
                <button
                  type="button"
                  className="dsrc-button"
                  disabled={disabled || !proxyDirty || proxyInvalid}
                  onClick={() => {
                    void act('preferences', { proxy: proxyDraft.trim() }).then((saved) => {
                      if (saved) setProxy(null)
                    })
                  }}
                >
                  {text('保存', 'Save')}
                </button>
              </div>
              {proxyInvalid ? (
                <p className="dsrc-error">
                  {text(
                    '代理需为不带用户名和密码的 HTTP(S) 地址。',
                    'Proxy must be an HTTP(S) URL without credentials.',
                  )}
                </p>
              ) : null}
              {!proxyDraft.trim() ? (
                <p className="dsrc-note">{text('留空并保存可移除手动代理。', 'Leave empty and save to clear.')}</p>
              ) : null}
            </div>
          ) : null}
          <p className="dsrc-note">
            {text(
              '仅用于电脑的域名检测和证书请求，不改变手机连接。',
              'Used only for domain checks and certificate requests on this computer.',
            )}
          </p>
          <div className="dsrc-field dsrc-browser-entry">
            <span className="dsrc-field-label">{text('手机入口', 'Browser entry')}</span>
            {state.links[0]?.url ? (
              <a className="dsrc-button" href={state.links[0].url} target="_blank" rel="noreferrer">
                {text('在浏览器打开', 'Open in browser')}
              </a>
            ) : (
              <p className="dsrc-note">
                {text(
                  '开启远程连接后，这里会给出手机要打开的地址。',
                  'Enable Remote Control to generate the pairing link.',
                )}
              </p>
            )}
            <p className="dsrc-note">
              {text(
                '手机使用电脑当前版本的 DSH 界面，界面随宿主更新。',
                'The phone uses this host’s live DSH interface.',
              )}
            </p>
          </div>
        </section>
      </div>
    </details>
  )
}
