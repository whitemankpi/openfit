import { describe, expect, it } from 'vitest'
import type { TimePoint } from '@/types'
import {
  MAX_HEART_RATE_MIN_DAYS,
  averageHeartRate,
  estimateMaxHeartRate,
  sleepingHeartRate,
  zoneMinutesFromIntraday,
} from './heart-zones'

const minutes = (values: Array<[string, number]>): TimePoint[] =>
  values.map(([time, value]) => ({ time, value }))

describe('estimateMaxHeartRate', () => {
  it('needs a fortnight of observations before committing to a maximum', () => {
    const short = Array.from({ length: MAX_HEART_RATE_MIN_DAYS - 1 }, () => 170)

    expect(estimateMaxHeartRate(short, 55)).toEqual({ value: null, observedDays: 13 })
  })

  it('takes the highest observed rate once enough days exist', () => {
    const observed = [...Array.from({ length: 13 }, () => 150), 182]

    expect(estimateMaxHeartRate(observed, 55)).toEqual({ value: 182, observedDays: 14 })
  })

  it('floors the estimate above resting so quiet weeks do not collapse the zones', () => {
    const observed = Array.from({ length: 20 }, () => 95)

    // 95 observed is barely above resting; the reserve floor wins.
    expect(estimateMaxHeartRate(observed, 60)).toEqual({ value: 120, observedDays: 20 })
  })

  it('ignores missing and non-positive days', () => {
    const observed = [...Array.from({ length: 14 }, () => 170), null, 0, -5]

    expect(estimateMaxHeartRate(observed, 50)).toEqual({ value: 170, observedDays: 14 })
  })
})

describe('zoneMinutesFromIntraday', () => {
  // Resting 60, max 200 -> reserve 140. Thresholds land on 130 / 144 / 158 / 179.
  const resting = 60
  const max = 200

  it('assigns each minute to the zone its intensity reaches', () => {
    const points = minutes([
      ['08:00', 90],   // below light, counted nowhere
      ['08:01', 130],  // light
      ['08:02', 150],  // moderate
      ['08:03', 170],  // vigorous
      ['08:04', 190],  // peak
    ])

    expect(zoneMinutesFromIntraday(points, max, resting)).toEqual({ light: 1, moderate: 1, vigorous: 1, peak: 1 })
  })

  it('reports nothing when the maximum or resting rate is unknown', () => {
    const points = minutes([['08:00', 150]])

    expect(zoneMinutesFromIntraday(points, null, resting)).toBeNull()
    expect(zoneMinutesFromIntraday(points, max, null)).toBeNull()
  })

  it('reports nothing rather than zeroes when there are no samples', () => {
    expect(zoneMinutesFromIntraday([], max, resting)).toBeNull()
  })

  it('refuses a reserve that is not positive', () => {
    expect(zoneMinutesFromIntraday(minutes([['08:00', 150]]), 60, 60)).toBeNull()
  })
})

describe('sleepingHeartRate', () => {
  it('averages only the samples inside a night that crosses midnight', () => {
    const points = minutes([
      ['13:00', 90],
      ['23:50', 58],
      ['02:00', 52],
      ['05:30', 54],
      ['09:00', 88],
    ])

    expect(sleepingHeartRate(points, '2026-06-21T23:42:00', '2026-06-22T06:55:00')).toBe(55)
  })

  it('handles a nap that stays within one day', () => {
    const points = minutes([['13:00', 90], ['14:10', 60], ['14:40', 58], ['18:00', 95]])

    expect(sleepingHeartRate(points, '2026-06-22T14:00:00', '2026-06-22T15:00:00')).toBe(59)
  })

  it('reports nothing without an interval or matching samples', () => {
    const points = minutes([['13:00', 90]])

    expect(sleepingHeartRate(points, null, '2026-06-22T06:55:00')).toBeNull()
    expect(sleepingHeartRate(points, '2026-06-22T23:00:00', '2026-06-23T06:00:00')).toBeNull()
  })
})

describe('averageHeartRate', () => {
  it('rounds the mean and reports nothing for an empty series', () => {
    expect(averageHeartRate(minutes([['08:00', 61], ['08:01', 62]]))).toBe(62)
    expect(averageHeartRate([])).toBeNull()
  })
})
