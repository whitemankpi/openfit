import type { DashboardData, TrendPoint } from '../types.js'
import type { History } from '../data/history.js'
import { robustBaseline } from './home-analysis.js'
import { computeScores, type ScoreKey } from './scores.js'
import { weekdayMedians, spearman } from './analytics.js'
import { relevantMemory, type MemoryEntry } from './assistant-memory.js'

export interface ToolContext {
  data: DashboardData
  history: History
  memory?: MemoryEntry[]
}

export interface ToolDefinition {
  name: string
  description: string
  schema: { type: 'object'; properties: Record<string, unknown>; required: string[] }
  run: (args: Record<string, unknown>, context: ToolContext) => unknown
}

/**
 * Metrics a tool may be asked about. Anything outside this list is refused
 * rather than guessed at, because the name arrives from a model that has read
 * context containing user-supplied text.
 */
const METRICS: Record<string, (point: TrendPoint) => number | null> = {
  steps: (point) => point.steps,
  calories: (point) => point.calories,
  distanceKm: (point) => point.distanceKm,
  floors: (point) => point.floors,
  activeMinutes: (point) => point.activeMinutes,
  zoneMinutes: (point) => point.zoneMinutes,
  sedentaryMinutes: (point) => point.sedentaryMinutes,
  restingHeartRate: (point) => point.restingHeartRate,
  heartRateAvg: (point) => point.heartRateAvg,
  heartRateMax: (point) => point.heartRateMax,
  sleepingHeartRate: (point) => point.sleepingHeartRate,
  hrvMs: (point) => point.hrvMs,
  breathingRate: (point) => point.breathingRate,
  spo2: (point) => point.spo2,
  skinTemperature: (point) => point.skinTemperature,
  cardioScore: (point) => point.cardioScore,
  sleepMinutes: (point) => point.sleepMinutes,
  sleepEfficiency: (point) => point.sleepEfficiency,
  sleepDeepMinutes: (point) => point.sleepDeepMinutes,
  sleepRemMinutes: (point) => point.sleepRemMinutes,
  sleepAwakeMinutes: (point) => point.sleepAwakeMinutes,
  sleepLatencyMinutes: (point) => point.sleepLatencyMinutes,
  weight: (point) => point.weight,
  bodyFat: (point) => point.bodyFat,
  waterMl: (point) => point.waterMl,
  caloriesIn: (point) => point.caloriesIn,
}

export const METRIC_KEYS = Object.keys(METRICS)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function toolError(message: string) {
  return { error: message }
}

function readMetric(args: Record<string, unknown>) {
  const metric = String(args.metric ?? '')
  if (!Object.prototype.hasOwnProperty.call(METRICS, metric)) return { error: `Unknown metric "${metric}". Available: ${METRIC_KEYS.join(', ')}.` }
  return { metric }
}

function readRange(args: Record<string, unknown>, startKey = 'start', endKey = 'end') {
  const start = String(args[startKey] ?? '')
  const end = String(args[endKey] ?? '')
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return { error: `${startKey} and ${endKey} must be YYYY-MM-DD dates.` }
  if (start > end) return { error: `${startKey} must not be after ${endKey}.` }
  return { start, end }
}

function seriesFor(context: ToolContext, metric: string, start: string, end: string) {
  if (!Object.prototype.hasOwnProperty.call(METRICS, metric)) return []
  const select = METRICS[metric]!
  return context.history.days
    .filter((day) => day.date >= start && day.date <= end)
    .map((day) => ({ date: day.date, value: select(day.trend) }))
}

function finite(values: Array<number | null>) {
  return values.filter((value): value is number => value !== null && Number.isFinite(value))
}

/** Least-squares slope expressed in metric units per seven days. */
function slopePerWeek(points: Array<{ date: string; value: number | null }>) {
  const observed = points
    .map((point, index) => ({ index, value: point.value }))
    .filter((point): point is { index: number; value: number } => point.value !== null && Number.isFinite(point.value))
  if (observed.length < 2) return null
  const meanIndex = observed.reduce((sum, point) => sum + point.index, 0) / observed.length
  const meanValue = observed.reduce((sum, point) => sum + point.value, 0) / observed.length
  let covariance = 0
  let variance = 0
  for (const point of observed) {
    covariance += (point.index - meanIndex) * (point.value - meanValue)
    variance += (point.index - meanIndex) ** 2
  }
  if (variance === 0) return null
  return Math.round((covariance / variance) * 7 * 100) / 100
}

const SCORE_KEYS: ScoreKey[] = ['recovery', 'load', 'sleepQuality']

const explainScore: ToolDefinition = {
  name: 'explain_score',
  description: 'Break a score into the factors that produced it, with each factor\'s deviation, weight, and points.',
  schema: {
    type: 'object',
    properties: { score: { type: 'string', enum: SCORE_KEYS } },
    required: ['score'],
  },
  run: (args, context) => {
    const score = String(args.score ?? '') as ScoreKey
    if (!SCORE_KEYS.includes(score)) {
      return toolError(`Unknown score "${score}". Available: ${SCORE_KEYS.join(', ')}.`)
    }
    const result = computeScores(context.data, context.history)[score]
    return {
      score,
      date: context.data.selectedDate,
      value: result.value,
      status: result.status,
      confidence: result.confidence,
      baselineDays: result.baselineDays,
      contributions: result.contributions,
      missing: result.missing,
    }
  },
}

const dataCoverage: ToolDefinition = {
  name: 'data_coverage',
  description: 'Report which metrics have data over a range, how many days each has, and which are absent entirely.',
  schema: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'YYYY-MM-DD' },
      end: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['start', 'end'],
  },
  run: (args, context) => {
    const range = readRange(args)
    if ('error' in range) return range

    const days = context.history.days.filter((day) => day.date >= range.start && day.date <= range.end)
    const metrics = METRIC_KEYS.map((metric) => ({
      metric,
      n: finite(days.map((day) => METRICS[metric](day.trend))).length, // metric comes from METRIC_KEYS, so it is always own
    }))
    return {
      start: range.start,
      end: range.end,
      totalDays: days.length,
      firstDate: days[0]?.date ?? null,
      lastDate: days.at(-1)?.date ?? null,
      metrics: metrics.filter((entry) => entry.n > 0),
      missing: metrics.filter((entry) => entry.n === 0).map((entry) => entry.metric),
      intradayDays: days.filter((day) => day.heartIntraday !== null).length,
    }
  },
}

const metricWindow: ToolDefinition = {
  name: 'metric_window',
  description: 'Summarise one metric over a date range: count, median, spread, extremes, and weekly slope.',
  schema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: METRIC_KEYS },
      start: { type: 'string', description: 'YYYY-MM-DD' },
      end: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['metric', 'start', 'end'],
  },
  run: (args, context) => {
    const metric = readMetric(args)
    if ('error' in metric) return metric
    const range = readRange(args)
    if ('error' in range) return range

    const points = seriesFor(context, metric.metric, range.start, range.end)
    const values = finite(points.map((point) => point.value))
    if (!values.length) {
      return { insufficient: true, n: 0, metric: metric.metric, start: range.start, end: range.end }
    }
    const baseline = robustBaseline(values)
    const observed = points.filter((point) => point.value !== null)
    return {
      metric: metric.metric,
      start: range.start,
      end: range.end,
      n: values.length,
      median: baseline.center,
      spread: baseline.spread,
      min: Math.min(...values),
      max: Math.max(...values),
      first: observed[0]?.value ?? null,
      last: observed.at(-1)?.value ?? null,
      slopePerWeek: slopePerWeek(points),
    }
  },
}

const comparePeriods: ToolDefinition = {
  name: 'compare_periods',
  description: 'Compare one metric between two date ranges: median of each, the difference, and the count behind each.',
  schema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: METRIC_KEYS },
      firstStart: { type: 'string', description: 'YYYY-MM-DD' },
      firstEnd: { type: 'string', description: 'YYYY-MM-DD' },
      secondStart: { type: 'string', description: 'YYYY-MM-DD' },
      secondEnd: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['metric', 'firstStart', 'firstEnd', 'secondStart', 'secondEnd'],
  },
  run: (args, context) => {
    const metric = readMetric(args)
    if ('error' in metric) return metric
    const first = readRange(args, 'firstStart', 'firstEnd')
    if ('error' in first) return first
    const second = readRange(args, 'secondStart', 'secondEnd')
    if ('error' in second) return second

    const summarise = (start: string, end: string) => {
      const values = finite(seriesFor(context, metric.metric, start, end).map((point) => point.value))
      return { start, end, n: values.length, median: robustBaseline(values).center }
    }
    const firstSummary = summarise(first.start, first.end)
    const secondSummary = summarise(second.start, second.end)

    if (firstSummary.median === null || secondSummary.median === null) {
      return { insufficient: true, metric: metric.metric, first: firstSummary, second: secondSummary }
    }
    const delta = secondSummary.median - firstSummary.median
    return {
      metric: metric.metric,
      first: firstSummary,
      second: secondSummary,
      delta,
      percentChange: firstSummary.median === 0 ? null : Math.round((delta / firstSummary.median) * 1000) / 10,
    }
  },
}

const weekdayPattern: ToolDefinition = {
  name: 'weekday_pattern',
  description: 'Median of one metric for each day of the week over a range, with the count behind each day.',
  schema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: METRIC_KEYS },
      start: { type: 'string', description: 'YYYY-MM-DD' },
      end: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['metric', 'start', 'end'],
  },
  run: (args, context) => {
    const metric = readMetric(args)
    if ('error' in metric) return metric
    const range = readRange(args)
    if ('error' in range) return range

    const points = seriesFor(context, metric.metric, range.start, range.end)
    if (!finite(points.map((point) => point.value)).length) {
      return { insufficient: true, n: 0, metric: metric.metric }
    }
    return { metric: metric.metric, start: range.start, end: range.end, weekdays: weekdayMedians(points) }
  },
}

/** Days the second metric may trail the first by, in either direction. */
const MAX_LAG_DAYS = 14

function shiftIso(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

const correlate: ToolDefinition = {
  name: 'correlate',
  description: 'Spearman correlation between two metrics, optionally offsetting the second by a number of days.',
  schema: {
    type: 'object',
    properties: {
      first: { type: 'string', enum: METRIC_KEYS },
      second: { type: 'string', enum: METRIC_KEYS },
      lagDays: { type: 'integer', description: `Days to offset the second metric, -${MAX_LAG_DAYS}..${MAX_LAG_DAYS}` },
      start: { type: 'string', description: 'YYYY-MM-DD' },
      end: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['first', 'second', 'lagDays', 'start', 'end'],
  },
  run: (args, context) => {
    const first = readMetric({ metric: args.first })
    if ('error' in first) return first
    const second = readMetric({ metric: args.second })
    if ('error' in second) return second
    const range = readRange(args)
    if ('error' in range) return range

    const lagDays = Number(args.lagDays)
    if (!Number.isInteger(lagDays) || Math.abs(lagDays) > MAX_LAG_DAYS) {
      return toolError(`lagDays must be a whole number between -${MAX_LAG_DAYS} and ${MAX_LAG_DAYS}.`)
    }

    // Get accessors with own-property check, matching seriesFor pattern
    if (!Object.prototype.hasOwnProperty.call(METRICS, first.metric)) return toolError(`Metric not found: ${first.metric}`)
    if (!Object.prototype.hasOwnProperty.call(METRICS, second.metric)) return toolError(`Metric not found: ${second.metric}`)
    const leftAccessor = METRICS[first.metric]!
    const rightAccessor = METRICS[second.metric]!

    const byDate = new Map(context.history.days.map((day) => [day.date, day.trend]))
    const pairs: Array<[number, number]> = []
    for (const day of context.history.days) {
      if (day.date < range.start || day.date > range.end) continue

      const left = leftAccessor(day.trend)
      const partner = byDate.get(shiftIso(day.date, lagDays))
      const right = partner ? rightAccessor(partner) : null

      if (left !== null && right !== null && Number.isFinite(left) && Number.isFinite(right)) {
        pairs.push([left, right])
      }
    }

    const result = spearman(pairs)
    return {
      first: first.metric,
      second: second.metric,
      lagDays,
      start: range.start,
      end: range.end,
      rho: result.rho,
      n: result.n,
      significant: result.significant,
      note: 'Correlation is not causation.',
    }
  },
}

const recall: ToolDefinition = {
  name: 'recall',
  description: 'Recall user-approved episodes or conclusions relevant to an optional date range or metric.',
  schema: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'Optional YYYY-MM-DD' },
      end: { type: 'string', description: 'Optional YYYY-MM-DD' },
      metric: { type: 'string', enum: METRIC_KEYS },
    },
    required: [],
  },
  run: (args, context) => {
    const start = args.start === undefined ? undefined : String(args.start)
    const end = args.end === undefined ? undefined : String(args.end)
    if ((start && !ISO_DATE.test(start)) || (end && !ISO_DATE.test(end)) || (start && end && start > end)) return toolError('Recall dates must be a valid ordered YYYY-MM-DD range.')
    const metric = args.metric === undefined ? undefined : readMetric(args)
    if (metric && 'error' in metric) return metric
    const entries = relevantMemory(context.memory || [], {
      start, end,
      metrics: metric ? [metric.metric] : [],
    }).filter((entry) => entry.kind === 'episode' || entry.kind === 'conclusion')
    return entries.length ? { entries } : { insufficient: true, entries: [] }
  },
}

export const ASSISTANT_TOOLS: ToolDefinition[] = [
  metricWindow,
  explainScore,
  dataCoverage,
  comparePeriods,
  weekdayPattern,
  correlate,
  recall,
]

export const TOOL_NAMES = ASSISTANT_TOOLS.map((tool) => tool.name)

export function runTool(name: string, args: Record<string, unknown>, context: ToolContext): unknown {
  const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return toolError(`Unknown tool "${name}".`)
  return tool.run(args, context)
}
