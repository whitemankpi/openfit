import type { DashboardData, TrendPoint } from '@/types'
import type { History } from '@/data/history'
import { robustBaseline } from './home-analysis'

export interface ToolContext {
  data: DashboardData
  history: History
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
  if (!METRICS[metric]) return { error: `Unknown metric "${metric}". Available: ${METRIC_KEYS.join(', ')}.` }
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
  const select = METRICS[metric]
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

export const ASSISTANT_TOOLS: ToolDefinition[] = [metricWindow]

export const TOOL_NAMES = ASSISTANT_TOOLS.map((tool) => tool.name)

export function runTool(name: string, args: Record<string, unknown>, context: ToolContext): unknown {
  const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return toolError(`Unknown tool "${name}".`)
  return tool.run(args, context)
}
