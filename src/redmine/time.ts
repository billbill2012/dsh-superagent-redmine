/**
 * Redmine timestamp normalization.
 *
 * Redmine serializes timestamps differently by version and deployment: `2026-11-02T10:30:00+08:00`, `...Z`,
 * Rails' `2026-11-02 10:30:00 +0800`, or a bare `2026-11-02T10:30:00` with no zone at all. A bare time must be read
 * in the configured zone: handing it to `new Date(text)` would read it in the process zone and silently shift the read
 * cursor by hours. Everything this module returns is UTC ISO (`...Z`), which is what the cursor is stored as.
 */

/** A configured `timezone` that is not an IANA zone; the polling loop reports it as a configuration problem. */
export class RedmineTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`Invalid time zone: ${timeZone}`)
    this.name = 'RedmineTimeZoneError'
  }
}

const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/i
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Turns a Redmine timestamp into an ISO string with a `Z` suffix. A timestamp that carries its own offset is parsed
 * directly; a bare one is interpreted in `timeZone` (the process zone when it is empty).
 * @throws when the text is not a timestamp, or `timeZone` is not a known IANA zone.
 */
export function redmineTime(text: string, timeZone = ''): string {
  const normalized = normalizeTimestamp(text)
  if (ZONED.test(normalized)) {
    const at = Date.parse(normalized)
    if (!Number.isFinite(at)) throw new Error(`Invalid Redmine timestamp: ${text}`)
    return new Date(at).toISOString()
  }
  const match = WALL.exec(normalized)
  if (!match) throw new Error(`Invalid Redmine timestamp: ${text}`)
  const fraction = match[7] ? `0.${match[7]}` : '0'
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]),
    Number(match[6]), Math.round(Number(fraction) * 1000))
  // The offset is looked up at the guessed instant and then re-checked once, which settles a daylight-saving boundary.
  const guessed = wall - offsetMinutes(wall, timeZone) * 60_000
  const instant = wall - offsetMinutes(guessed, timeZone) * 60_000
  return new Date(instant).toISOString()
}

/** Minutes east of UTC that `timeZone` was at `at`; the process zone when `timeZone` is empty. */
export function offsetMinutes(at: Date | number, timeZone = ''): number {
  const instant = typeof at === 'number' ? at : at.getTime()
  if (!timeZone) return -new Date(instant).getTimezoneOffset()
  const formatter = formatterFor(timeZone)
  const parts = formatter.formatToParts(new Date(instant))
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value ?? 0)
  const wall = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'))
  return Math.round((wall - instant) / 60_000)
}

/** Rewrites Rails' textual forms into something `Date.parse` understands; throws for anything that is not a timestamp. */
export function normalizeTimestamp(text: string): string {
  const normalized = text.trim()
    .replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/, '$1T$2')
    .replace(/\s+(?=[+-]\d{2}:?\d{2}$)/, '')
    .replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3')
    .replace(/\s+UTC$/i, 'Z')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(normalized)) {
    throw new Error(`Invalid Redmine timestamp: ${text}`)
  }
  return normalized
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    throw new RedmineTimeZoneError(timeZone)
  }
  formatters.set(timeZone, formatter)
  return formatter
}
