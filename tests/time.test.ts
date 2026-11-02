import { describe, expect, it } from 'vitest'
import { normalizeTimestamp, offsetMinutes, redmineTime } from '../src/redmine/time.ts'

describe('redmineTime', () => {
  it('reads every timestamp shape Redmine deploys as the same instant (T-16)', () => {
    const expected = '2026-11-02T02:30:00.000Z'
    expect(redmineTime('2026-11-02T10:30:00+08:00')).toBe(expected)
    expect(redmineTime('2026-11-02T02:30:00Z')).toBe(expected)
    expect(redmineTime('2026-11-02 10:30:00 +0800')).toBe(expected)
    expect(redmineTime('2026-11-02T10:30:00', 'Asia/Shanghai')).toBe(expected)
    expect(redmineTime('2026-11-02 10:30:00', 'Asia/Shanghai')).toBe(expected)
    expect(redmineTime('2013-03-20 15:04:05 UTC')).toBe('2013-03-20T15:04:05.000Z')
  })

  it('keeps fractional seconds', () => {
    expect(redmineTime('2026-11-02T10:30:00.250+08:00')).toBe('2026-11-02T02:30:00.250Z')
    expect(redmineTime('2026-11-02T10:30:00.250', 'Asia/Shanghai')).toBe('2026-11-02T02:30:00.250Z')
  })

  it('reads a bare time in the configured zone rather than the process zone', () => {
    expect(redmineTime('2026-07-01T12:00:00', 'Europe/Berlin')).toBe('2026-07-01T10:00:00.000Z')
    expect(redmineTime('2026-01-01T12:00:00', 'Europe/Berlin')).toBe('2026-01-01T11:00:00.000Z')
  })

  it('falls back to the process zone when no zone is configured', () => {
    const offset = -new Date().getTimezoneOffset()
    const local = redmineTime('2026-11-02T10:30:00')
    expect(local).toBe(new Date(Date.UTC(2026, 10, 2, 10, 30) - offset * 60_000).toISOString())
  })

  it('rejects text that is not a timestamp, and unknown zones', () => {
    expect(() => redmineTime('yesterday')).toThrow(/Invalid Redmine timestamp/)
    expect(() => redmineTime('2026-11-02T10:30:00', 'Mars/Olympus')).toThrow(/Invalid time zone/)
  })
})

describe('offsetMinutes', () => {
  it('reports the zone offset east of UTC', () => {
    const winter = Date.UTC(2026, 0, 15, 12)
    const summer = Date.UTC(2026, 6, 15, 12)
    expect(offsetMinutes(winter, 'UTC')).toBe(0)
    expect(offsetMinutes(winter, 'Asia/Shanghai')).toBe(480)
    expect(offsetMinutes(winter, 'Europe/Berlin')).toBe(60)
    expect(offsetMinutes(summer, 'Europe/Berlin')).toBe(120)
  })
})

describe('normalizeTimestamp', () => {
  it('rewrites Rails spellings into an ISO form', () => {
    expect(normalizeTimestamp('2013-03-20 15:04:05 +0800')).toBe('2013-03-20T15:04:05+08:00')
    expect(normalizeTimestamp('2013-03-20 15:04:05 UTC')).toBe('2013-03-20T15:04:05Z')
    expect(normalizeTimestamp('2026-11-02T10:30:00Z')).toBe('2026-11-02T10:30:00Z')
  })
})
