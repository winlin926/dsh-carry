import { RemoteControlPanel, type PanelProps } from './RemoteControlPanel.js'
import { SidebarEntry, watchLocalPairings } from './components/SidebarEntry.js'
import { clientText, isConnectionFace, remoteRuntime, resolveClientLocale, type ClientContext } from './model.js'
import { PhoneIcon } from './nav-icon.js'
import { resolvePluginManager, type PluginManagerFace } from './plugin-update.js'
import { CSS } from './style.js'

export * from './model.js'
export { RemoteControlPanel, watchLocalPairings }

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  // `remote.pluginManager` is a Host Remote service mounted after this plugin applies. Its property gate
  // refuses a member that was not injected, so resolve the service by name on every check instead:
  // a Host without a plugin manager simply answers undefined and the card explains the manual path.
  const manager = () => {
    let found: unknown
    try {
      found = ctx.get?.('remote.pluginManager')
    } catch {
      found = undefined
    }
    return resolvePluginManager({ manager: (found ?? null) as PluginManagerFace | null })
  }
  const panelProps = (): PanelProps => ({ manager, locale: resolveClientLocale(ctx) })

  ctx.effect(() => {
    const runtime = remoteRuntime()
    if (!runtime) return
    try {
      if (isConnectionFace(ctx.connection)) return runtime.bindConnection(ctx.connection)
    } catch {
      /* Use the optional service lookup below. */
    }
    let connection: unknown
    try {
      connection = ctx.get?.('connection')
    } catch {
      return
    }
    if (isConnectionFace(connection)) return runtime.bindConnection(connection)
  }, 'remote-control connection')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshRemoteControl = 'true'
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, 'remote-control styles')

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'copylee-remote-control',
        order: 65,
        label: () => clientText(resolveClientLocale(ctx), '远程控制', 'Remote Control'),
      },
      () => <RemoteControlPanel {...panelProps()} />,
    ),
  )

  // Addressed by section id: the shell skips ids it has no section for.
  ctx.slots.inject('settings.section.icon', () =>
    ctx.slots.register(
      { name: 'settings.section.icon', id: 'copylee-remote-control' },
      (props: { size?: number; active?: boolean }) => <PhoneIcon {...props} />,
    ),
  )

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'copylee-remote-control', order: 65 }, () => (
      <SidebarEntry {...panelProps()} />
    )),
  )
}
