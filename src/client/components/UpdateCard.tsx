import * as React from 'react'
import type { ClientLocale } from '../model.js'
import { updateCard, type PluginManagerFace, type PluginUpdate, type UpdateSnapshot } from '../plugin-update.js'
import { CardIcon, UpdateIcon, useText } from './Primitives.js'

function localizedCardText(snapshot: UpdateSnapshot, text: (zh: string, en: string) => string) {
  const card = updateCard(snapshot)
  const version = snapshot.installed ?? text('未知', 'Unknown')
  let action = card.action
  if (action === '确认更新') action = text('确认更新', 'Confirm update')
  else if (action === '重新检查') action = text('重新检查', 'Retry check')
  else if (action === '检查更新') action = text('检查更新', 'Check for updates')
  else if (action && snapshot.latest) action = text(`更新到 ${snapshot.latest}`, `Update to ${snapshot.latest}`)

  let status = card.status
  if (status === '尚未检查更新') status = text('尚未检查更新', 'Not checked yet')
  else if (status === '正在检查更新…') status = text('正在检查更新…', 'Checking for updates…')
  else if (status === '已是最新版本') status = text('已是最新版本', 'Up to date')
  else if (status === '请通过 DSH 插件管理器手动更新')
    status = text('请通过 DSH 插件管理器手动更新', 'Update manually through DSH Plugin Manager')
  else if (status === '检查更新失败') status = text('检查更新失败', 'Update check failed')
  else if (status === '更新失败') status = text('更新失败', 'Update failed')
  else if (status === '更新结果不确定') status = text('更新结果不确定', 'Update status uncertain')
  else if (snapshot.phase === 'available' && snapshot.confirm && snapshot.latest)
    status = text(`确认更新到 ${snapshot.latest}？`, `Update to ${snapshot.latest}?`)
  else if (snapshot.phase === 'available' && snapshot.latest)
    status = text(`可更新到 ${snapshot.latest}`, `Update available: ${snapshot.latest}`)
  else if (snapshot.phase === 'updating' && snapshot.latest)
    status = text(`正在更新到 ${snapshot.latest}…`, `Updating to ${snapshot.latest}…`)
  else if (snapshot.phase === 'installed' && snapshot.installed)
    status = status.includes('重启')
      ? text(
          `已更新到 ${snapshot.installed}，重启 DSH 后生效`,
          `Updated to ${snapshot.installed} (restart DSH to apply)`,
        )
      : text(`已更新到 ${snapshot.installed}`, `Updated to ${snapshot.installed}`)

  return { ...card, version, status, action }
}

/** Update card: the panel only ever asks the DSH plugin manager, never a registry or a shell. */
export function UpdateCard({
  store,
  version,
  locale,
}: {
  store: PluginUpdate
  version: string | undefined
  locale?: ClientLocale
}): React.ReactElement {
  const text = useText(locale)
  const updateState = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => store.subscribe(notify), [store]),
    () => store.snapshot(),
  )
  React.useEffect(() => {
    store.noteInstalled(version ?? null)
  }, [store, version])

  const card = localizedCardText(updateState, text)
  const working = updateState.busy
  const actOnCard = () => {
    if (updateState.confirm) void store.update()
    else if (updateState.phase === 'available') store.ask()
    else void store.check(true)
  }

  return (
    <section className="dsrc-surface dsrc-update" data-section="plugin-update" data-phase={updateState.phase}>
      <div className="dsrc-card-head">
        <CardIcon tone="slate">
          <UpdateIcon />
        </CardIcon>
        <h3>{text('插件更新', 'Plugin updates')}</h3>
        <span
          className="dsrc-tag"
          data-tone={card.tone}
          title={text(`当前版本 ${card.version}`, `Version ${card.version}`)}
        >
          {`v${card.version}`}
        </span>
      </div>
      <p className="dsrc-update-status" data-tone={card.tone} role="status">
        {working && !card.action ? text('正在处理，请不要关闭 DSH…', 'Working, keep DSH open…') : card.status}
      </p>
      {card.detail ? <p className="dsrc-muted">{card.detail}</p> : null}
      <div className="dsrc-actions dsrc-update-actions">
        {updateState.confirm ? (
          <button type="button" className="dsrc-button" disabled={working} onClick={() => store.cancel()}>
            {text('取消', 'Cancel')}
          </button>
        ) : null}
        {card.action ? (
          <button
            type="button"
            className={`dsrc-button${updateState.confirm ? ' dsrc-primary' : ''}`}
            disabled={working}
            onClick={actOnCard}
          >
            {working ? text('正在更新…', 'Updating…') : card.action}
          </button>
        ) : null}
      </div>
    </section>
  )
}

export type UpdateManagerResolver = () => PluginManagerFace | null
