import { estimateMaxHeartRate, zoneMinutesFromIntraday } from '../lib/heart-zones'
import { normalizeFitbitData } from './normalize'
import type { HeartZoneMinutes, RawHealthArchive, TimePoint, TrendPoint } from '../types'

export const RANGE_OPTIONS = [7, 30, 90, 365] as const
export type RangeDays = (typeof RANGE_OPTIONS)[number]

/** Days of observed maxima the heart rate zones are anchored to. */
const MAX_HEART_RATE_LOOKBACK = 90

export interface HistoryDay {
  date: string
  trend: TrendPoint
  /** Present only for days whose own payload was synced and archived. */
  heartIntraday: TimePoint[] | null
  heartZoneMinutes: HeartZoneMinutes | null
}

export interface History {
  days: HistoryDay[]
  /** Estimated maximum heart rate the zones were derived from, if established. */
  maxHeartRate: number | null
}

const EMPTY: History = { days: [], maxHeartRate: null }

function shiftIso(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00`)
  parsed.setDate(parsed.getDate() + days)
  const offset = parsed.getTimezoneOffset() * 60_000
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 10)
}

/**
 * Turns the encrypted per-day archive into one series.
 *
 * Every archived payload carries its own trailing trend window, so days that
 * were never opened individually still contribute daily rollups. A day's own
 * payload always wins over another day's view of it, because only the former
 * carries intraday detail.
 */
export function buildHistory(archive: RawHealthArchive | null | undefined): History {
  const days = archive?.days
  if (!days || typeof days !== 'object') return EMPTY

  const ownTrend = new Map<string, TrendPoint>()
  const borrowedTrend = new Map<string, TrendPoint>()
  const intraday = new Map<string, TimePoint[]>()

  for (const date of Object.keys(days).sort()) {
    const payload = days[date]
    if (!payload) continue
    const normalized = normalizeFitbitData(payload)
    for (const point of normalized.trends) {
      if (point.date === date) ownTrend.set(date, point)
      else if (!ownTrend.has(point.date)) borrowedTrend.set(point.date, point)
    }
    if (normalized.health.heartRateIntraday.length) {
      intraday.set(date, normalized.health.heartRateIntraday)
    }
  }

  const dates = [...new Set([...ownTrend.keys(), ...borrowedTrend.keys()])].sort()
  if (!dates.length) return EMPTY

  const latest = dates.at(-1) as string
  const zoneStart = shiftIso(latest, -(MAX_HEART_RATE_LOOKBACK - 1))
  const trendFor = (date: string) => ownTrend.get(date) ?? borrowedTrend.get(date) as TrendPoint

  const { value: maxHeartRate } = estimateMaxHeartRate(
    dates.filter((date) => date >= zoneStart).map((date) => trendFor(date).heartRateMax),
    medianRestingHeartRate(dates.map((date) => trendFor(date).restingHeartRate)),
  )

  return {
    maxHeartRate,
    days: dates.map((date) => {
      const trend = trendFor(date)
      const points = intraday.get(date) ?? null
      return {
        date,
        trend,
        heartIntraday: points,
        heartZoneMinutes: points ? zoneMinutesFromIntraday(points, maxHeartRate, trend.restingHeartRate) : null,
      }
    }),
  }
}

/**
 * A single outlier resting reading would drag a mean-based reserve, so the
 * zone anchor uses the median of the days that reported one.
 */
function medianRestingHeartRate(values: Array<number | null>) {
  const observed = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b)
  if (!observed.length) return null
  const middle = Math.floor(observed.length / 2)
  return observed.length % 2 ? observed[middle] : Math.round((observed[middle - 1] + observed[middle]) / 2)
}

/** The `days` calendar days ending at `endDate`, oldest first. */
export function historyWindow(history: History, endDate: string, days: number): HistoryDay[] {
  const start = shiftIso(endDate, -(days - 1))
  return history.days.filter((day) => day.date >= start && day.date <= endDate)
}

/**
 * Trends for the requested range, preferring the archive and filling anything
 * it does not cover from the payload's own trailing window. Before the archive
 * has accumulated, the payload is all there is; afterwards it stays useful for
 * the days that were synced but never stored individually.
 */
export function mergeTrendWindow(
  history: History,
  payloadTrends: TrendPoint[],
  endDate: string,
  days: number,
): TrendPoint[] {
  const start = shiftIso(endDate, -(days - 1))
  const merged = new Map<string, TrendPoint>()
  for (const point of payloadTrends) {
    if (point.date >= start && point.date <= endDate) merged.set(point.date, point)
  }
  for (const day of historyWindow(history, endDate, days)) merged.set(day.date, day.trend)
  return [...merged.values()].sort((left, right) => left.date.localeCompare(right.date))
}

/** How many days of history exist up to `endDate`, for gating range options. */
export function availableDays(history: History, endDate: string): number {
  const oldest = history.days.find((day) => day.date <= endDate)?.date
  if (!oldest) return 0
  const span = (Date.parse(`${endDate}T12:00:00`) - Date.parse(`${oldest}T12:00:00`)) / 86_400_000
  return Math.max(0, Math.round(span)) + 1
}
