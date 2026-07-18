import { describe, expect, it } from 'vitest'
import { historySyncDue, historySyncIntervalMs } from './sync-scheduler.js'

describe('sync scheduler', () => {
  it('refreshes recent history on first run and after one hour', () => {
    const now = Date.parse('2026-07-18T12:00:00Z')

    expect(historySyncDue({}, now)).toBe(true)
    expect(historySyncDue({ lastHistorySyncAt: 'invalid' }, now)).toBe(true)
    expect(historySyncDue({ lastHistorySyncAt: new Date(now - historySyncIntervalMs + 1).toISOString() }, now)).toBe(false)
    expect(historySyncDue({ lastHistorySyncAt: new Date(now - historySyncIntervalMs).toISOString() }, now)).toBe(true)
  })
})
