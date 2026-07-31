import { describe, expect, it } from 'vitest'

const { cachedDay, latestDay, markAttempted, normalizeArchive, sameDayContent, storeDay } = require('./health-cache.cjs')

const payload = (date: string) => ({ source: 'google-health', date, generatedAt: `${date}T12:00:00Z`, endpoints: {}, errors: [], rateLimit: {} })

describe('health history cache', () => {
  it('migrates the previous single-day cache', () => {
    const oldCache = payload('2026-06-21')
    expect(normalizeArchive(oldCache)).toMatchObject({ version: 2, lastDate: '2026-06-21', days: { '2026-06-21': oldCache } })
  })

  it('remembers days the provider had nothing for', () => {
    const archive = markAttempted(markAttempted(null, '2026-06-19'), '2026-06-18')

    expect(archive.attempted).toEqual(['2026-06-18', '2026-06-19'])
    // Asking twice must not grow the list.
    expect(markAttempted(archive, '2026-06-18').attempted).toEqual(['2026-06-18', '2026-06-19'])
  })

  it('stops treating a day as attempted once it finally arrives', () => {
    const archive = storeDay(markAttempted(null, '2026-06-21'), payload('2026-06-21'))

    expect(archive.attempted).toEqual([])
    expect(cachedDay(archive, '2026-06-21')?.date).toBe('2026-06-21')
    // A day already present is never recorded as a failed attempt.
    expect(markAttempted(archive, '2026-06-21').attempted).toEqual([])
  })

  it('preserves attempted days across a reload', () => {
    const stored = JSON.parse(JSON.stringify(markAttempted(null, '2026-06-17')))

    expect(normalizeArchive(stored).attempted).toEqual(['2026-06-17'])
    expect(normalizeArchive({ version: 2, days: {}, attempted: ['x', 5, 'x'] }).attempted).toEqual(['x'])
  })

  it('keeps every stored day and returns each one independently', () => {
    const archive = storeDay(storeDay(null, payload('2026-06-21')), payload('2026-06-22'))
    expect(cachedDay(archive, '2026-06-21')?.date).toBe('2026-06-21')
    expect(cachedDay(archive, '2026-06-22')?.date).toBe('2026-06-22')
    expect(latestDay(archive)?.date).toBe('2026-06-22')
  })

  it('replaces only the matching day', () => {
    const first = storeDay(storeDay(null, payload('2026-06-21')), payload('2026-06-22'))
    const updated = storeDay(first, { ...payload('2026-06-22'), generatedAt: 'new' })
    expect(cachedDay(updated, '2026-06-21')?.generatedAt).toBe('2026-06-21T12:00:00Z')
    expect(cachedDay(updated, '2026-06-22')?.generatedAt).toBe('new')
    expect(latestDay(storeDay(updated, { ...payload('2026-06-21'), generatedAt: 'finalized' }))?.date).toBe('2026-06-22')
  })

  it('ignores volatile sync metadata when comparing day content', () => {
    const original = { ...payload('2026-06-22'), endpoints: { steps: 6404, sleep: 470 }, requestStats: { successfulKeys: ['steps', 'sleep'] } }
    const refreshed = {
      ...original,
      generatedAt: '2026-06-22T12:05:00Z',
      cacheHit: true,
      endpoints: { sleep: 470, steps: 6404 },
      requestStats: { successfulKeys: ['sleep', 'steps'] },
    }

    expect(sameDayContent(original, refreshed)).toBe(true)
    expect(sameDayContent(original, { ...refreshed, endpoints: { steps: 6561 } })).toBe(false)
  })
})
