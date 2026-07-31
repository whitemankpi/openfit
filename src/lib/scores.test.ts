import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import type { DashboardData, TrendPoint } from '@/types'
import type { History } from '@/data/history'
import { MINIMUM_BASELINE_DAYS, computeScores, scoreSeries } from './scores'

const SELECTED = '2026-06-30'

function isoDaysBefore(days: number) {
  const date = new Date(`${SELECTED}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

/** A steady history, so any score movement comes from the day under test. */
function steadyTrends(count: number, overrides: Partial<TrendPoint> = {}): TrendPoint[] {
  const template = createDemoData(SELECTED).trends.at(-1) as TrendPoint
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    date: isoDaysBefore(count - index),
    label: 'Mon',
    hrvMs: 45,
    restingHeartRate: 58,
    breathingRate: 14.5,
    skinTemperature: 0,
    sleepMinutes: 450,
    sleepDeepMinutes: 90,
    sleepRemMinutes: 110,
    sleepLightMinutes: 250,
    sleepAwakeMinutes: 30,
    sleepLatencyMinutes: 10,
    sleepMidTime: 200,
    sleepEfficiency: 88,
    // A flat series has no spread at all, which would make every z-score
    // undefined, so the baseline is given a small realistic wobble.
    ...(index % 2 ? { hrvMs: 47, restingHeartRate: 59, sleepAwakeMinutes: 34, sleepLatencyMinutes: 12 } : {}),
    ...overrides,
  }))
}

function dashboard(trends: TrendPoint[], today: Partial<DashboardData> = {}): DashboardData {
  const base = createDemoData(SELECTED)
  return {
    ...base,
    selectedDate: SELECTED,
    trends,
    ...today,
    health: { ...base.health, hrvMs: 45, restingHeartRate: 58, breathingRate: 14.5, skinTemperature: 0, ...today.health },
    sleep: {
      ...base.sleep,
      totalMinutes: 450,
      efficiency: 88,
      minutesToFallAsleep: 10,
      minutesAwake: 30,
      stages: [
        { name: 'Deep', key: 'deep', minutes: 90, color: '#555b64' },
        { name: 'Light', key: 'light', minutes: 250, color: '#858c95' },
        { name: 'REM', key: 'rem', minutes: 110, color: '#bcc1c7' },
        { name: 'Awake', key: 'wake', minutes: 30, color: '#363a40' },
      ],
      ...today.sleep,
    },
  }
}

const emptyHistory: History = { days: [], maxHeartRate: null }

function historyWithZones(count: number, todayMinutes: number): History {
  return {
    maxHeartRate: 190,
    days: Array.from({ length: count }, (_, index) => {
      const date = isoDaysBefore(count - 1 - index)
      const isToday = date === SELECTED
      return {
        date,
        trend: { date } as TrendPoint,
        heartIntraday: [],
        heartZoneMinutes: {
          light: isToday ? todayMinutes : 30,
          moderate: isToday ? 0 : 10,
          vigorous: null,
          peak: null,
        },
      }
    }),
  }
}

describe('computeScores', () => {
  it('withholds a score until the baseline is long enough', () => {
    const scores = computeScores(dashboard(steadyTrends(MINIMUM_BASELINE_DAYS - 1)), emptyHistory)

    expect(scores.recovery.confidence).toBe('insufficient')
    expect(scores.recovery.value).toBeNull()
    expect(scores.recovery.contributions).toEqual([])
    expect(scores.sleepQuality.value).toBeNull()
  })

  it('marks a baseline that is present but not yet settled', () => {
    const scores = computeScores(dashboard(steadyTrends(20)), emptyHistory)

    expect(scores.recovery.confidence).toBe('building')
    expect(scores.recovery.value).not.toBeNull()
  })

  it('reports contributions that add up to the score exactly', () => {
    const scores = computeScores(dashboard(steadyTrends(40)), emptyHistory)

    for (const score of [scores.recovery, scores.sleepQuality]) {
      const total = score.contributions.reduce((sum, contribution) => sum + contribution.points, 0)
      expect(total).toBe(score.value)
      expect(Math.abs(score.contributions.reduce((sum, item) => sum + item.weight, 0) - 1)).toBeLessThan(1e-9)
    }
  })

  it('redistributes the weight of a factor the device did not report', () => {
    const trends = steadyTrends(40).map((point) => ({ ...point, hrvMs: null }))
    const data = dashboard(trends, { health: { ...dashboard(trends).health, hrvMs: null } })

    const { recovery } = computeScores(data, emptyHistory)

    expect(recovery.missing).toContain('Heart rate variability')
    expect(recovery.contributions.some((contribution) => contribution.key === 'hrv')).toBe(false)
    expect(Math.abs(recovery.contributions.reduce((sum, item) => sum + item.weight, 0) - 1)).toBeLessThan(1e-9)
    expect(recovery.value).not.toBeNull()
  })

  it('scores a better morning higher than a worse one', () => {
    const trends = steadyTrends(40)
    const good = computeScores(dashboard(trends, {
      health: { ...dashboard(trends).health, hrvMs: 62, restingHeartRate: 54 },
    }), emptyHistory)
    const bad = computeScores(dashboard(trends, {
      health: { ...dashboard(trends).health, hrvMs: 32, restingHeartRate: 66 },
    }), emptyHistory)

    expect(good.recovery.value as number).toBeGreaterThan(bad.recovery.value as number)
  })

  it('is not dragged by a single extreme day in the baseline', () => {
    const trends = steadyTrends(40)
    const withOutlier = trends.map((point, index) => index === 5 ? { ...point, hrvMs: 400 } : point)

    const plain = computeScores(dashboard(trends), emptyHistory)
    const skewed = computeScores(dashboard(withOutlier), emptyHistory)

    expect(Math.abs((skewed.recovery.value as number) - (plain.recovery.value as number))).toBeLessThanOrEqual(2)
  })

  it('scales load against the wearer\'s own hard days', () => {
    const easy = computeScores(dashboard(steadyTrends(40)), historyWithZones(40, 20))
    const hard = computeScores(dashboard(steadyTrends(40)), historyWithZones(40, 400))

    expect(easy.load.value as number).toBeLessThan(hard.load.value as number)
    expect(hard.load.value).toBe(100)
  })

  it('leaves load unavailable without heart rate zones', () => {
    const { load } = computeScores(dashboard(steadyTrends(40)), emptyHistory)

    expect(load.value).toBeNull()
    expect(load.confidence).toBe('insufficient')
  })

  it('scores each historical day against only the days before it', () => {
    const trends = steadyTrends(50)
    const series = scoreSeries(trends, 'recovery')

    expect(series).toHaveLength(trends.length)
    // The opening stretch has no baseline to be judged against.
    expect(series.slice(0, MINIMUM_BASELINE_DAYS).every((value) => value === null)).toBe(true)
    expect(series.at(-1)).not.toBeNull()
  })

  it('matches the selected day when the same reading is scored from the series', () => {
    const trends = steadyTrends(50)
    const series = scoreSeries(trends, 'sleepQuality')
    const last = trends.at(-1) as TrendPoint
    // Re-date the final row as the selected day so both paths judge the same
    // reading against the same preceding window.
    const direct = computeScores(dashboard([...trends.slice(0, -1), { ...last, date: SELECTED }], {
      sleep: {
        ...dashboard(trends).sleep,
        totalMinutes: last.sleepMinutes,
        efficiency: last.sleepEfficiency,
        minutesToFallAsleep: last.sleepLatencyMinutes,
        minutesAwake: last.sleepAwakeMinutes,
        stages: [
          { name: 'Deep', key: 'deep', minutes: last.sleepDeepMinutes as number, color: '#555b64' },
          { name: 'Light', key: 'light', minutes: last.sleepLightMinutes as number, color: '#858c95' },
          { name: 'REM', key: 'rem', minutes: last.sleepRemMinutes as number, color: '#bcc1c7' },
          { name: 'Awake', key: 'wake', minutes: 30, color: '#363a40' },
        ],
      },
    }), emptyHistory)

    expect(series.at(-1)).toBe(direct.sleepQuality.value)
  })

  it('rewards a longer night and penalises a broken one', () => {
    const trends = steadyTrends(40)
    const base = dashboard(trends)
    const rested = computeScores(dashboard(trends, {
      sleep: { ...base.sleep, totalMinutes: 500, efficiency: 94, minutesAwake: 12, minutesToFallAsleep: 6 },
    }), emptyHistory)
    const broken = computeScores(dashboard(trends, {
      sleep: { ...base.sleep, totalMinutes: 300, efficiency: 74, minutesAwake: 70, minutesToFallAsleep: 40 },
    }), emptyHistory)

    expect(rested.sleepQuality.value as number).toBeGreaterThan(broken.sleepQuality.value as number)
  })
})
