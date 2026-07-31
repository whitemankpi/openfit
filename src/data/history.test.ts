import { describe, expect, it } from 'vitest'
import { availableDays, buildHistory, historyWindow, mergeTrendWindow } from './history'
import { normalizeFitbitData } from './normalize'
import type { RawFitbitPayload, RawHealthArchive } from '../types'

const normalizeTrends = (input: RawFitbitPayload) => normalizeFitbitData(input).trends

function payload(date: string, options: {
  trendDates?: string[]
  restingHeartRate?: number
  heartSamples?: Array<[string, number]>
} = {}): RawFitbitPayload {
  const { trendDates = [date], restingHeartRate = 58, heartSamples = [] } = options
  return {
    source: 'google-health',
    date,
    generatedAt: `${date}T12:00:00.000Z`,
    endpoints: {
      heartIntraday: {
        'activities-heart': trendDates.map((day) => ({ dateTime: day, value: { restingHeartRate } })),
        'activities-heart-intraday': { dataset: heartSamples.map(([time, value]) => ({ time, value })) },
      },
      heartTrend: {
        'activities-heart': trendDates.map((day) => ({ dateTime: day, value: { restingHeartRate } })),
      },
      stepsTrend: {
        'activities-steps': trendDates.map((day) => ({ dateTime: day, value: 8000 })),
      },
    },
    errors: [],
    rateLimit: { limit: null, remaining: null, resetSeconds: null },
  }
}

const archive = (days: Record<string, RawFitbitPayload>): RawHealthArchive => ({
  version: 2,
  lastDate: Object.keys(days).sort().at(-1) ?? null,
  days,
})

describe('buildHistory', () => {
  it('returns nothing for an absent or empty archive', () => {
    expect(buildHistory(null)).toEqual({ days: [], maxHeartRate: null })
    expect(buildHistory(archive({}))).toEqual({ days: [], maxHeartRate: null })
  })

  it('fills days that were never synced from a neighbouring payload window', () => {
    const history = buildHistory(archive({
      '2026-06-22': payload('2026-06-22', { trendDates: ['2026-06-20', '2026-06-21', '2026-06-22'] }),
    }))

    expect(history.days.map((day) => day.date)).toEqual(['2026-06-20', '2026-06-21', '2026-06-22'])
    // Only the synced day carries intraday detail.
    expect(history.days.filter((day) => day.heartIntraday !== null)).toHaveLength(0)
  })

  it('prefers a day\'s own payload over another day\'s view of it', () => {
    const history = buildHistory(archive({
      '2026-06-21': payload('2026-06-21', {
        restingHeartRate: 52,
        heartSamples: [['08:00', 70], ['08:01', 74]],
      }),
      '2026-06-22': payload('2026-06-22', { trendDates: ['2026-06-21', '2026-06-22'], restingHeartRate: 61 }),
    }))

    const twentyFirst = history.days.find((day) => day.date === '2026-06-21')
    expect(twentyFirst?.trend.restingHeartRate).toBe(52)
    expect(twentyFirst?.heartIntraday).toEqual([{ time: '08:00', value: 70 }, { time: '08:01', value: 74 }])
  })

  it('leaves heart rate zones unavailable until the maximum can be estimated', () => {
    const history = buildHistory(archive({
      '2026-06-22': payload('2026-06-22', { heartSamples: [['08:00', 150]] }),
    }))

    // One observed day is far short of the fortnight the estimate requires.
    expect(history.maxHeartRate).toBeNull()
    expect(history.days[0].heartZoneMinutes).toBeNull()
  })

  it('derives zones once enough days have been observed', () => {
    const days: Record<string, RawFitbitPayload> = {}
    for (let index = 0; index < 15; index += 1) {
      const date = `2026-06-${String(index + 1).padStart(2, '0')}`
      days[date] = payload(date, {
        restingHeartRate: 60,
        // Peak of 200 on every day: reserve is 140, so 130/144/158/179 bound the zones.
        heartSamples: [['08:00', 100], ['08:01', 135], ['08:02', 150], ['08:03', 165], ['08:04', 200]],
      })
    }

    const history = buildHistory(archive(days))

    expect(history.maxHeartRate).toBe(200)
    expect(history.days.at(-1)?.heartZoneMinutes).toEqual({ light: 1, moderate: 1, vigorous: 1, peak: 1 })
  })
})

describe('historyWindow', () => {
  const history = buildHistory(archive({
    '2026-06-22': payload('2026-06-22', {
      trendDates: ['2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22'],
    }),
  }))

  it('returns the requested span ending on the selected day', () => {
    expect(historyWindow(history, '2026-06-22', 3).map((day) => day.date))
      .toEqual(['2026-06-20', '2026-06-21', '2026-06-22'])
  })

  it('never reaches past the selected day', () => {
    expect(historyWindow(history, '2026-06-18', 30).map((day) => day.date))
      .toEqual(['2026-06-16', '2026-06-17', '2026-06-18'])
  })

  it('merges the archive over the payload window and narrows to the range', () => {
    const payloadTrends = normalizeTrends(payload('2026-06-22', {
      trendDates: ['2026-06-15', '2026-06-20', '2026-06-21', '2026-06-22'],
      restingHeartRate: 70,
    }))

    const merged = mergeTrendWindow(history, payloadTrends, '2026-06-22', 3)

    expect(merged.map((point) => point.date)).toEqual(['2026-06-20', '2026-06-21', '2026-06-22'])
    // The archive is authoritative where both know a day.
    expect(merged.at(-1)?.restingHeartRate).toBe(58)
  })

  it('keeps payload days the archive never stored', () => {
    const payloadTrends = normalizeTrends(payload('2026-06-22', {
      trendDates: ['2026-06-10', '2026-06-22'],
      restingHeartRate: 70,
    }))

    const merged = mergeTrendWindow(buildHistory(null), payloadTrends, '2026-06-22', 30)

    expect(merged.map((point) => point.date)).toEqual(['2026-06-10', '2026-06-22'])
  })

  it('reports how much history exists so ranges can be gated', () => {
    expect(availableDays(history, '2026-06-22')).toBe(7)
    expect(availableDays(history, '2026-06-17')).toBe(2)
    expect(availableDays(buildHistory(null), '2026-06-22')).toBe(0)
  })
})
