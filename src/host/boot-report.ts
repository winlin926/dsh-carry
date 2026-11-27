import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/** One JSON line per remote boot report; the oldest lines drop once the file passes 256 KB. */
const BOOT_REPORT_LIMIT = 256 * 1024

function redactBootReport(report: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown, limit: number) => (typeof value === 'string' ? value.slice(0, limit) : undefined)
  const address = (origin: unknown, path: unknown, rev?: unknown) => {
    try {
      const url = new URL(String(path ?? '/'), String(origin))
      if (!['http:', 'https:'].includes(url.protocol)) return {}
      return {
        origin: url.origin,
        path: url.pathname.slice(0, 3000),
        ...(typeof rev === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rev) ? { rev } : {}),
      }
    } catch {
      return {}
    }
  }
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
  const errors = Array.isArray(report.errors)
    ? report.errors
        .slice(0, 6)
        .filter((value): value is string => typeof value === 'string')
        .map((value) =>
          value
            .replace(/https?:\/\/[^\s]+/g, (raw) => {
              try {
                const url = new URL(raw)
                return url.origin + url.pathname
              } catch {
                return '[URL]'
              }
            })
            .replace(/\b(token|key|pin|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
            .slice(0, 400),
        )
    : []
  return {
    ...address(report.origin, report.path),
    viewport: text(report.viewport, 60),
    ua: text(report.ua, 300),
    phase: text(report.phase, 32),
    result: text(report.result, 32),
    durationMs: number(report.durationMs),
    completedResources: number(report.completedResources),
    mounted: report.mounted === true,
    errors,
    resources: Array.isArray(report.resources)
      ? report.resources.slice(0, 12).flatMap((value) => {
          if (!value || typeof value !== 'object') return []
          const resource = value as Record<string, unknown>
          return [
            {
              ...address(resource.origin, resource.path, resource.rev),
              result: text(resource.result, 20),
              durationMs: number(resource.durationMs),
            },
          ]
        })
      : [],
  }
}

export function appendBootReport(
  file: string,
  report: Record<string, unknown>,
  device: { id: string; name: string } | undefined,
): void {
  const line = `${JSON.stringify({ time: new Date().toISOString(), device, ...redactBootReport(report) })}\n`
  let previous = ''
  try {
    previous = readFileSync(file, 'utf8')
  } catch {
    /* the first report creates the file */
  }
  const kept =
    previous.length > BOOT_REPORT_LIMIT
      ? previous.slice(previous.indexOf('\n', previous.length - BOOT_REPORT_LIMIT / 2) + 1)
      : previous
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, kept + line, { mode: 0o600 })
  renameSync(temporary, file)
}
