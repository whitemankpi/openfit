import type { HeartZoneMinutes, TimePoint } from '@/types'

/**
 * Google and Fitbit never expose the user's age or a measured maximum heart
 * rate, so the zones have to be anchored to what the device actually recorded.
 * The estimate is the highest observed rate across the archive, floored well
 * above resting so a quiet stretch of days cannot collapse the zones.
 */
export const MAX_HEART_RATE_MIN_DAYS = 14
const RESERVE_FLOOR = 60

/** Fractions of heart rate reserve (Karvonen), the lower bound of each zone. */
export const ZONE_THRESHOLDS = { light: 0.5, moderate: 0.6, vigorous: 0.7, peak: 0.85 } as const

export interface MaxHeartRateEstimate {
  value: number | null
  observedDays: number
}

export function estimateMaxHeartRate(
  dailyMaximums: Array<number | null>,
  restingHeartRate: number | null,
): MaxHeartRateEstimate {
  const observed = dailyMaximums.filter((value): value is number => value !== null && Number.isFinite(value) && value > 0)
  if (observed.length < MAX_HEART_RATE_MIN_DAYS) return { value: null, observedDays: observed.length }
  const peak = Math.max(...observed)
  const floor = restingHeartRate === null ? 0 : restingHeartRate + RESERVE_FLOOR
  return { value: Math.max(peak, floor), observedDays: observed.length }
}

/**
 * Minutes spent in each zone. Samples below the light threshold are everyday
 * activity and belong to no zone, so they are counted nowhere rather than
 * inflating the lightest one.
 */
export function zoneMinutesFromIntraday(
  points: TimePoint[],
  maxHeartRate: number | null,
  restingHeartRate: number | null,
): HeartZoneMinutes | null {
  if (maxHeartRate === null || restingHeartRate === null) return null
  const reserve = maxHeartRate - restingHeartRate
  if (reserve <= 0) return null
  if (!points.length) return null

  const minutes: HeartZoneMinutes = { light: 0, moderate: 0, vigorous: 0, peak: 0 }
  // One entry per minute-stamped sample; duplicates within a minute are already
  // collapsed upstream by the intraday compaction.
  for (const point of points) {
    const intensity = (point.value - restingHeartRate) / reserve
    if (intensity >= ZONE_THRESHOLDS.peak) minutes.peak = (minutes.peak ?? 0) + 1
    else if (intensity >= ZONE_THRESHOLDS.vigorous) minutes.vigorous = (minutes.vigorous ?? 0) + 1
    else if (intensity >= ZONE_THRESHOLDS.moderate) minutes.moderate = (minutes.moderate ?? 0) + 1
    else if (intensity >= ZONE_THRESHOLDS.light) minutes.light = (minutes.light ?? 0) + 1
  }
  return minutes
}

export function averageHeartRate(points: TimePoint[]): number | null {
  if (!points.length) return null
  return Math.round(points.reduce((sum, point) => sum + point.value, 0) / points.length)
}

/**
 * Average rate inside the sleep interval. Distinct from resting heart rate,
 * which providers derive with their own smoothing over several nights.
 */
export function sleepingHeartRate(
  points: TimePoint[],
  startTime: string | null,
  endTime: string | null,
): number | null {
  if (!startTime || !endTime) return null
  const start = new Date(startTime)
  const end = new Date(endTime)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null
  const startMinutes = start.getHours() * 60 + start.getMinutes()
  const endMinutes = end.getHours() * 60 + end.getMinutes()
  // The night wraps past midnight whenever it ends earlier in the day than it
  // started, in which case the window is the union of both ends of the clock.
  const wraps = endMinutes <= startMinutes

  const inWindow = points.filter((point) => {
    const [hours, mins] = point.time.split(':').map(Number)
    if (!Number.isFinite(hours) || !Number.isFinite(mins)) return false
    const minute = hours * 60 + mins
    return wraps ? minute >= startMinutes || minute <= endMinutes : minute >= startMinutes && minute <= endMinutes
  })
  return averageHeartRate(inWindow)
}
