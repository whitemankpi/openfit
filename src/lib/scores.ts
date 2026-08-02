import type { DashboardData, TrendPoint } from '../types.js'
import type { History } from '../data/history.js'
import { robustBaseline, robustZScore } from './home-analysis.js'

/**
 * OpenFit does not receive Readiness, Strain or Sleep Score from Google or
 * Fitbit and does not try to reproduce them. These are its own derivations,
 * computed locally from measurements the device did return, and every score
 * reports the factors and weights it was built from so the number can be
 * argued with. See docs/SCORES.md.
 */

/** Days of baseline below which a score is withheld rather than guessed. */
export const MINIMUM_BASELINE_DAYS = 14
/** Days at which the baseline is considered settled. */
export const SETTLED_BASELINE_DAYS = 30
/** Window the baselines are drawn from. */
const BASELINE_WINDOW = 60
/** Window the load ceiling is calibrated against. */
const LOAD_WINDOW = 90

export type ScoreKey = 'recovery' | 'load' | 'sleepQuality'
export type ScoreConfidence = 'insufficient' | 'building' | 'ready'
export type ScoreStatus = 'low' | 'typical' | 'high'

export interface ScoreContribution {
  key: string
  label: string
  /** Deviation from the personal baseline, in spread units. Null when unused. */
  z: number | null
  /** Share of the score this factor was given after renormalisation. */
  weight: number
  /** Points this factor put into the score; the contributions sum to `value`. */
  points: number
}

export interface ScoreResult {
  key: ScoreKey
  label: string
  value: number | null
  status: ScoreStatus
  confidence: ScoreConfidence
  baselineDays: number
  contributions: ScoreContribution[]
  /** Factors the score wanted but the device did not report. */
  missing: string[]
}

export interface Scores {
  recovery: ScoreResult
  load: ScoreResult
  sleepQuality: ScoreResult
}

interface Factor {
  key: string
  label: string
  weight: number
  /** 0..1, where 1 is the best reading this factor can contribute. */
  goodness: number | null
  z: number | null
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/** Higher is better: +2 spreads above baseline saturates the factor. */
const higherIsBetter = (z: number | null) => z === null ? null : clamp01(0.5 + z / 4)
const lowerIsBetter = (z: number | null) => z === null ? null : clamp01(0.5 - z / 4)
/** Either direction is a departure from the personal normal. */
const closerIsBetter = (z: number | null) => z === null ? null : clamp01(1 - Math.abs(z) / 3)

function windowBefore(trends: TrendPoint[], selectedDate: string, days: number) {
  return trends.filter((point) => point.date < selectedDate).slice(-days)
}

function statusOf(value: number | null): ScoreStatus {
  if (value === null) return 'typical'
  if (value < 40) return 'low'
  return value > 70 ? 'high' : 'typical'
}

function confidenceOf(baselineDays: number): ScoreConfidence {
  if (baselineDays < MINIMUM_BASELINE_DAYS) return 'insufficient'
  return baselineDays < SETTLED_BASELINE_DAYS ? 'building' : 'ready'
}

/**
 * Renormalises the weights over the factors that actually have a reading, so a
 * missing sensor redistributes its share instead of silently scoring zero.
 */
function combine(key: ScoreKey, label: string, factors: Factor[], baselineDays: number): ScoreResult {
  const available = factors.filter((factor) => factor.goodness !== null)
  const missing = factors.filter((factor) => factor.goodness === null).map((factor) => factor.label)
  const confidence = confidenceOf(baselineDays)
  const totalWeight = available.reduce((sum, factor) => sum + factor.weight, 0)

  if (!available.length || totalWeight <= 0 || confidence === 'insufficient') {
    return {
      key,
      label,
      value: null,
      status: 'typical',
      confidence,
      baselineDays,
      contributions: [],
      missing,
    }
  }

  const contributions = available.map((factor) => {
    const weight = factor.weight / totalWeight
    return {
      key: factor.key,
      label: factor.label,
      z: factor.z,
      weight,
      points: (factor.goodness as number) * weight * 100,
    }
  })
  // Round once at the end so the parts still add up to the whole.
  const value = Math.round(contributions.reduce((sum, contribution) => sum + contribution.points, 0))
  const rounded = roundContributions(contributions, value)

  return { key, label, value, status: statusOf(value), confidence, baselineDays, contributions: rounded, missing }
}

/**
 * Largest-remainder rounding, so the displayed contributions add up to the
 * displayed score rather than to something a point either side of it.
 */
function roundContributions(contributions: ScoreContribution[], total: number): ScoreContribution[] {
  const floored = contributions.map((contribution) => ({
    contribution,
    whole: Math.floor(contribution.points),
    remainder: contribution.points - Math.floor(contribution.points),
  }))
  let leftover = total - floored.reduce((sum, entry) => sum + entry.whole, 0)
  const order = [...floored].sort((left, right) => right.remainder - left.remainder)
  for (const entry of order) {
    if (leftover <= 0) break
    entry.whole += 1
    leftover -= 1
  }
  return floored.map((entry) => ({ ...entry.contribution, points: entry.whole }))
}

/**
 * The readings a score needs for one day, so the same maths can run on the
 * selected day's full payload or on any archived day's trend row.
 */
interface DayReading {
  hrvMs: number | null
  restingHeartRate: number | null
  breathingRate: number | null
  skinTemperature: number | null
  sleepMinutes: number | null
  sleepEfficiency: number | null
  restorativeMinutes: number | null
  latencyMinutes: number | null
  wasoMinutes: number | null
}

function readingFromDashboard(data: DashboardData): DayReading {
  const restorative = data.sleep.stages
    .filter((stage) => stage.key === 'deep' || stage.key === 'rem')
    .reduce<number | null>((sum, stage) => sum === null ? stage.minutes : sum + stage.minutes, null)
  return {
    hrvMs: data.health.hrvMs,
    restingHeartRate: data.health.restingHeartRate,
    breathingRate: data.health.breathingRate,
    skinTemperature: data.health.skinTemperature,
    sleepMinutes: data.sleep.totalMinutes,
    sleepEfficiency: data.sleep.efficiency,
    restorativeMinutes: restorative,
    latencyMinutes: data.sleep.minutesToFallAsleep,
    wasoMinutes: data.sleep.minutesAwake,
  }
}

function readingFromTrend(point: TrendPoint): DayReading {
  return {
    hrvMs: point.hrvMs,
    restingHeartRate: point.restingHeartRate,
    breathingRate: point.breathingRate,
    skinTemperature: point.skinTemperature,
    sleepMinutes: point.sleepMinutes,
    sleepEfficiency: point.sleepEfficiency,
    restorativeMinutes: point.sleepDeepMinutes === null && point.sleepRemMinutes === null
      ? null
      : (point.sleepDeepMinutes ?? 0) + (point.sleepRemMinutes ?? 0),
    latencyMinutes: point.sleepLatencyMinutes,
    wasoMinutes: point.sleepAwakeMinutes,
  }
}

function recoveryScore(reading: DayReading, sleepQuality: ScoreResult, history: TrendPoint[]): ScoreResult {
  const hrv = robustBaseline(history.map((point) => point.hrvMs))
  const resting = robustBaseline(history.map((point) => point.restingHeartRate))
  const breathing = robustBaseline(history.map((point) => point.breathingRate))
  const temperature = robustBaseline(history.map((point) => point.skinTemperature))

  const hrvZ = robustZScore(reading.hrvMs, hrv)
  const restingZ = robustZScore(reading.restingHeartRate, resting)
  const breathingZ = robustZScore(reading.breathingRate, breathing)
  const temperatureZ = robustZScore(reading.skinTemperature, temperature)

  return combine('recovery', 'Recovery', [
    { key: 'hrv', label: 'Heart rate variability', weight: 0.35, z: hrvZ, goodness: higherIsBetter(hrvZ) },
    { key: 'restingHeartRate', label: 'Resting heart rate', weight: 0.25, z: restingZ, goodness: lowerIsBetter(restingZ) },
    {
      key: 'sleep',
      label: 'Sleep quality',
      weight: 0.25,
      z: null,
      goodness: sleepQuality.value === null ? null : sleepQuality.value / 100,
    },
    { key: 'breathing', label: 'Breathing rate', weight: 0.10, z: breathingZ, goodness: closerIsBetter(breathingZ) },
    { key: 'temperature', label: 'Skin temperature', weight: 0.05, z: temperatureZ, goodness: closerIsBetter(temperatureZ) },
  ], history.length)
}

/** Minutes in each zone weigh differently towards cardiovascular load. */
const ZONE_WEIGHTS = { light: 1, moderate: 2, vigorous: 4, peak: 6 } as const

function loadOf(zoneMinutes: { light: number | null; moderate: number | null; vigorous: number | null; peak: number | null } | null) {
  if (!zoneMinutes) return null
  const parts = (Object.keys(ZONE_WEIGHTS) as Array<keyof typeof ZONE_WEIGHTS>)
    .map((zone) => zoneMinutes[zone] === null ? null : (zoneMinutes[zone] as number) * ZONE_WEIGHTS[zone])
    .filter((value): value is number => value !== null)
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : null
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[index]
}

/**
 * Load is not a deviation from a baseline but an amount, so it is scaled
 * against the wearer's own hard days rather than a population norm: the 95th
 * percentile of the last ninety days reads as 100.
 */
function loadScore(data: DashboardData, history: History): ScoreResult {
  const days = history.days.filter((day) => day.date <= data.selectedDate).slice(-LOAD_WINDOW)
  const today = days.find((day) => day.date === data.selectedDate) ?? null
  const past = days.filter((day) => day.date < data.selectedDate)
  const observed = past.map((day) => loadOf(day.heartZoneMinutes)).filter((value): value is number => value !== null)
  const ceiling = percentile(observed, 0.95)
  const current = loadOf(today?.heartZoneMinutes ?? null)

  const goodness = current === null || ceiling === null || ceiling <= 0 ? null : clamp01(current / ceiling)
  return combine('load', 'Load', [
    { key: 'zoneMinutes', label: 'Time in heart rate zones', weight: 1, z: null, goodness },
  ], observed.length)
}

function sleepQualityScore(reading: DayReading, history: TrendPoint[]): ScoreResult {
  // Personal sleep need, bounded to a plausible range so a run of short nights
  // cannot redefine "enough sleep" downwards.
  const duration = robustBaseline(history.map((point) => point.sleepMinutes))
  const need = duration.center === null ? null : Math.max(420, Math.min(540, duration.center))
  const durationGoodness = need === null || reading.sleepMinutes === null ? null : clamp01(reading.sleepMinutes / need)

  const efficiencyGoodness = reading.sleepEfficiency === null ? null : clamp01((reading.sleepEfficiency - 70) / 25)

  const restorativeBaseline = robustBaseline(history.map((point) => readingFromTrend(point).restorativeMinutes))
  const restorativeZ = robustZScore(reading.restorativeMinutes, restorativeBaseline)

  const latencyBaseline = robustBaseline(history.map((point) => point.sleepLatencyMinutes))
  const latencyZ = robustZScore(reading.latencyMinutes, latencyBaseline)

  const wasoBaseline = robustBaseline(history.map((point) => point.sleepAwakeMinutes))
  const wasoZ = robustZScore(reading.wasoMinutes, wasoBaseline)

  // Consistency is the spread of recent bedtimes, not a comparison with one
  // night, so it is read straight off the baseline rather than as a z-score.
  const midTimes = history.slice(-14).map((point) => point.sleepMidTime)
  const consistency = robustBaseline(midTimes)
  const consistencyGoodness = consistency.spread === null
    ? (consistency.sampleCount >= 3 ? 1 : null)
    : clamp01(1 - consistency.spread / 90)

  return combine('sleepQuality', 'Sleep quality', [
    { key: 'duration', label: 'Duration against personal need', weight: 0.35, z: null, goodness: durationGoodness },
    { key: 'efficiency', label: 'Efficiency', weight: 0.20, z: null, goodness: efficiencyGoodness },
    { key: 'restorative', label: 'Deep and REM share', weight: 0.20, z: restorativeZ, goodness: higherIsBetter(restorativeZ) },
    { key: 'latency', label: 'Time to fall asleep', weight: 0.10, z: latencyZ, goodness: lowerIsBetter(latencyZ) },
    { key: 'waso', label: 'Time awake during the night', weight: 0.10, z: wasoZ, goodness: lowerIsBetter(wasoZ) },
    { key: 'consistency', label: 'Bedtime consistency', weight: 0.05, z: null, goodness: consistencyGoodness },
  ], history.length)
}

export function computeScores(data: DashboardData, history: History): Scores {
  const baseline = windowBefore(data.trends, data.selectedDate, BASELINE_WINDOW)
  const reading = readingFromDashboard(data)
  const sleepQuality = sleepQualityScore(reading, baseline)
  return {
    sleepQuality,
    recovery: recoveryScore(reading, sleepQuality, baseline),
    load: loadScore(data, history),
  }
}

/**
 * The same score for every day in the series, each judged against the days
 * before it. Load is excluded: it needs per-day heart rate zones, which the
 * trend rows do not carry.
 */
export function scoreSeries(trends: TrendPoint[], key: 'recovery' | 'sleepQuality'): Array<number | null> {
  return trends.map((point, index) => {
    const baseline = trends.slice(Math.max(0, index - BASELINE_WINDOW), index)
    const reading = readingFromTrend(point)
    const sleepQuality = sleepQualityScore(reading, baseline)
    return key === 'sleepQuality' ? sleepQuality.value : recoveryScore(reading, sleepQuality, baseline).value
  })
}
