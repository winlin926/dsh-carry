import * as React from 'react'
import type { PublicNode, Status } from '../model.js'
import { CardIcon, GearIcon, StatusNote } from './Primitives.js'

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
}: SettingsSectionProps): React.ReactElement {
  const [proxy, setProxy] = React.useState<string | null>(null)
  const [domain, setDomain] = React.useState<string | null>(null)

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
  const certificateLabel = !state.local
    ? '仅本机可管理'
    : !publicUrl
      ? '配置域名后可管理'
      : !certificate
        ? '正在读取证书状态'
        : certificate.pending
          ? '正在申请或续期'
          : certificateExpired
            ? '证书已过期'
            : certificate.selfSigned
              ? 'frpc 自签证书'
              : certificate.expiresAt
                ? `有效至 ${new Date(certificate.expiresAt).toLocaleDateString('zh-CN')}`
                : '尚未申请'

  const lanCertificate = state.lanTls
  const lanCertificateExpired = !!lanCertificate?.expiresAt && lanCertificate.expiresAt <= Date.now()
  const lanCertificateDue = !!lanCertificate?.expiresAt && lanCertificate.expiresAt - Date.now() <= 30 * 24 * 3600_000

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
          连接设置
        </span>
        <span className={`dsrc-summary-value${settingsIssue ? ' dsrc-needs-attention' : ''}`}>
          {settingsIssue || (publicUrl ? '域名已配置' : '域名未配置')}
        </span>
      </summary>
      <div className="dsrc-preferences-body">
        {lanCertificate ? (
          <section className="dsrc-setting-group" aria-label="局域网 HTTPS">
            <div className="dsrc-setting-heading">
              <h3>局域网 HTTPS</h3>
              <span className="dsrc-setting-kicker">固定域名与外部证书</span>
            </div>
            <StatusNote label="入口" value={lanCertificate.origin ?? '开启连接并验证证书后显示'} />
            <div className="dsrc-setting-row">
              <StatusNote
                label="证书"
                value={
                  lanCertificateExpired
                    ? '证书已过期'
                    : lanCertificate.expiresAt
                      ? `有效至 ${new Date(lanCertificate.expiresAt).toLocaleDateString('zh-CN')}`
                      : '尚未读取'
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
                disabled={disabled || !state.local || !state.enabled || state.activeMode !== 'lan'}
                onClick={() => {
                  void act('reloadLanCertificate')
                }}
              >
                {workingAction === 'reloadLanCertificate' ? '正在重载…' : '重载证书'}
              </button>
            </div>
            {lanCertificate.error ? (
              <p className="dsrc-error" role="alert">
                {lanCertificate.error}
              </p>
            ) : null}
            <p className="dsrc-note">
              证书由外部签发和续期；更新文件后在本机重载。域名、证书路径和固定端口在插件配置中设置。
            </p>
            <p className="dsrc-note">{state.lanHint}</p>
          </section>
        ) : null}

        <section className="dsrc-setting-group" aria-label="公网连接">
          <div className="dsrc-setting-heading">
            <h3>公网连接</h3>
            <span className="dsrc-setting-kicker">固定域名与证书</span>
          </div>
          {publicUrl || currentNode?.kind === 'service' ? (
            <label className="dsrc-check">
              <input
                type="checkbox"
                checked={state.mode === 'public'}
                disabled={disabled || !state.local}
                onChange={(event) => {
                  void setPublicEnabled(event.target.checked)
                }}
              />
              启用公网入口
            </label>
          ) : null}
          {state.mode === 'public' ? (
            <div className="dsrc-field">
              <label htmlFor="dsrc-line-preference">线路偏好</label>
              <select
                id="dsrc-line-preference"
                value={state.line ?? 'lan'}
                disabled={disabled || !state.local}
                onChange={(event) => {
                  void act('preferences', { line: event.target.value })
                }}
              >
                <option value="lan">局域网优先</option>
                <option value="public">公网优先</option>
              </select>
            </div>
          ) : null}
          {state.mode === 'public' && currentNode?.kind === 'service' ? (
            <p className="dsrc-note">升级后的自托管节点支持局域网直连和公网自动切换。</p>
          ) : null}

          <div className="dsrc-field dsrc-domain-field">
            <label htmlFor="dsrc-public-url">固定公网域名</label>
            <div className="dsrc-input">
              <input
                id="dsrc-public-url"
                ref={domainInput}
                type="url"
                value={domainDraft}
                placeholder="https://dsh.example.com"
                spellCheck={false}
                autoComplete="off"
                disabled={disabled || !state.local || state.activeMode === 'public'}
                aria-invalid={domainInvalid}
                onChange={(event) => setDomain(event.target.value)}
              />
              <button
                type="button"
                className="dsrc-button"
                disabled={disabled || !state.local || !domainDirty || domainInvalid || state.activeMode === 'public'}
                onClick={() => {
                  void act('preferences', { publicUrl: domainDraft.trim() }).then((saved) => {
                    if (saved) setDomain(null)
                  })
                }}
              >
                保存
              </button>
            </div>
            {domainInvalid ? <p className="dsrc-error">请输入不带路径、账号或密码的 https:// 域名。</p> : null}
            <p className="dsrc-note">
              {!state.local
                ? '域名只能在连接到此电脑的本机面板修改。'
                : state.activeMode === 'public'
                  ? '如需修改域名，请先关闭远程连接。'
                  : `将 frpc 的 80 / 443 转发到本机端口 ${state.publicPort}。`}
            </p>
          </div>

          <div className="dsrc-setting-row">
            <StatusNote
              label="本机身份"
              value={`${state.node.name} · ${state.node.kind === 'gateway' ? '隧道网关' : '自托管服务'}`}
            />
            <StatusNote label="主机指纹" value={state.node.fingerprintGroups} />
          </div>
          <p className="dsrc-note">
            手机首次从公网配对时，页面先显示本机身份与主机指纹；在本机面板确认同一设备名与指纹后，才会下发设备授权。
          </p>
          <div className="dsrc-setting-row">
            <button
              type="button"
              className="dsrc-button"
              disabled={disabled || !state.local || !publicUrl || domainDirty}
              onClick={() => {
                void act('checkPublicUrl')
              }}
            >
              {workingAction === 'checkPublicUrl' ? '正在检测…' : state.publicUrlCheck ? '重新检测' : '检测连通性'}
            </button>
            <StatusNote
              label="域名"
              value={
                state.publicUrlCheck
                  ? state.publicUrlCheck.reachable
                    ? `可访问${state.publicUrlCheck.status ? ` · HTTP ${state.publicUrlCheck.status}` : ''}`
                    : `无法访问${state.publicUrlCheck.error ? ` · ${state.publicUrlCheck.error}` : ''}`
                  : state.local
                    ? '尚未检测'
                    : '仅本机可检测'
              }
              tone={state.publicUrlCheck ? (state.publicUrlCheck.reachable ? 'ok' : 'danger') : 'neutral'}
            />
          </div>

          <div className="dsrc-field dsrc-certificate">
            <div className="dsrc-setting-row">
              <StatusNote
                label="HTTPS 证书"
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
                  disabled ||
                  !state.local ||
                  !publicUrl ||
                  !!certificate?.pending ||
                  !state.enabled ||
                  state.activeMode !== 'public'
                }
                title={!state.enabled || state.activeMode !== 'public' ? '开启公网连接后可申请证书' : undefined}
                onClick={() => {
                  void act('certificate')
                }}
              >
                {certificate?.pending || workingAction === 'certificate'
                  ? '处理中…'
                  : certificate?.expiresAt && !certificateExpired && !certificate.selfSigned
                    ? '续期证书'
                    : '申请证书'}
              </button>
            </div>
            {certificate?.restartRequired ? (
              <p className="dsrc-note">证书已部署，请在 SakuraFrp 中重载对应隧道。</p>
            ) : null}
            {certificate?.error ? <p className="dsrc-error">{`证书错误：${certificate.error}`}</p> : null}
          </div>
        </section>

        <section className="dsrc-setting-group" aria-label="电脑网络代理与手机入口">
          <div className="dsrc-setting-heading">
            <h3>电脑网络代理</h3>
            <span className="dsrc-setting-kicker">
              {proxyMode === 'system' ? '自动检测' : proxyMode === 'manual' ? '手动设置' : '不使用'}
            </span>
          </div>
          <fieldset className="dsrc-mode" aria-label="代理方式">
            {(
              [
                ['off', '不使用'],
                ['system', '自动检测'],
                ['manual', '手动设置'],
              ] as const
            ).map(([id, name]) => (
              <button
                key={id}
                type="button"
                aria-pressed={proxyMode === id}
                disabled={disabled || !state.local}
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
                ? `已检测：${state.systemProxy.url} · ${state.systemProxy.source}`
                : '未检测到系统代理，将直接连接。'}
            </p>
          ) : null}
          {proxyMode === 'manual' ? (
            <div className="dsrc-field dsrc-proxy-field">
              <div className="dsrc-input">
                <input
                  aria-label="电脑端代理地址"
                  placeholder="http://127.0.0.1:7890"
                  value={proxyDraft}
                  aria-invalid={proxyInvalid}
                  disabled={disabled || !state.local}
                  onChange={(event) => setProxy(event.target.value)}
                />
                <button
                  type="button"
                  className="dsrc-button"
                  disabled={disabled || !state.local || !proxyDirty || proxyInvalid}
                  onClick={() => {
                    void act('preferences', { proxy: proxyDraft.trim() }).then((saved) => {
                      if (saved) setProxy(null)
                    })
                  }}
                >
                  保存
                </button>
              </div>
              {proxyInvalid ? <p className="dsrc-error">代理需为不带用户名和密码的 HTTP(S) 地址。</p> : null}
              {!proxyDraft.trim() ? <p className="dsrc-note">留空并保存可移除手动代理。</p> : null}
            </div>
          ) : null}
          <p className="dsrc-note">仅用于电脑的域名检测和证书请求，不改变手机连接。</p>
          <div className="dsrc-field dsrc-browser-entry">
            <span className="dsrc-field-label">手机入口</span>
            {state.links[0]?.url ? (
              <a className="dsrc-button" href={state.links[0].url} target="_blank" rel="noreferrer">
                在浏览器打开
              </a>
            ) : (
              <p className="dsrc-note">开启远程连接后，这里会给出手机要打开的地址。</p>
            )}
            <p className="dsrc-note">手机使用电脑当前版本的 DSH 界面，界面随宿主更新。</p>
          </div>
        </section>
      </div>
    </details>
  )
}
