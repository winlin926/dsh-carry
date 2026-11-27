/** The same computer's LAN entry, injected only into a paired device's public page. */
export interface LanFallback {
  /** Protocol-2 node identity the page must see in the answer; null when only flat aliases were known. */
  node: { id: string; fingerprint: string } | null
  /** Protocol-1 aliases, kept for an answer that only names the old flat fields. */
  hostId: string | null
  fingerprint: string | null
  url: string
}

/** The direct line is offered per boot: its signaling route, and which line this phone prefers. */
export interface BootDirect {
  signal: string
  preference: 'lan' | 'public'
}

export interface BootContext {
  fallback?: LanFallback
  direct?: BootDirect
  entry?: 'lan' | 'public'
  version?: string
}

export type SayFn = (zh: string, en: string) => string
