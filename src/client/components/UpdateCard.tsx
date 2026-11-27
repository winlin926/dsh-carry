import * as React from 'react'
import { updateCard, type PluginManagerFace, type PluginUpdate } from '../plugin-update.js'
import { CardIcon, UpdateIcon } from './Primitives.js'

/** Update card: the panel only ever asks the DSH plugin manager, never a registry or a shell. */
export function UpdateCard({
  store,
  version,
}: {
  store: PluginUpdate
  version: string | undefined
}): React.ReactElement {
  const updateState = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => store.subscribe(notify), [store]),
    () => store.snapshot(),
  )
  React.useEffect(() => {
    store.noteInstalled(version ?? null)
  }, [store, version])

  const card = updateCard(updateState)
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
        <h3>插件更新</h3>
        <span className="dsrc-tag" data-tone={card.tone} title={`当前版本 ${card.version}`}>
          {`v${card.version}`}
        </span>
      </div>
      <p className="dsrc-update-status" data-tone={card.tone} role="status">
        {working && !card.action ? '正在处理，请不要关闭 DSH…' : card.status}
      </p>
      {card.detail ? <p className="dsrc-muted">{card.detail}</p> : null}
      <div className="dsrc-actions dsrc-update-actions">
        {updateState.confirm ? (
          <button type="button" className="dsrc-button" disabled={working} onClick={() => store.cancel()}>
            取消
          </button>
        ) : null}
        {card.action ? (
          <button
            type="button"
            className={`dsrc-button${updateState.confirm ? ' dsrc-primary' : ''}`}
            disabled={working}
            onClick={actOnCard}
          >
            {working ? '正在更新…' : card.action}
          </button>
        ) : null}
      </div>
    </section>
  )
}

export type UpdateManagerResolver = () => PluginManagerFace | null
