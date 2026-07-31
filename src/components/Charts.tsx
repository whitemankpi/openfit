import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { SleepStage, SleepStageSegment } from '../types'
import { formatDate, formatNumber, formatTime } from '../lib/format'

type NumericValue = number | null

interface ChartBand {
  lower: NumericValue
  upper: NumericValue
}

interface BaseChartProps {
  values: NumericValue[]
  labels?: string[]
  xValues?: number[]
  color?: string
  height?: number
  compact?: boolean
  formatter?: (value: number) => string
  target?: number | null
  targetLabel?: string
  ariaLabel?: string
  variant?: 'line' | 'area'
  showRangeLabels?: boolean
  band?: ChartBand[]
  bandLabel?: string
  aggregate?: boolean
}

/** Above this many points, LineChart/ColumnChart auto-aggregate into weekly buckets so marks stay legible. */
const WEEKLY_BUCKET_THRESHOLD = 120

function isoWeekKey(timestamp: number) {
  const date = new Date(timestamp)
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNumber = (utc.getUTCDay() + 6) % 7 // Monday = 0 .. Sunday = 6
  utc.setUTCDate(utc.getUTCDate() - dayNumber + 3)
  const firstThursday = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4))
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3)
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function meanOrNull(values: NumericValue[]) {
  const finite = finiteValues(values)
  if (!finite.length) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

/**
 * Groups points into ISO weeks when there are more than WEEKLY_BUCKET_THRESHOLD of them,
 * mirroring ColumnChart's existing xValues-derived typicalStep so the time axis keeps working.
 * A bucket's timestamp is its last point's timestamp (bucket.at(-1)), matching ColumnChart convention.
 */
function bucketWeekly({
  values,
  labels,
  xValues,
  band,
}: {
  values: NumericValue[]
  labels: string[]
  xValues?: number[]
  band?: ChartBand[]
}) {
  const resolvedX = xValues?.length === values.length && xValues.every(Number.isFinite)
    ? xValues
    : values.map((_, index) => index)

  const order = values.map((_, index) => index).sort((a, b) => resolvedX[a] - resolvedX[b])
  const buckets = new Map<string, number[]>()
  order.forEach((index) => {
    const key = isoWeekKey(resolvedX[index])
    const existing = buckets.get(key)
    if (existing) existing.push(index)
    else buckets.set(key, [index])
  })

  const bucketedValues: NumericValue[] = []
  const bucketedLabels: string[] = []
  const bucketedX: number[] = []
  const bucketedBand: ChartBand[] | undefined = band ? [] : undefined

  buckets.forEach((indexes) => {
    const lastIndex = indexes.at(-1) as number
    bucketedValues.push(meanOrNull(indexes.map((index) => values[index])))
    bucketedLabels.push(labels[lastIndex] ?? `Week of ${labels[indexes[0]] ?? lastIndex}`)
    bucketedX.push(resolvedX[lastIndex])
    if (band && bucketedBand) {
      bucketedBand.push({
        lower: meanOrNull(indexes.map((index) => band[index]?.lower ?? null)),
        upper: meanOrNull(indexes.map((index) => band[index]?.upper ?? null)),
      })
    }
  })

  return { values: bucketedValues, labels: bucketedLabels, xValues: bucketedX, band: bucketedBand }
}

function finiteValues(values: NumericValue[]) {
  return values.filter((value): value is number => value !== null && Number.isFinite(value))
}

function useResponsiveChartWidth(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!active || !container) return

    const updateWidth = (nextWidth: number) => {
      if (nextWidth > 0) setWidth(Math.max(240, Math.round(nextWidth)))
    }
    updateWidth(container.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width
      if (nextWidth) updateWidth(nextWidth)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [active])

  return { containerRef, width }
}

function niceStep(range: number, tickCount = 3) {
  const rough = Math.max(range / Math.max(1, tickCount - 1), Number.EPSILON)
  const power = 10 ** Math.floor(Math.log10(rough))
  const fraction = rough / power
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 3 ? 2.5 : fraction <= 5 ? 5 : 10
  return niceFraction * power
}

function lineDomain(values: number[], target: number | null) {
  const withTarget = target === null ? values : [...values, target]
  const rawMin = Math.min(...withTarget)
  const rawMax = Math.max(...withTarget)
  const rawRange = Math.max(rawMax - rawMin, Math.abs(rawMax) * 0.08, 1)
  const step = niceStep(rawRange, 5)
  const paddedMin = Math.floor((rawMin - rawRange * 0.06) / step) * step
  const min = rawMin < 0 ? paddedMin : Math.max(0, paddedMin)
  const max = Math.ceil((rawMax + rawRange * 0.08) / step) * step
  return { min, max: max <= min ? min + step : max, step }
}

function chartSummary(values: number[], formatter: (value: number) => string) {
  const latest = values.at(-1)
  return `Minimum ${formatter(Math.min(...values))}, maximum ${formatter(Math.max(...values))}${latest === undefined ? '' : `, latest value ${formatter(latest)}`}.`
}

function AccessibleChartTable({
  title,
  labels,
  values,
  formatter,
}: {
  title: string
  labels: string[]
  values: NumericValue[]
  formatter: (value: number) => string
}) {
  return (
    <table className="sr-only chart-data-table">
      <caption>{title}</caption>
      <thead><tr><th scope="col">Period</th><th scope="col">Value</th></tr></thead>
      <tbody>
        {values.map((value, index) => (
          <tr key={`${labels[index] ?? index}-${index}`}>
            <th scope="row">{labels[index] ?? `Point ${index + 1}`}</th>
            <td>{value === null ? 'Missing data' : formatter(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CompactRangeLabels({ labels }: { labels: string[] }) {
  if (labels.length < 2) return null
  const middle = labels[Math.floor((labels.length - 1) / 2)]
  return (
    <div className="chart-range-labels" aria-hidden="true">
      <span>{labels[0]}</span>
      <span>{middle}</span>
      <span>{labels.at(-1)}</span>
    </div>
  )
}

export function LineChart({
  values: rawValues,
  labels: rawLabels = [],
  xValues: rawXValues,
  color = 'var(--color-indigo)',
  height = 220,
  compact = false,
  formatter = (value) => formatNumber(value),
  target = null,
  targetLabel = 'Goal',
  ariaLabel = 'Trend over time',
  variant = 'line',
  showRangeLabels = false,
  band: rawBand,
  bandLabel = 'Typical range',
  aggregate = true,
}: BaseChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const areaId = useId().replace(/:/g, '')
  const shouldBucket = aggregate && rawValues.length > WEEKLY_BUCKET_THRESHOLD
  const bucketed = shouldBucket
    ? bucketWeekly({ values: rawValues, labels: rawLabels, xValues: rawXValues, band: rawBand })
    : null
  const values = bucketed?.values ?? rawValues
  const labels = bucketed?.labels ?? rawLabels
  const xValues = bucketed?.xValues ?? rawXValues
  const band = bucketed?.band ?? rawBand
  const valid = finiteValues(values)
  const { containerRef, width } = useResponsiveChartWidth(valid.length > 0)
  if (!valid.length) return <div className="chart-empty" style={{ height }}>No data for this range</div>

  const margin = compact
    ? { top: 7, right: 2, bottom: showRangeLabels ? 22 : 7, left: 2 }
    : { top: 18, right: 14, bottom: 30, left: 64 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const domain = lineDomain(valid, target)
  const validX = xValues?.length === values.length && xValues.every(Number.isFinite) ? xValues : values.map((_, index) => index)
  const xMin = Math.min(...validX)
  const xMax = Math.max(...validX)
  const xFor = (index: number) => margin.left + (xMax === xMin ? plotWidth / 2 : ((validX[index] - xMin) / (xMax - xMin)) * plotWidth)
  const yFor = (value: number) => margin.top + ((domain.max - value) / (domain.max - domain.min)) * plotHeight
  const segmentIndexes: number[][] = []
  let currentIndexes: number[] = []
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (currentIndexes.length) segmentIndexes.push(currentIndexes)
      currentIndexes = []
      return
    }
    currentIndexes.push(index)
  })
  if (currentIndexes.length) segmentIndexes.push(currentIndexes)
  const baseline = margin.top + plotHeight
  const segments = segmentIndexes.map((indexes) => {
    const line = indexes.map((index, position) => {
      const value = values[index] as number
      return `${position ? 'L' : 'M'} ${xFor(index).toFixed(2)} ${yFor(value).toFixed(2)}`
    }).join(' ')
    const first = indexes[0]
    const last = indexes[indexes.length - 1]
    return {
      line,
      area: `M ${xFor(first).toFixed(2)} ${baseline.toFixed(2)} ${line.replace(/^M/, 'L')} L ${xFor(last).toFixed(2)} ${baseline.toFixed(2)} Z`,
    }
  })
  const bandAreas = band && band.length === values.length
    ? (() => {
        const bandSegmentIndexes: number[][] = []
        let currentBandIndexes: number[] = []
        band.forEach((entry, index) => {
          const lower = entry?.lower
          const upper = entry?.upper
          if (lower === null || lower === undefined || upper === null || upper === undefined || !Number.isFinite(lower) || !Number.isFinite(upper)) {
            if (currentBandIndexes.length) bandSegmentIndexes.push(currentBandIndexes)
            currentBandIndexes = []
            return
          }
          currentBandIndexes.push(index)
        })
        if (currentBandIndexes.length) bandSegmentIndexes.push(currentBandIndexes)
        return bandSegmentIndexes.map((indexes) => {
          const top = indexes.map((index, position) => `${position ? 'L' : 'M'} ${xFor(index).toFixed(2)} ${yFor(band[index].upper as number).toFixed(2)}`).join(' ')
          const bottom = [...indexes].reverse().map((index) => `L ${xFor(index).toFixed(2)} ${yFor(band[index].lower as number).toFixed(2)}`).join(' ')
          return `${top} ${bottom} Z`
        })
      })()
    : []
  const middleTick = Math.min(domain.max, domain.min + Math.ceil((domain.max - domain.min) / (domain.step * 2)) * domain.step)
  const ticks = [domain.min, middleTick, domain.max]
  const labelEvery = Math.max(1, Math.ceil(labels.length / 6))
  let lastValidIndex = values.length - 1
  while (lastValidIndex > 0 && (values[lastValidIndex] === null || !Number.isFinite(values[lastValidIndex]))) lastValidIndex -= 1
  const activeValue = activeIndex === null ? null : values[activeIndex]
  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const pointerX = (event.clientX - bounds.left) / Math.max(bounds.width, 1) * width
    let nearestIndex: number | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    values.forEach((value, index) => {
      if (value === null || !Number.isFinite(value)) return
      const distance = Math.abs(xFor(index) - pointerX)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    })
    setActiveIndex(nearestIndex)
  }
  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const available = values.flatMap((value, index) => value !== null && Number.isFinite(value) ? [index] : [])
    if (!available.length) return
    const currentPosition = activeIndex === null ? available.length - 1 : Math.max(0, available.indexOf(activeIndex))
    const nextPosition = event.key === 'ArrowRight'
      ? Math.min(available.length - 1, currentPosition + 1)
      : Math.max(0, currentPosition - 1)
    setActiveIndex(available[nextPosition])
  }

  return (
    <div ref={containerRef} className={`line-chart ${compact ? 'is-compact' : ''} is-${variant}`} style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setActiveIndex(null)}
        onFocus={() => setActiveIndex(lastValidIndex)}
        onBlur={() => setActiveIndex(null)}
        onKeyDown={handleKeyDown}
      >
        <title>{ariaLabel}</title>
        <desc>{chartSummary(valid, formatter)}</desc>
        {bandAreas.map((area, index) => (
          <path key={`band-${areaId}-${index}`} d={area} fill="var(--color-fog)" fillOpacity={0.1} stroke="none" aria-hidden="true" />
        ))}
        {variant === 'area' && segments.map((segment, index) => (
          <path
            key={`area-${areaId}-${index}`}
            d={segment.area}
            fill={color}
            fillOpacity={compact ? 0.12 : 0.09}
            stroke="none"
          />
        ))}
        {!compact && ticks.map((tick, index) => {
          const y = yFor(tick)
          return (
            <g key={`${tick}-${index}`}>
              <line x1={margin.left} y1={y} x2={width - margin.right} y2={y} className="chart-gridline" />
              <text x={margin.left - 9} y={y + 3} textAnchor="end" className="chart-tick">{formatter(tick)}</text>
            </g>
          )
        })}
        {target !== null && target >= domain.min && target <= domain.max && (
          <g>
            <line x1={margin.left} y1={yFor(target)} x2={width - margin.right} y2={yFor(target)} className="chart-target-line" />
            {!compact && <text x={width - margin.right} y={yFor(target) - 7} textAnchor="end" className="chart-target-label">{targetLabel} · {formatter(target)}</text>}
          </g>
        )}
        {segments.map((segment, index) => (
          <path key={index} d={segment.line} fill="none" stroke={color} strokeWidth={compact ? 2.4 : 2.6} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {!compact && values.length <= 20 && values.map((value, index) => value !== null && Number.isFinite(value) ? (
          <circle key={index} cx={xFor(index)} cy={yFor(value)} r={index === lastValidIndex ? 4 : 2.8} fill="var(--card)" stroke={color} strokeWidth="2">
            <title>{`${labels[index] ?? `Point ${index + 1}`}: ${formatter(value)}`}</title>
          </circle>
        ) : null)}
        {!compact && labels.map((label, index) => {
          const lastIndex = labels.length - 1
          if (index !== lastIndex && (index % labelEvery !== 0 || lastIndex - index < labelEvery)) return null
          return <text key={`${label}-${index}`} x={xFor(index)} y={height - 7} textAnchor="middle" className="chart-label">{label}</text>
        })}
        {activeIndex !== null && activeValue !== null && Number.isFinite(activeValue) && (
          <g className="chart-active-mark" aria-hidden="true">
            <line x1={xFor(activeIndex)} y1={margin.top} x2={xFor(activeIndex)} y2={baseline} className="chart-hover-guide" />
            <circle cx={xFor(activeIndex)} cy={yFor(activeValue)} r={compact ? 5 : 5.5} fill="var(--card)" stroke={color} strokeWidth="3" />
          </g>
        )}
      </svg>
      {activeIndex !== null && activeValue !== null && Number.isFinite(activeValue) && (
        <div
          className="chart-tooltip"
          style={{ left: `clamp(52px, ${xFor(activeIndex) / width * 100}%, calc(100% - 52px))`, top: `${yFor(activeValue) / height * 100}%` }}
          role="status"
        >
          <span>{labels[activeIndex] ?? `Point ${activeIndex + 1}`}</span>
          <strong>{formatter(activeValue)}</strong>
          {band && band[activeIndex]?.lower !== null && band[activeIndex]?.lower !== undefined
            && band[activeIndex]?.upper !== null && band[activeIndex]?.upper !== undefined && (
            <span>{bandLabel}: {formatter(band[activeIndex].lower as number)}–{formatter(band[activeIndex].upper as number)}</span>
          )}
        </div>
      )}
      {compact && showRangeLabels && <CompactRangeLabels labels={labels} />}
      <AccessibleChartTable title={ariaLabel} labels={labels} values={values} formatter={formatter} />
    </div>
  )
}

export function ColumnChart({
  values: rawValues,
  labels: rawLabels = [],
  xValues: rawXValues,
  color = 'var(--color-indigo)',
  height = 220,
  compact = false,
  formatter = (value) => formatNumber(value),
  target = null,
  targetLabel = 'Goal',
  ariaLabel = 'Values by period',
  showRangeLabels = false,
  aggregate = true,
}: BaseChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const shouldBucket = aggregate && rawValues.length > WEEKLY_BUCKET_THRESHOLD
  const bucketed = shouldBucket
    ? bucketWeekly({ values: rawValues, labels: rawLabels, xValues: rawXValues })
    : null
  const values = bucketed?.values ?? rawValues
  const labels = bucketed?.labels ?? rawLabels
  const xValues = bucketed?.xValues ?? rawXValues
  const valid = finiteValues(values)
  const { containerRef, width } = useResponsiveChartWidth(valid.length > 0)
  if (!valid.length) return <div className="chart-empty" style={{ height }}>No data for this range</div>

  const margin = compact
    ? { top: 8, right: 2, bottom: showRangeLabels ? 22 : 8, left: 2 }
    : { top: 20, right: 14, bottom: 30, left: 48 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const rawMax = Math.max(...valid, target ?? 0, 1)
  const step = niceStep(rawMax, 4)
  const max = Math.ceil(rawMax / step) * step
  const validX = xValues?.length === values.length && xValues.every(Number.isFinite) ? xValues : values.map((_, index) => index)
  const sortedX = [...validX].sort((a, b) => a - b)
  const positiveSteps = sortedX.slice(1).map((value, index) => value - sortedX[index]).filter((value) => value > 0)
  const typicalStep = positiveSteps.length ? Math.min(...positiveSteps) : 1
  const xMin = Math.min(...validX) - typicalStep / 2
  const xMax = Math.max(...validX) + typicalStep / 2
  const slotWidth = plotWidth * typicalStep / Math.max(typicalStep, xMax - xMin)
  const barWidth = Math.max(3, Math.min(compact ? 14 : 26, slotWidth * 0.62))
  const yFor = (value: number) => margin.top + (1 - value / max) * plotHeight
  const xCenter = (index: number) => margin.left + ((validX[index] - xMin) / Math.max(typicalStep, xMax - xMin)) * plotWidth
  const ticks = [0, max / 2, max]
  const labelEvery = Math.max(1, Math.ceil(labels.length / 7))
  const activeValue = activeIndex === null ? null : values[activeIndex]

  return (
    <div ref={containerRef} className={`column-chart ${compact ? 'is-compact' : ''}`} style={{ height }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActiveIndex(null)}>
        <title>{ariaLabel}</title>
        <desc>{chartSummary(valid, formatter)}</desc>
        {compact && (
          <line
            x1={margin.left}
            y1={margin.top + plotHeight}
            x2={width - margin.right}
            y2={margin.top + plotHeight}
            className="chart-baseline"
          />
        )}
        {!compact && ticks.map((tick, index) => {
          const y = yFor(tick)
          return (
            <g key={`${tick}-${index}`}>
              <line x1={margin.left} y1={y} x2={width - margin.right} y2={y} className="chart-gridline" />
              <text x={margin.left - 9} y={y + 3} textAnchor="end" className="chart-tick">{formatter(tick)}</text>
            </g>
          )
        })}
        {target !== null && target <= max && (
          <g>
            <line x1={margin.left} y1={yFor(target)} x2={width - margin.right} y2={yFor(target)} className="chart-target-line" />
            {!compact && <text x={width - margin.right} y={yFor(target) - 7} textAnchor="end" className="chart-target-label">{targetLabel} · {formatter(target)}</text>}
          </g>
        )}
        {values.map((value, index) => {
          const numeric = value ?? 0
          const barHeight = value === null ? 0 : (numeric / max) * plotHeight
          return (
            <rect
              key={`${labels[index] ?? index}-${index}`}
              x={xCenter(index) - barWidth / 2}
              y={margin.top + plotHeight - barHeight}
              width={barWidth}
              height={barHeight}
              rx={Math.min(4, barWidth / 3)}
              fill={value === null ? 'var(--color-graphite)' : color}
              opacity={value === null ? 0.3 : activeIndex === null || activeIndex === index ? 0.92 : 0.34}
              className="chart-column-mark"
              tabIndex={value === null ? undefined : 0}
              aria-label={value === null ? `${labels[index] ?? `Period ${index + 1}`}: no data` : `${labels[index] ?? `Period ${index + 1}`}: ${formatter(value)}`}
              onPointerEnter={() => value !== null && setActiveIndex(index)}
              onFocus={() => value !== null && setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
            >
              <title>{value === null ? `${labels[index] ?? `Period ${index + 1}`}: no data` : `${labels[index] ?? `Period ${index + 1}`}: ${formatter(value)}`}</title>
            </rect>
          )
        })}
        {!compact && labels.map((label, index) => {
          const lastIndex = labels.length - 1
          if (index !== lastIndex && (index % labelEvery !== 0 || lastIndex - index < labelEvery)) return null
          return <text key={`${label}-${index}`} x={xCenter(index)} y={height - 7} textAnchor="middle" className="chart-label">{label}</text>
        })}
      </svg>
      {activeIndex !== null && activeValue !== null && Number.isFinite(activeValue) && (
        <div
          className="chart-tooltip"
          style={{ left: `clamp(52px, ${xCenter(activeIndex) / width * 100}%, calc(100% - 52px))`, top: `${yFor(activeValue) / height * 100}%` }}
          role="status"
        >
          <span>{labels[activeIndex] ?? `Period ${activeIndex + 1}`}</span>
          <strong>{formatter(activeValue)}</strong>
        </div>
      )}
      {compact && showRangeLabels && <CompactRangeLabels labels={labels} />}
      <AccessibleChartTable title={ariaLabel} labels={labels} values={values} formatter={formatter} />
    </div>
  )
}

export interface SleepStageNight {
  deep: number
  light: number
  rem: number
  wake: number
}

const stackedStageOrder = ['deep', 'light', 'rem', 'wake'] as const
const stackedStageConfig: Record<(typeof stackedStageOrder)[number], { label: string; color: string }> = {
  deep: { label: 'Deep', color: 'var(--sleep-deep)' },
  light: { label: 'Light', color: 'var(--sleep-light)' },
  rem: { label: 'REM', color: 'var(--sleep-rem)' },
  wake: { label: 'Awake', color: 'var(--sleep-wake)' },
}

export function StackedColumnChart({
  points,
  labels = [],
  xValues,
  height = 220,
  compact = false,
  formatter = (value) => formatNumber(value),
  ariaLabel = 'Sleep stages by night',
  showRangeLabels = false,
}: {
  points: Array<SleepStageNight | null>
  labels?: string[]
  xValues?: number[]
  height?: number
  compact?: boolean
  formatter?: (value: number) => string
  ariaLabel?: string
  showRangeLabels?: boolean
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const valid = points.filter((point): point is SleepStageNight => point !== null)
  const { containerRef, width } = useResponsiveChartWidth(valid.length > 0)
  if (!valid.length) return <div className="chart-empty" style={{ height }}>No data for this range</div>

  const margin = compact
    ? { top: 8, right: 2, bottom: showRangeLabels ? 22 : 8, left: 2 }
    : { top: 20, right: 14, bottom: 30, left: 48 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const validTotals = valid.map((point) => stackedStageOrder.reduce((sum, key) => sum + point[key], 0))
  const pointTotals = points.map((point) => point === null ? null : stackedStageOrder.reduce((sum, key) => sum + point[key], 0))
  const rawMax = Math.max(...validTotals, 1)
  const step = niceStep(rawMax, 4)
  const max = Math.ceil(rawMax / step) * step
  const validX = xValues?.length === points.length && xValues.every(Number.isFinite) ? xValues : points.map((_, index) => index)
  const sortedX = [...validX].sort((a, b) => a - b)
  const positiveSteps = sortedX.slice(1).map((value, index) => value - sortedX[index]).filter((value) => value > 0)
  const typicalStep = positiveSteps.length ? Math.min(...positiveSteps) : 1
  const xMin = Math.min(...validX) - typicalStep / 2
  const xMax = Math.max(...validX) + typicalStep / 2
  const slotWidth = plotWidth * typicalStep / Math.max(typicalStep, xMax - xMin)
  const barWidth = Math.max(3, Math.min(compact ? 14 : 26, slotWidth * 0.62))
  const yFor = (value: number) => margin.top + (1 - value / max) * plotHeight
  const xCenter = (index: number) => margin.left + ((validX[index] - xMin) / Math.max(typicalStep, xMax - xMin)) * plotWidth
  const ticks = [0, max / 2, max]
  const labelEvery = Math.max(1, Math.ceil(labels.length / 7))
  const activeTotal = activeIndex === null ? null : pointTotals[activeIndex]
  const activePoint = activeIndex === null ? null : points[activeIndex]
  const tableValues = pointTotals

  return (
    <div ref={containerRef} className={`column-chart stacked-column-chart ${compact ? 'is-compact' : ''}`} style={{ height }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActiveIndex(null)}>
        <title>{ariaLabel}</title>
        <desc>{`Nightly sleep stage minutes across ${valid.length} recorded nights.`}</desc>
        {compact && (
          <line
            x1={margin.left}
            y1={margin.top + plotHeight}
            x2={width - margin.right}
            y2={margin.top + plotHeight}
            className="chart-baseline"
          />
        )}
        {!compact && ticks.map((tick, index) => {
          const y = yFor(tick)
          return (
            <g key={`${tick}-${index}`}>
              <line x1={margin.left} y1={y} x2={width - margin.right} y2={y} className="chart-gridline" />
              <text x={margin.left - 9} y={y + 3} textAnchor="end" className="chart-tick">{formatter(tick)}</text>
            </g>
          )
        })}
        {points.map((point, index) => {
          if (point === null) {
            return (
              <rect
                key={`${labels[index] ?? index}-${index}`}
                x={xCenter(index) - barWidth / 2}
                y={margin.top}
                width={barWidth}
                height={plotHeight}
                rx={Math.min(4, barWidth / 3)}
                fill="var(--color-graphite)"
                opacity={0.3}
                className="chart-column-mark"
                aria-label={`${labels[index] ?? `Period ${index + 1}`}: no data`}
              >
                <title>{`${labels[index] ?? `Period ${index + 1}`}: no data`}</title>
              </rect>
            )
          }
          let cursor = margin.top + plotHeight
          const barLabel = `${labels[index] ?? `Period ${index + 1}`}: ${stackedStageOrder.map((key) => `${stackedStageConfig[key].label} ${formatter(point[key])}`).join(', ')}`
          return (
            <g
              key={`${labels[index] ?? index}-${index}`}
              tabIndex={0}
              aria-label={barLabel}
              className="chart-column-mark"
              opacity={activeIndex === null || activeIndex === index ? 0.92 : 0.34}
              onPointerEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
            >
              <title>{barLabel}</title>
              {stackedStageOrder.map((key) => {
                const segmentHeight = (point[key] / max) * plotHeight
                const y = cursor - segmentHeight
                cursor = y
                return (
                  <rect
                    key={key}
                    x={xCenter(index) - barWidth / 2}
                    y={y}
                    width={barWidth}
                    height={segmentHeight}
                    fill={stackedStageConfig[key].color}
                  />
                )
              })}
            </g>
          )
        })}
        {!compact && labels.map((label, index) => {
          const lastIndex = labels.length - 1
          if (index !== lastIndex && (index % labelEvery !== 0 || lastIndex - index < labelEvery)) return null
          return <text key={`${label}-${index}`} x={xCenter(index)} y={height - 7} textAnchor="middle" className="chart-label">{label}</text>
        })}
      </svg>
      {activeIndex !== null && activePoint !== null && (
        <div
          className="chart-tooltip"
          style={{ left: `clamp(52px, ${xCenter(activeIndex) / width * 100}%, calc(100% - 52px))`, top: `${yFor(activeTotal ?? 0) / height * 100}%` }}
          role="status"
        >
          <span>{labels[activeIndex] ?? `Period ${activeIndex + 1}`}</span>
          {stackedStageOrder.map((key) => (
            <strong key={key}>{stackedStageConfig[key].label}: {formatter(activePoint[key])}</strong>
          ))}
        </div>
      )}
      {compact && showRangeLabels && <CompactRangeLabels labels={labels} />}
      <div className="stacked-chart-legend" aria-hidden="true">
        {stackedStageOrder.map((key) => (
          <span key={key}><i className="legend-dot" style={{ background: stackedStageConfig[key].color }} />{stackedStageConfig[key].label}</span>
        ))}
      </div>
      <AccessibleChartTable title={ariaLabel} labels={labels} values={tableValues} formatter={formatter} />
    </div>
  )
}

export function RadialProgress({
  value,
  max = 100,
  color = 'var(--color-indigo)',
  label,
  valueLabel,
  size = 84,
}: {
  value: number | null
  max?: number
  color?: string
  label: string
  valueLabel?: string
  size?: number
}) {
  if (value === null || !Number.isFinite(value)) return null
  const safeMax = Math.max(1, max)
  const progress = Math.min(1, Math.max(0, value / safeMax))
  const radius = 42
  const circumference = Math.PI * 2 * radius
  const displayValue = valueLabel ?? `${Math.round(progress * 100)}%`
  return (
    <div className="radial-progress" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${displayValue}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="radial-track" cx="50" cy="50" r={radius} />
        <circle
          className="radial-value"
          cx="50"
          cy="50"
          r={radius}
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
      <span><strong>{displayValue}</strong><small>{label}</small></span>
    </div>
  )
}

export function BulletChart({
  value,
  target,
  max,
  color = 'var(--color-indigo)',
  label,
  valueLabel,
}: {
  value: number | null
  target?: number | null
  max: number
  color?: string
  label: string
  valueLabel?: string
}) {
  if (value === null) return null
  const safeMax = Math.max(max, value, target ?? 0, 1)
  const valuePercent = Math.min(100, Math.max(0, value / safeMax * 100))
  const targetPercent = target === null || target === undefined ? null : Math.min(100, Math.max(0, target / safeMax * 100))
  return (
    <div className="bullet-chart" role="img" aria-label={`${label}: ${valueLabel ?? formatNumber(value)}${target === null || target === undefined ? '' : `, goal ${formatNumber(target)}`}`}>
      <div className="bullet-track">
        <span className="bullet-value" style={{ width: `${valuePercent}%`, background: color }} />
        {targetPercent !== null && <span className="bullet-target" style={{ left: `${targetPercent}%` }} />}
      </div>
      <div className="bullet-caption"><span>{label}</span><strong>{valueLabel ?? formatNumber(value)}</strong></div>
    </div>
  )
}

export function SleepStageBar({
  stages,
  compact = false,
  showLegend = true,
}: {
  stages: SleepStage[]
  compact?: boolean
  showLegend?: boolean
}) {
  const total = stages.reduce((sum, stage) => sum + stage.minutes, 0)
  if (!total) return <div className="chart-empty is-small">No sleep stages available</div>
  return (
    <div className={`sleep-stage-wrap ${compact ? 'is-compact' : ''}`}>
      <div className="sleep-stage-bar" role="img" aria-label={`Recorded-period distribution: ${stages.map((stage) => `${stage.name} ${stage.minutes} minutes`).join(', ')}`}>
        {stages.map((stage) => (
          <div
            key={stage.key}
            className="sleep-stage-segment"
            style={{ width: `${stage.minutes / total * 100}%`, background: `var(--sleep-${stage.key})` }}
            title={`${stage.name}: ${stage.minutes} min (${Math.round(stage.minutes / total * 100)}%)`}
          />
        ))}
      </div>
      {showLegend && (
        <div className="sleep-stage-legend">
          {stages.map((stage) => (
            <div key={stage.key}>
              <span className="legend-dot" style={{ background: `var(--sleep-${stage.key})` }} />
              <span>{stage.name}</span>
              <strong>{Math.round(stage.minutes / total * 100)}% · {Math.floor(stage.minutes / 60) ? `${Math.floor(stage.minutes / 60)}h ` : ''}{stage.minutes % 60}m</strong>
            </div>
          ))}
        </div>
      )}
      {!compact && <p className="sleep-stage-caption">Percentages of the recorded period, including awake time.</p>}
    </div>
  )
}

const sleepTimelineConfig = {
  wake: { label: 'Awake', color: 'var(--sleep-wake)' },
  rem: { label: 'REM', color: 'var(--sleep-rem)' },
  light: { label: 'Light', color: 'var(--sleep-light)' },
  deep: { label: 'Deep', color: 'var(--sleep-deep)' },
} as const

export function SleepStageTimeline({
  segments,
  height = 188,
}: {
  segments: SleepStageSegment[]
  height?: number
}) {
  const validSegments = segments
    .map((segment) => ({
      ...segment,
      start: new Date(segment.startTime).getTime(),
      end: new Date(segment.endTime).getTime(),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((left, right) => left.start - right.start)
  const { containerRef, width } = useResponsiveChartWidth(validSegments.length > 0)
  if (!validSegments.length) return <div className="chart-empty" style={{ height }}>Detailed timeline unavailable</div>

  const keys = ['wake', 'rem', 'light', 'deep'] as const
  const start = validSegments[0].start
  const end = validSegments.at(-1)?.end ?? validSegments[0].end
  const margin = { top: 10, right: 10, bottom: 28, left: 68 }
  const plotWidth = Math.max(1, width - margin.left - margin.right)
  const plotHeight = Math.max(1, height - margin.top - margin.bottom)
  const rowHeight = plotHeight / keys.length
  const xFor = (value: number) => margin.left + ((value - start) / Math.max(1, end - start)) * plotWidth
  const yFor = (type: SleepStageSegment['type']) => margin.top + (keys.indexOf(type) + 0.5) * rowHeight
  const middle = new Date(start + (end - start) / 2).toISOString()

  return (
    <div ref={containerRef} className="sleep-timeline-chart" style={{ height }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Sleep-stage timeline across ${validSegments.length} segments`}>
        <title>Detailed sleep-stage timeline</title>
        {keys.map((key) => (
          <g key={key}>
            <line x1={margin.left} y1={yFor(key)} x2={width - margin.right} y2={yFor(key)} className="sleep-timeline-gridline" />
            <text x={margin.left - 10} y={yFor(key) + 4} textAnchor="end" className="sleep-timeline-label">{sleepTimelineConfig[key].label}</text>
          </g>
        ))}
        {validSegments.slice(0, -1).map((segment, index) => {
          const next = validSegments[index + 1]
          if (!next || Math.abs(next.start - segment.end) > 120_000) return null
          return <line key={`connector-${index}`} x1={xFor(segment.end)} y1={yFor(segment.type)} x2={xFor(segment.end)} y2={yFor(next.type)} className="sleep-timeline-connector" />
        })}
        {validSegments.map((segment, index) => {
          const durationMinutes = Math.max(1, Math.round((segment.end - segment.start) / 60_000))
          return (
            <line
              key={`${segment.startTime}-${index}`}
              x1={xFor(segment.start)}
              y1={yFor(segment.type)}
              x2={Math.max(xFor(segment.start) + 2, xFor(segment.end))}
              y2={yFor(segment.type)}
              stroke={sleepTimelineConfig[segment.type].color}
              className="sleep-timeline-segment"
            >
              <title>{`${sleepTimelineConfig[segment.type].label}: ${formatTime(segment.startTime)}–${formatTime(segment.endTime)}, ${durationMinutes} min`}</title>
            </line>
          )
        })}
        <text x={margin.left} y={height - 5} textAnchor="start" className="sleep-timeline-time">{formatTime(validSegments[0].startTime)}</text>
        <text x={margin.left + plotWidth / 2} y={height - 5} textAnchor="middle" className="sleep-timeline-time">{formatTime(middle)}</text>
        <text x={width - margin.right} y={height - 5} textAnchor="end" className="sleep-timeline-time">{formatTime(validSegments.at(-1)?.endTime ?? null)}</text>
      </svg>
    </div>
  )
}

export function ChartKpi({ children }: { children: ReactNode }) {
  return <div className="chart-kpi">{children}</div>
}

export interface HeatmapCell {
  date: string
  hour?: number
  value: number | null
}

const HEATMAP_MIN_OPACITY = 0.12
const HEATMAP_MAX_OPACITY = 0.92
const heatmapWeekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function weekdayIndex(dateKey: string) {
  const date = new Date(`${dateKey.slice(0, 10)}T12:00:00`)
  return (date.getDay() + 6) % 7 // Monday = 0 .. Sunday = 6
}

function percentileOf(sortedValues: number[], p: number) {
  if (!sortedValues.length) return 0
  const index = (sortedValues.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sortedValues[lower]
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower)
}

function heatmapOpacity(value: number, low: number, high: number) {
  if (high <= low) return (HEATMAP_MIN_OPACITY + HEATMAP_MAX_OPACITY) / 2
  const ratio = Math.min(1, Math.max(0, (value - low) / (high - low)))
  return HEATMAP_MIN_OPACITY + ratio * (HEATMAP_MAX_OPACITY - HEATMAP_MIN_OPACITY)
}

interface HeatmapGridCell {
  key: string
  col: number
  row: number
  date: string
  hour?: number
  value: number | null
  label: string
}

export function Heatmap({
  cells,
  layout,
  color = 'var(--color-indigo)',
  height,
  ariaLabel = layout === 'dayHour' ? 'Values by day and hour' : 'Daily values by week',
  formatter = (value) => formatNumber(value),
}: {
  cells: HeatmapCell[]
  layout: 'dayHour' | 'calendar'
  color?: string
  height?: number
  ariaLabel?: string
  formatter?: (value: number) => string
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const { containerRef, width } = useResponsiveChartWidth(cells.length > 0)
  const resolvedHeight = height ?? (layout === 'dayHour' ? 260 : 172)
  if (!cells.length) return <div className="chart-empty" style={{ height: resolvedHeight }}>No data for this range</div>

  const nonNullValues = cells
    .filter((cell): cell is HeatmapCell & { value: number } => cell.value !== null && Number.isFinite(cell.value))
    .map((cell) => cell.value)
    .sort((a, b) => a - b)
  const scaleLow = percentileOf(nonNullValues, 0.05)
  const scaleHigh = percentileOf(nonNullValues, 0.95)

  let cols: string[]
  let rows: string[]
  const grid: HeatmapGridCell[] = []

  if (layout === 'dayHour') {
    cols = Array.from({ length: 24 }, (_, hour) => String(hour))
    rows = Array.from(new Set(cells.map((cell) => cell.date))).sort()
    const lookup = new Map(cells.map((cell) => [`${cell.date}|${cell.hour ?? 0}`, cell.value]))
    rows.forEach((date, rowIndex) => {
      for (let hour = 0; hour < 24; hour += 1) {
        const value = lookup.get(`${date}|${hour}`) ?? null
        grid.push({
          key: `${date}-${hour}`,
          col: hour,
          row: rowIndex,
          date,
          hour,
          value,
          label: value === null
            ? `${formatDate(date, { month: 'short', day: 'numeric' })}, ${hour}:00: no data`
            : `${formatDate(date, { month: 'short', day: 'numeric' })}, ${hour}:00: ${formatter(value)}`,
        })
      }
    })
  } else {
    const weekOf = new Map(cells.map((cell) => [cell.date, isoWeekKey(new Date(`${cell.date.slice(0, 10)}T12:00:00`).getTime())]))
    cols = Array.from(new Set(cells.map((cell) => weekOf.get(cell.date) as string))).sort()
    rows = heatmapWeekdayLabels
    const lookup = new Map(cells.map((cell) => [`${weekOf.get(cell.date)}|${weekdayIndex(cell.date)}`, cell]))
    cols.forEach((weekKey, colIndex) => {
      for (let day = 0; day < 7; day += 1) {
        const cell = lookup.get(`${weekKey}|${day}`)
        const value = cell?.value ?? null
        grid.push({
          key: `${weekKey}-${day}`,
          col: colIndex,
          row: day,
          date: cell?.date ?? weekKey,
          value,
          label: !cell
            ? `Week of ${weekKey}, ${heatmapWeekdayLabels[day]}: no data`
            : value === null
              ? `${formatDate(cell.date, { month: 'short', day: 'numeric' })} (${heatmapWeekdayLabels[day]}): no data`
              : `${formatDate(cell.date, { month: 'short', day: 'numeric' })} (${heatmapWeekdayLabels[day]}): ${formatter(value)}`,
        })
      }
    })
  }

  const margin = layout === 'dayHour'
    ? { top: 18, right: 8, bottom: 8, left: 54 }
    : { top: 18, right: 8, bottom: 8, left: 34 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = resolvedHeight - margin.top - margin.bottom
  const cellWidth = plotWidth / cols.length
  const cellHeight = plotHeight / rows.length
  const gap = Math.min(2, cellWidth * 0.12, cellHeight * 0.12)
  const xFor = (col: number) => margin.left + col * cellWidth
  const yFor = (row: number) => margin.top + row * cellHeight
  const colLabelEvery = layout === 'dayHour' ? 3 : Math.max(1, Math.ceil(cols.length / 8))
  // A month of rows would otherwise stack date labels on top of each other.
  const rowLabelEvery = layout === 'dayHour' ? Math.max(1, Math.ceil(rows.length / 10)) : 1
  const activeCell = grid.find((cell) => cell.key === activeKey) ?? null

  // The legend flows under the grid, so the height belongs to the svg rather
  // than to the container, which would otherwise clip it.
  return (
    <div ref={containerRef} className={`heatmap-chart heatmap-${layout}`}>
      <svg viewBox={`0 0 ${width} ${resolvedHeight}`} height={resolvedHeight} role="img" aria-label={ariaLabel} onPointerLeave={() => setActiveKey(null)}>
        <title>{ariaLabel}</title>
        <desc>{`${nonNullValues.length} of ${cells.length} cells have data; personal scale ${formatter(scaleLow)} to ${formatter(scaleHigh)}.`}</desc>
        {layout === 'dayHour' && cols.map((_, col) => (
          col % colLabelEvery === 0 && (
            <text key={`col-${col}`} x={xFor(col) + cellWidth / 2} y={margin.top - 6} textAnchor="middle" className="chart-tick heatmap-axis-label">{col}h</text>
          )
        ))}
        {layout === 'calendar' && cols.map((weekKey, col) => (
          col % colLabelEvery === 0 && (
            <text key={`col-${weekKey}`} x={xFor(col) + cellWidth / 2} y={margin.top - 6} textAnchor="middle" className="chart-tick heatmap-axis-label">{weekKey.slice(5)}</text>
          )
        ))}
        {rows.map((rowLabel, row) => (
          (row % rowLabelEvery === 0 || row === rows.length - 1) && (
            <text key={`row-${rowLabel}-${row}`} x={margin.left - 8} y={yFor(row) + cellHeight / 2 + 4} textAnchor="end" className="chart-tick heatmap-axis-label">
              {layout === 'dayHour' ? formatDate(rowLabel, { month: 'short', day: 'numeric' }) : rowLabel}
            </text>
          )
        ))}
        {grid.map((cell) => {
          const hasValue = cell.value !== null && Number.isFinite(cell.value)
          return (
            <rect
              key={cell.key}
              x={xFor(cell.col) + gap / 2}
              y={yFor(cell.row) + gap / 2}
              width={Math.max(1, cellWidth - gap)}
              height={Math.max(1, cellHeight - gap)}
              rx={2}
              className="heatmap-cell"
              fill={hasValue ? color : 'none'}
              opacity={hasValue ? heatmapOpacity(cell.value as number, scaleLow, scaleHigh) : 1}
              tabIndex={0}
              aria-label={cell.label}
              onPointerEnter={() => setActiveKey(cell.key)}
              onFocus={() => setActiveKey(cell.key)}
              onBlur={() => setActiveKey(null)}
            >
              <title>{cell.label}</title>
            </rect>
          )
        })}
      </svg>
      {activeCell && (
        <div
          className="chart-tooltip"
          style={{
            left: `clamp(52px, ${(xFor(activeCell.col) + cellWidth / 2) / width * 100}%, calc(100% - 52px))`,
            top: `${(yFor(activeCell.row) + cellHeight / 2) / resolvedHeight * 100}%`,
          }}
          role="status"
        >
          <span>{layout === 'dayHour' ? `${formatDate(activeCell.date, { month: 'short', day: 'numeric' })}, ${activeCell.hour}:00` : formatDate(activeCell.date, { month: 'short', day: 'numeric', weekday: 'short' })}</span>
          <strong>{activeCell.value === null ? 'No data' : formatter(activeCell.value)}</strong>
        </div>
      )}
      <div className="heatmap-legend" aria-hidden="true">
        <span>{formatter(scaleLow)}</span>
        <i className="heatmap-legend-swatch" style={{ background: color, opacity: HEATMAP_MIN_OPACITY }} />
        <i className="heatmap-legend-swatch" style={{ background: color, opacity: (HEATMAP_MIN_OPACITY + HEATMAP_MAX_OPACITY) / 2 }} />
        <i className="heatmap-legend-swatch" style={{ background: color, opacity: HEATMAP_MAX_OPACITY }} />
        <span>{formatter(scaleHigh)}</span>
      </div>
      <AccessibleChartTable
        title={ariaLabel}
        labels={grid.map((cell) => cell.label.split(':')[0])}
        values={grid.map((cell) => cell.value)}
        formatter={formatter}
      />
    </div>
  )
}
