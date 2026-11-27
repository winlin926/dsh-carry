import * as React from 'react'
import { clientText, noop, noSnapshot, type ClientLocale } from '../model.js'

export function useText(locale?: ClientLocale) {
  const subscribe = React.useCallback((listener: () => void) => locale?.subscribe(listener) ?? noop, [locale])
  React.useSyncExternalStore(subscribe, () => locale?.getSnapshot().revision, noSnapshot)
  return (zh: string, en: string) => clientText(locale, zh, en)
}

const AVATAR_TONES = ['indigo', 'teal', 'violet', 'warm'] as const
export const avatarTone = (seed: string) =>
  AVATAR_TONES[[...seed].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % AVATAR_TONES.length]!

export function PanelIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <rect x={7} y={2} width={10} height={20} rx={3} />
      <path d="M10 5h4M11 19h2" />
    </svg>
  )
}

export function UpdateIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v11m0 0 4-4m-4 4-4-4" />
      <path d="M4 16v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2" />
    </svg>
  )
}

function StrokeIcon({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function DeviceIcon(): React.ReactElement {
  return (
    <StrokeIcon>
      <rect x={3} y={4.5} width={18} height={12} rx={2} />
      <path d="M1.5 19.5h21" />
      <path d="M9 8.5h6" />
    </StrokeIcon>
  )
}

export function BellIcon(): React.ReactElement {
  return (
    <StrokeIcon>
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10.3 19.5a2 2 0 0 0 3.4 0" />
    </StrokeIcon>
  )
}

export function GearIcon(): React.ReactElement {
  return (
    <StrokeIcon>
      <circle cx={12} cy={12} r={3} />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </StrokeIcon>
  )
}

export function NodeIcon(): React.ReactElement {
  return (
    <StrokeIcon>
      <rect x={3.5} y={4} width={17} height={6.5} rx={2} />
      <rect x={3.5} y={13.5} width={17} height={6.5} rx={2} />
      <path d="M7 7.2h.01M7 16.8h.01" />
    </StrokeIcon>
  )
}

export function CardIcon({
  tone,
  children,
}: {
  tone: 'indigo' | 'teal' | 'violet' | 'warm' | 'slate'
  children: React.ReactElement
}): React.ReactElement {
  return (
    <span className="dsrc-card-icon" data-tone={tone}>
      {children}
    </span>
  )
}

export function StatusNote({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'ok' | 'danger' | 'warn'
}): React.ReactElement {
  return (
    <div className="dsrc-status-note" data-tone={tone}>
      <span className="dsrc-status-label">{label}</span>
      <span className="dsrc-status-value">{value}</span>
    </div>
  )
}

export function InlineNotice({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger'
  children?: React.ReactNode
  action?: { label: string; onClick: () => void }
}): React.ReactElement {
  return (
    <div className="dsrc-inline-notice" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="dsrc-notice-copy">{children}</div>
      {action ? (
        <button type="button" className="dsrc-button dsrc-notice-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

export function ActionFeedback({
  feedback,
  target,
}: {
  feedback: { target: string; text: string } | null
  target: string
}): React.ReactElement {
  return (
    <span className="dsrc-action-feedback" role="status">
      {feedback?.target === target ? feedback.text : null}
    </span>
  )
}
