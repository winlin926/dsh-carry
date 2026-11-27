import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Preferences, ProxyMode } from './types.js'

export const DEFAULT_PREFERENCES: Preferences = {
  autoStart: false,
  mode: 'lan',
  line: 'lan',
  proxyMode: 'off',
}

export const isProxyMode = (value: unknown): value is ProxyMode =>
  value === 'system' || value === 'manual' || value === 'off'

export function loadPreferences(prefsFile: string): { preferences: Preferences; error?: string } {
  if (!existsSync(prefsFile)) return { preferences: { ...DEFAULT_PREFERENCES } }
  try {
    const stored = JSON.parse(readFileSync(prefsFile, 'utf8')) as Partial<Preferences>
    return {
      preferences: {
        autoStart: stored.autoStart === true,
        mode: stored.mode === 'public' ? 'public' : 'lan',
        line: stored.line === 'public' ? 'public' : 'lan',
        proxy: typeof stored.proxy === 'string' ? stored.proxy : undefined,
        // An address typed before proxy modes existed is still an explicit manual choice.
        proxyMode: isProxyMode(stored.proxyMode) ? stored.proxyMode : stored.proxy ? 'manual' : 'off',
        port: Number.isInteger(stored.port) && stored.port! > 0 && stored.port! < 65536 ? stored.port : undefined,
      },
    }
  } catch {
    // A damaged preferences file must not keep the plugin from loading; device authorizations live elsewhere.
    return {
      preferences: { ...DEFAULT_PREFERENCES },
      error: '远程控制的偏好设置文件已损坏，已恢复默认设置（设备授权不受影响）。',
    }
  }
}

export function savePreferencesFile(prefsFile: string, preferences: Preferences): void {
  const temporary = `${prefsFile}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(preferences), { mode: 0o600 })
  renameSync(temporary, prefsFile)
}
