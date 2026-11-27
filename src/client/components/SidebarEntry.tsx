import * as React from 'react'
import { command, when, type ClientLocale, type ServicePairing } from '../model.js'
import { RemoteControlPanel, type PanelProps } from '../RemoteControlPanel.js'
import { PanelIcon, useText } from './Primitives.js'

interface Waiting {
  enabled: boolean
  node: { name: string; fingerprint: string; fingerprintGroups: string }
  requests: Array<{ id: string; name: string; via: 'lan' | 'public'; nodeConfirmed: boolean; expiresAt: number }>
  servicePairings?: ServicePairing[]
}

/** Pairing approvals belong to the Host page; both gateway routes set the remote marker before mounting. */
export function watchLocalPairings(check: () => void): (() => void) | undefined {
  if ((globalThis as { __DSH_REMOTE_CONTROL__?: boolean }).__DSH_REMOTE_CONTROL__ === true) return
  const poll = () => {
    if (!document.hidden) check()
  }
  poll()
  const timer = setInterval(poll, 2500)
  document.addEventListener('visibilitychange', poll)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', poll)
  }
}

/** Pairing requests pop up on the computer as they arrive, so they are not missed while the panel is closed. */
function PairingPrompt({
  waiting,
  onDone,
  locale,
}: {
  waiting: Waiting
  onDone: () => void
  locale?: ClientLocale
}): React.ReactElement {
  const text = useText(locale)
  const dialog = React.useRef<HTMLDialogElement>(null)
  const approveButton = React.useRef<HTMLButtonElement>(null)
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState('')
  const request = waiting.requests[0]
  const servicePairing = request ? undefined : waiting.servicePairings?.[0]
  const totalWaiting = waiting.requests.length + (waiting.servicePairings?.length ?? 0)
  const activeKey = request ? `direct:${request.id}` : servicePairing ? `service:${servicePairing.requestId}` : ''

  React.useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (activeKey && !element.open) {
      element.showModal()
      approveButton.current?.focus()
    }
    if (!activeKey && element.open) element.close()
  }, [activeKey])

  const answer = async (decision: 'approve' | 'reject') => {
    if (!request && !servicePairing) return
    setWorking(true)
    setError('')
    // Approving confirms the same device name and host fingerprint the pairing page displayed; the
    // Host checks both again before the device cookie is issued.
    try {
      if (request) {
        await command(
          decision === 'approve'
            ? { action: 'approve', id: request.id, name: request.name, fingerprint: waiting.node.fingerprint }
            : { action: 'reject', id: request.id },
        )
      } else if (servicePairing) {
        await command({
          action: decision === 'approve' ? 'approveServicePairing' : 'rejectServicePairing',
          id: servicePairing.requestId,
        })
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text('操作失败。', 'The request could not be processed.'))
    } finally {
      setWorking(false)
      onDone()
    }
  }

  return (
    <dialog
      className="dsrc-dialog dsrc-prompt"
      ref={dialog}
      aria-labelledby="dsrc-pairing-title"
      onCancel={(event) => event.preventDefault()}
    >
      {request || servicePairing ? (
        <div className="dsrc">
          <h2 id="dsrc-pairing-title" tabIndex={-1}>
            {text('新的配对请求', 'New pairing request')}
          </h2>
          <p className="dsrc-prompt-device">{request ? request.name : servicePairing?.deviceName}</p>
          <p className="dsrc-note">
            {request
              ? request.via === 'public'
                ? `${text('公网入口', 'Public entry')} · ${text('主机指纹', 'Host fingerprint')} ${waiting.node.fingerprintGroups} · ${request.nodeConfirmed ? text('手机已确认本机', 'Confirmed on the phone') : text('手机尚未确认本机', 'Waiting for phone confirmation')}`
                : text('局域网配对请求', 'Local network pairing request')
              : `${text('自托管公网节点', 'Self-hosted public node')} · ${text('过期时间', 'Expires')} ${when(servicePairing?.expiresAt ?? 0)}`}
          </p>
          <p className="dsrc-note">
            {text(
              '请核对设备名。公网配对还要核对主机指纹。允许后，这台设备拥有与本机相同的权限，可以管理设置、凭据和插件。不是你发起的请求请拒绝。',
              'Check the device name. For a public connection, also compare the host fingerprint. Approval grants the same permissions as on this computer, including access to settings, credentials, and plugins. Decline requests you did not initiate.',
            )}
          </p>
          {totalWaiting > 1 ? (
            <p className="dsrc-note">
              {text(`还有 ${totalWaiting - 1} 个请求在等待。`, `Other requests waiting: ${totalWaiting - 1}`)}
            </p>
          ) : null}
          {error ? (
            <div className="dsrc-error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="dsrc-actions dsrc-prompt-actions">
            <button
              type="button"
              className="dsrc-button"
              disabled={working}
              onClick={() => {
                void answer('reject')
              }}
            >
              {text('拒绝', 'Decline')}
            </button>
            <button
              ref={approveButton}
              type="button"
              className="dsrc-button dsrc-primary"
              disabled={working}
              onClick={() => {
                void answer('approve')
              }}
            >
              {text('允许连接', 'Allow connection')}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}

export function SidebarEntry({ manager, locale }: PanelProps): React.ReactElement {
  const text = useText(locale)
  const [open, setOpen] = React.useState(false)
  const dialog = React.useRef<HTMLDialogElement>(null)
  const [waiting, setWaiting] = React.useState<Waiting>({
    enabled: false,
    node: { name: '', fingerprint: '', fingerprintGroups: '' },
    requests: [],
    servicePairings: [],
  })

  React.useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])

  React.useEffect(() => {
    const element = dialog.current
    const view = window.visualViewport
    if (!open || !element || !view) return
    // A soft keyboard shrinks the visual viewport without moving the layout viewport, so the dialog
    // is laid out against a height the keyboard then covers. Clamp it to what is actually visible.
    const sync = () => {
      if (view.height >= window.innerHeight - 80) {
        element.style.cssText = ''
        return
      }
      element.style.position = 'fixed'
      element.style.top = `${Math.round(view.offsetTop + 8)}px`
      element.style.left = '8px'
      element.style.right = '8px'
      element.style.bottom = 'auto'
      element.style.width = 'auto'
      element.style.margin = '0'
      element.style.maxHeight = `${Math.max(200, Math.round(view.height - 16))}px`
    }
    sync()
    view.addEventListener('resize', sync)
    view.addEventListener('scroll', sync)
    return () => {
      view.removeEventListener('resize', sync)
      view.removeEventListener('scroll', sync)
      element.style.cssText = ''
    }
  }, [open])

  const checking = React.useRef(false)
  const check = React.useCallback(async () => {
    // A slow tunnel answers later than the next tick; one probe in flight at a time keeps an older
    // answer from overwriting a newer one, and a hidden page does not need to ask at all.
    if (checking.current || document.hidden) return
    checking.current = true
    try {
      const next = (await command({ action: 'requests' })) as unknown as Waiting
      setWaiting(next)
    } catch {
      /* the Host is restarting: ask again on the next tick */
    } finally {
      checking.current = false
    }
  }, [])
  React.useEffect(() => watchLocalPairings(check), [check])

  const label = text('远程控制', 'Remote Control')
  const pending = waiting.requests.length > 0 || (waiting.servicePairings?.length ?? 0) > 0

  return (
    <>
      <button
        type="button"
        className="dsrc-entry"
        title={pending ? text('远程控制 · 有配对请求', 'Remote Control · Pairing request pending') : label}
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <PanelIcon />
        {pending ? <span className="dsrc-entry-dot" /> : null}
      </button>
      <dialog
        className="dsrc-dialog"
        ref={dialog}
        aria-label={label}
        onCancel={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const r = event.currentTarget.getBoundingClientRect()
            if (
              event.clientX < r.left ||
              event.clientX > r.right ||
              event.clientY < r.top ||
              event.clientY > r.bottom
            ) {
              setOpen(false)
            }
          }
        }}
      >
        <button
          type="button"
          className="dsrc-close"
          aria-label={text('关闭远程控制面板', 'Close Remote Control panel')}
          onClick={() => setOpen(false)}
        >
          ×
        </button>
        {open ? <RemoteControlPanel manager={manager} locale={locale} /> : null}
      </dialog>
      <PairingPrompt
        waiting={waiting}
        locale={locale}
        onDone={() => {
          void check()
        }}
      />
    </>
  )
}
