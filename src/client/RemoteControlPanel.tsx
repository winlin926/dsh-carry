import * as React from 'react'
import { MainConnectionCard } from './components/MainConnectionCard.js'
import {
  AuthorizedDevicesSection,
  PairingRequestsSection,
  ServicePairingsSection,
} from './components/PairingAndDevices.js'
import { ActionFeedback, useText } from './components/Primitives.js'
import { SettingsSection } from './components/SettingsSection.js'
import { UpdateCard, type UpdateManagerResolver } from './components/UpdateCard.js'
import {
  command,
  copyText,
  remoteAdvice,
  remoteDiagnostics,
  remoteRuntime,
  routeName,
  type ClientLocale,
  type Status,
} from './model.js'
import { PluginUpdate } from './plugin-update.js'

const PACKAGE_NAME = '@winlin926/dsh-carry'

/**
 * One update card per page: the check cache has to survive closing and reopening the panel, which
 * unmounts the component but keeps the module alive.
 */
let updateStore: PluginUpdate | null = null
let hostVersion: string | null = null

function updateStoreFor(manager: UpdateManagerResolver): PluginUpdate {
  updateStore ??= new PluginUpdate({ packageName: PACKAGE_NAME, manager, installed: () => hostVersion })
  return updateStore
}

/** The plugin manager arrives after the panel mounts (or never), so the prop is a live resolver. */
export interface PanelProps {
  manager: UpdateManagerResolver
  locale?: ClientLocale
}

export function RemoteControlPanel({ manager, locale }: PanelProps): React.ReactElement {
  const text = useText(locale)
  const runtime = remoteRuntime()
  const remote = React.useSyncExternalStore(
    runtime?.subscribe ?? (() => () => {}),
    runtime?.getSnapshot ?? (() => null),
    () => null,
  )
  const [state, setState] = React.useState<Status | null>(null)
  const [error, setError] = React.useState('')
  const [statusError, setStatusError] = React.useState('')
  const [workingAction, setWorkingAction] = React.useState('')
  const [workingNode, setWorkingNode] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [copyFallback, setCopyFallback] = React.useState<string | null>(null)
  const [feedback, setFeedback] = React.useState<{ target: string; text: string } | null>(null)

  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const confirmAction = (target: string, label: string) => {
    clearTimeout(feedbackTimer.current)
    setFeedback({ target, text: label })
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2200)
  }
  React.useEffect(() => () => clearTimeout(feedbackTimer.current), [])

  const mounted = React.useRef(true)
  const pending = React.useRef(false)
  const revision = React.useRef(0)
  const acting = React.useRef(false)

  const refresh = React.useCallback(async () => {
    if (pending.current || acting.current || document.hidden) return
    pending.current = true
    const ticket = revision.current
    try {
      const data = await command({ action: 'status' })
      if (mounted.current && ticket === revision.current) {
        setState(data)
        setStatusError('')
      }
    } catch (failure) {
      if (mounted.current && ticket === revision.current) {
        setStatusError(failure instanceof Error ? failure.message : '状态读取失败。')
      }
    } finally {
      pending.current = false
    }
  }, [])

  React.useEffect(() => {
    mounted.current = true
    const update = () => {
      void refresh()
    }
    update()
    const timer = setInterval(update, 2000)
    document.addEventListener('visibilitychange', update)
    return () => {
      mounted.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
    }
  }, [refresh])

  const update = updateStoreFor(manager)
  React.useEffect(() => {
    hostVersion = state?.version ?? null
    update.noteInstalled(hostVersion)
  }, [state?.version, update])
  // Opening the panel checks once; the store's ten-minute cache keeps polls and reopenings quiet.
  React.useEffect(() => {
    if (state?.local) void update.check()
  }, [state?.local, update])

  const act = async (action: string, fields: Record<string, unknown> = {}) => {
    if (acting.current) return false
    acting.current = true
    revision.current++
    setWorkingAction(action)
    setWorkingNode(typeof fields.id === 'string' ? fields.id : '')
    setNotice('')
    setCopyFallback(null)
    setError('')
    try {
      const data = await command({ action, ...fields })
      if (data.links) setState(data)
      if (action === 'certificate') setNotice('证书申请或续期已开始，状态会自动更新。')
      else if (action === 'reloadLanCertificate') setNotice('局域网 HTTPS 证书已重载，新连接将使用更新后的证书。')
      else if (action === 'switch') setNotice('已提交切换，当前访问即将断开。请使用新入口重新连接。')
      else if (action === 'stop') {
        setState((previous) =>
          previous
            ? {
                ...previous,
                enabled: false,
                activeMode: undefined,
                phase: 'off',
                links: [],
                requests: [],
                qr: undefined,
              }
            : previous,
        )
        setNotice(
          text('远程连接已关闭，设备授权保留。', 'Remote Control is disabled. Device authorizations are retained.'),
        )
      } else if (['preferences', 'rename'].includes(action)) {
        setNotice(
          action === 'preferences'
            ? text('设置已保存。', 'Settings saved.')
            : text('设备名称已更新。', 'Device name updated.'),
        )
        setTimeout(() => {
          void refresh()
        }, 200)
      } else if (['approve', 'reject', 'revoke', 'revokeAll', 'checkPublicNode'].includes(action)) {
        setTimeout(() => {
          void refresh()
        }, 200)
      } else if (action === 'addPublicNode') {
        setNotice('公网节点已添加并通过检测。')
        setTimeout(() => {
          void refresh()
        }, 200)
      } else if (action === 'setCurrentPublicNode') {
        setNotice('已切换当前使用的公网节点。')
      } else if (action === 'confirmPublicNodeIdentity') {
        setNotice('节点身份已确认，正在重新检测。')
        setTimeout(() => {
          void refresh()
        }, 200)
      } else if (action === 'removePublicNode') {
        setNotice('公网节点已删除，通过它的设备授权已撤销。')
      } else if (action === 'approveServicePairing') {
        setNotice(
          text('设备已确认，可以通过该节点继续连接。', 'Device approved. It can now connect through this node.'),
        )
      } else if (action === 'rejectServicePairing') {
        setNotice(text('已拒绝该设备的配对请求。', 'Pairing request declined.'))
      }
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败。')
      // The Host records a failed probe too, so show the refreshed row even though the call failed.
      if (action === 'addPublicNode' || action === 'checkPublicNode') {
        setTimeout(() => {
          void refresh()
        }, 200)
      }
      return false
    } finally {
      acting.current = false
      setWorkingAction('')
      setWorkingNode('')
    }
  }

  const copy = async (value: string, target: string) => {
    setFeedback(null)
    setCopyFallback(null)
    setNotice('')
    if (await copyText(value)) {
      confirmAction(target, text('已复制', 'Copied'))
      return
    }
    setCopyFallback(value)
    setNotice(
      text(
        '浏览器不允许自动复制，请选中下方内容手动复制。',
        'Automatic copying is unavailable. Select the text below to copy it manually.',
      ),
    )
  }

  const working = !!workingAction
  const disabled = working || !!state?.busy
  const expired = !!state?.expiresAt && Date.now() >= state.expiresAt
  const shown = state?.enabled ? (state.entry ?? state.activeMode) : state?.mode
  const currentNode = state?.publicNodes?.list.find((entry) => entry.id === state?.publicNodes?.current) ?? null
  const publicUrl = state?.publicUrl ?? ''
  const domainBlocked = state?.mode === 'public' && !publicUrl && currentNode?.kind !== 'service'

  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const domainInput = React.useRef<HTMLInputElement>(null)
  const openSettings = React.useCallback((focus = false) => {
    setSettingsOpen(true)
    if (focus) {
      setTimeout(() => {
        domainInput.current?.focus({ preventScroll: true })
        domainInput.current?.scrollIntoView({
          block: 'nearest',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        })
      }, 60)
    }
  }, [])
  React.useEffect(() => {
    if (domainBlocked) setSettingsOpen(true)
  }, [domainBlocked])

  // A renewed one-time pairing ticket does not invalidate already paired devices.
  const renewing = React.useRef(false)
  React.useEffect(() => {
    if (!state?.enabled || !expired || state.busy || acting.current || renewing.current || state.requests.length) return
    renewing.current = true
    const ticket = ++revision.current
    void command({ action: 'refresh' })
      .then(
        (data) => {
          if (mounted.current && ticket === revision.current) setState(data)
        },
        () => {},
      )
      .finally(() => {
        renewing.current = false
      })
  }, [state, expired])

  const setPublicEnabled = async (publicEnabled: boolean) => {
    const mode = publicEnabled ? 'public' : 'lan'
    if (publicEnabled && !publicUrl && currentNode?.kind !== 'service') {
      openSettings(true)
      return
    }
    if ((await act('preferences', { mode })) && state?.enabled) await act('switch')
  }

  const start = () => {
    if (domainBlocked) {
      setNotice(text('请先填写并保存固定公网域名。', 'Enter and save the public domain first.'))
      openSettings(true)
      return
    }
    void act('start')
  }

  const refreshCode = () => {
    if (state?.requests.length) {
      setNotice(
        text(
          '还有配对请求在等待确认，请先处理后再刷新二维码。',
          'Review pending requests before refreshing the QR code.',
        ),
      )
      return
    }
    setFeedback(null)
    void act('refresh').then((saved) => {
      if (saved) confirmAction('qr', text('已刷新', 'Refreshed'))
    })
  }

  const stopConnection = () => {
    if (!state) return
    if (
      !state.local &&
      !confirm(
        text(
          '关闭远程连接会立即断开这台手机，并且只能在电脑上重新开启。继续？',
          'This phone will disconnect immediately. Remote Control can then be enabled from the computer. Continue?',
        ),
      )
    ) {
      return
    }
    void act('stop')
  }

  const online = state?.devices.filter((device) => device.online).length ?? 0
  const connectionState = remote
    ? remote.phase === 'connected'
      ? 'ready'
      : remote.phase === 'blocked'
        ? 'blocked'
        : 'busy'
    : !state
      ? 'loading'
      : state.error
        ? 'error'
        : state.busy || working
          ? 'busy'
          : state.enabled
            ? 'ready'
            : domainBlocked
              ? 'blocked'
              : 'off'

  const connectionLabel = remote
    ? {
        starting: text('正在连接', 'Connecting'),
        reconnecting: text('正在重新连接', 'Reconnecting'),
        connected: text('已连接', 'Connected'),
        blocked: text('连接受限', 'Access blocked'),
      }[remote.phase]
    : !state
      ? statusError
        ? text('读取失败', 'Status unavailable')
        : text('正在读取', 'Checking status')
      : state.error
        ? text('连接失败', 'Connection failed')
        : state.busy || working
          ? text('正在处理', 'Working')
          : state.enabled
            ? online
              ? text('设备已连接', 'Device connected')
              : text('等待手机扫码', 'Waiting for a scan')
            : domainBlocked
              ? text('需要配置域名', 'Domain required')
              : text('未开启', 'Off')

  const advise =
    remote?.reason && Object.hasOwn(remoteAdvice, remote.reason)
      ? remoteAdvice[remote.reason]
      : remoteAdvice['host-unavailable']
  const activeRoute = routeName(remote?.route, locale)
  const subtitle = activeRoute
    ? `${text('当前线路', 'Active route')} · ${activeRoute}`
    : remote?.entry
      ? `${text('连接入口', 'Entry')} · ${remote.entry === 'lan' ? text('局域网', 'Local network') : text('公网', 'Public')}`
      : text('用手机浏览器继续电脑上的会话与审批。', 'Continue your sessions and review approvals on your phone.')

  const certificate = state?.certificate
  const certificateExpired = !!certificate?.expiresAt && certificate.expiresAt <= Date.now()
  const settingsIssue = domainBlocked
    ? '需配置公网域名'
    : shown === 'public' && currentNode?.kind !== 'service' && (certificate?.error || certificateExpired)
      ? '证书需处理'
      : shown === 'public' &&
          currentNode?.kind !== 'service' &&
          state?.publicUrlCheck &&
          !state.publicUrlCheck.reachable
        ? '公网检测未通过'
        : ''

  return (
    <div className="dsrc" data-dsh-plugin="dsh-remote-connect">
      <header className="dsrc-head">
        <div>
          <h2>{text('远程控制', 'Remote Control')}</h2>
          <p className="dsrc-sub">{subtitle}</p>
        </div>
        <span className="dsrc-badge" data-state={connectionState} role="status">
          <span className="dsrc-dot" />
          {connectionLabel}
        </span>
      </header>

      {remote ? (
        <section
          className="dsrc-panel-message"
          aria-label={text('连接诊断', 'Connection diagnostics')}
          data-section="remote-diagnostics"
        >
          {remote.phase === 'reconnecting' || remote.phase === 'blocked' ? (
            <p role="status">{text(advise.zh, advise.en)}</p>
          ) : null}
          <div className="dsrc-action-with-feedback">
            <button
              type="button"
              className="dsrc-button"
              onClick={() => {
                void copy(remoteDiagnostics(remote), 'diagnostics')
              }}
            >
              {text('复制诊断摘要', 'Copy connection diagnostics')}
            </button>
            <ActionFeedback feedback={feedback} target="diagnostics" />
          </div>
        </section>
      ) : null}

      {remote && notice ? (
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

      <div className="dsrc-layout">
        <div className="dsrc-col dsrc-col-main">
          <MainConnectionCard
            state={state}
            remote={remote}
            statusError={statusError}
            error={error}
            notice={notice}
            copyFallback={copyFallback}
            feedback={feedback}
            workingAction={workingAction}
            workingNode={workingNode}
            disabled={disabled}
            expired={expired}
            domainBlocked={domainBlocked}
            connectionState={connectionState}
            connectionLabel={connectionLabel}
            shown={shown}
            currentNode={currentNode}
            locale={locale}
            refresh={refresh}
            refreshCode={refreshCode}
            start={start}
            stopConnection={stopConnection}
            openSettings={openSettings}
            copy={copy}
            act={act}
          />
          {state?.local ? <UpdateCard store={update} version={state.version} /> : null}
        </div>
        <div className="dsrc-col dsrc-col-rail">
          {state ? <PairingRequestsSection state={state} disabled={disabled} act={act} locale={locale} /> : null}
          {state ? (
            <ServicePairingsSection
              state={state}
              disabled={disabled}
              workingAction={workingAction}
              workingNode={workingNode}
              act={act}
              locale={locale}
            />
          ) : null}
          {state ? <AuthorizedDevicesSection state={state} disabled={disabled} act={act} locale={locale} /> : null}
          {state ? (
            <SettingsSection
              state={state}
              currentNode={currentNode}
              settingsOpen={settingsOpen}
              setSettingsOpen={setSettingsOpen}
              settingsIssue={settingsIssue}
              domainInput={domainInput}
              disabled={disabled}
              workingAction={workingAction}
              setPublicEnabled={setPublicEnabled}
              act={act}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
