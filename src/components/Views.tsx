import { useEffect, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { ActivityItem, BackfillProgress, DashboardData, FitbitAuthStatus, PageId, TimePoint } from '@/types'
import { BulletChart, ColumnChart, Heatmap, LineChart, RadialProgress, SleepStageBar, SleepStageTimeline, StackedColumnChart } from './Charts'
import { DuoIcon, EmptyValue, MetricTile, Panel, PanelHeader, RangeSelector } from './Shared'
import type { History, RangeDays } from '@/data/history'
import type { AppIcon } from './icons'
import {
  ActiveIcon,
  ActivityIcon,
  BatteryIcon,
  BodyIcon,
  BreathingIcon,
  CaloriesIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  DeviceIcon,
  DistanceIcon,
  DurationIcon,
  FloorsIcon,
  GaugeIcon,
  HeartIcon,
  InfoIcon,
  NutritionIcon,
  ShieldIcon,
  SignalIcon,
  SleepIcon,
  SparkleIcon,
  StepsIcon,
  TrendIcon,
  WaterIcon,
} from './icons'
import {
  compactMinutes,
  formatDate,
  formatDecimal,
  formatMinutes,
  formatNumber,
  formatTime,
  relativeTime,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import { availableMetricCount, hasActivityData, hasBodyData, hasHealthData, hasSleepData } from '@/lib/data-availability'
import { analyzeHome } from '@/lib/home-analysis'
import type { BaselineComparison } from '@/lib/home-analysis'
import { MINIMUM_BASELINE_DAYS, SETTLED_BASELINE_DAYS, scoreSeries } from '@/lib/scores'
import type { ScoreContribution, ScoreKey, ScoreResult, ScoreStatus, Scores } from '@/lib/scores'

interface ViewProps {
  data: DashboardData
  status: FitbitAuthStatus
  navigate: (page: PageId) => void
  /** Full local archive series, for views that need per-day intraday detail. */
  history: History
  rangeDays: RangeDays
  onRangeChange: (days: RangeDays) => void
  /** Days of history the archive can cover, used to gate the range options. */
  historyDays: number
  /** OpenFit's own local recovery/load/sleep-quality derivations. */
  scores: Scores
}

interface Signal {
  label: string
  value: string
  unit?: string
  note: string
  icon: AppIcon
}

interface SupportingMetric {
  label: string
  value: string
  unit?: string
  icon: AppIcon
}

function hasValue(value: number | null | undefined): value is number {
  return value !== null && Number.isFinite(value)
}

function SectionTitle({ title, copy, action }: { title: string; copy?: string; action?: ReactNode }) {
  return (
    <div className="section-title">
      <div><h2>{title}</h2>{copy && <p>{copy}</p>}</div>
      {action}
    </div>
  )
}

function TinyStat({ label, value, unit = '' }: { label: string; value: string | number; unit?: string }) {
  return <div className="tiny-stat"><span>{label}</span><strong>{value}{unit}</strong></div>
}

function SignalRow({ signal }: { signal: Signal }) {
  const Icon = signal.icon
  return (
    <div className="signal-row">
      <DuoIcon icon={Icon} className="signal-icon" />
      <div className="signal-copy"><strong>{signal.label}</strong><span>{signal.note}</span></div>
      <div className="signal-value"><strong>{signal.value}</strong>{signal.unit && <span>{signal.unit}</span>}</div>
    </div>
  )
}

function SupportingMetrics({ items }: { items: SupportingMetric[] }) {
  if (!items.length) return null
  return (
    <Panel className="supporting-metrics" category="activity">
      {items.map(({ label, value, unit, icon: Icon }, index) => (
        <div className="supporting-metric" key={label}>
          {index > 0 && <Separator orientation="vertical" />}
          <DuoIcon icon={Icon} className="supporting-icon" />
          <div><span>{label}</span><strong>{value}{unit && <small>{unit}</small>}</strong></div>
        </div>
      ))}
    </Panel>
  )
}

function presentSignals(signals: Array<Signal | null>): Signal[] {
  return signals.filter((signal): signal is Signal => signal !== null)
}

function overnightSignals(data: DashboardData): Signal[] {
  const hrvDetails = [
    hasValue(data.health.hrvDeepSleepRmssdMs) ? `deep ${formatDecimal(data.health.hrvDeepSleepRmssdMs)} ms` : null,
    hasValue(data.health.nonRemHeartRate) ? `non-REM ${formatNumber(data.health.nonRemHeartRate)} bpm` : null,
    hasValue(data.health.hrvEntropy) ? `entropy ${formatDecimal(data.health.hrvEntropy, 2)}` : null,
  ].filter(Boolean).join(' · ')
  const spo2Details = hasValue(data.health.spo2Min) && hasValue(data.health.spo2Max)
    ? `Range ${formatDecimal(data.health.spo2Min)}–${formatDecimal(data.health.spo2Max)}%`
    : 'Average saturation'
  const temperatureDetails = [
    hasValue(data.health.skinNightlyTemperatureCelsius) ? `night ${formatDecimal(data.health.skinNightlyTemperatureCelsius)}°` : null,
    hasValue(data.health.skinBaselineTemperatureCelsius) ? `baseline ${formatDecimal(data.health.skinBaselineTemperatureCelsius)}°` : null,
    hasValue(data.health.skinTemperatureStddev30dCelsius) ? `30d σ ${formatDecimal(data.health.skinTemperatureStddev30dCelsius, 2)}°` : null,
  ].filter(Boolean).join(' · ')
  return presentSignals([
    hasValue(data.health.hrvMs) ? { label: 'HRV', value: formatDecimal(data.health.hrvMs), unit: 'ms', note: hrvDetails || 'Average heart rate variability', icon: SignalIcon } : null,
    hasValue(data.health.spo2) ? { label: 'Oxygen', value: formatDecimal(data.health.spo2), unit: '%', note: spo2Details, icon: CloudIcon } : null,
    hasValue(data.health.breathingRate) ? { label: 'Breathing', value: formatDecimal(data.health.breathingRate), unit: 'rpm', note: 'Nightly rate', icon: BreathingIcon } : null,
    hasValue(data.health.skinTemperature) ? {
      label: 'Temperature',
      value: `${data.health.skinTemperature > 0 ? '+' : ''}${formatDecimal(data.health.skinTemperature)}`,
      unit: '°C',
      note: temperatureDetails || 'Skin temperature variation',
      icon: GaugeIcon,
    } : null,
    hasValue(data.health.coreTemperature) ? { label: 'Body temperature', value: formatDecimal(data.health.coreTemperature), unit: '°C', note: 'Latest reading', icon: GaugeIcon } : null,
  ])
}

function formatPace(secondsPerMeter: number | null | undefined) {
  if (!hasValue(secondsPerMeter) || secondsPerMeter <= 0) return null
  const secondsPerKm = Math.round(secondsPerMeter * 1000)
  return `${Math.floor(secondsPerKm / 60)}:${String(secondsPerKm % 60).padStart(2, '0')} min/km`
}

function CompactActivity({ item, detailed = false }: { item: ActivityItem; detailed?: boolean }) {
  const pace = formatPace(item.averagePaceSecondsPerMeter)
  const sourceSummary = item.sources.length > 2
    ? `${item.sources.slice(0, 2).join(' + ')} +${item.sources.length - 2}`
    : item.sources.join(' + ')
  const zoneDetails = [
    hasValue(item.heartZoneMinutes?.light) && item.heartZoneMinutes.light > 0 ? `Light ${formatNumber(item.heartZoneMinutes.light)} min` : null,
    hasValue(item.heartZoneMinutes?.moderate) && item.heartZoneMinutes.moderate > 0 ? `Moderate ${formatNumber(item.heartZoneMinutes.moderate)} min` : null,
    hasValue(item.heartZoneMinutes?.vigorous) && item.heartZoneMinutes.vigorous > 0 ? `Vigorous ${formatNumber(item.heartZoneMinutes.vigorous)} min` : null,
    hasValue(item.heartZoneMinutes?.peak) && item.heartZoneMinutes.peak > 0 ? `Peak ${formatNumber(item.heartZoneMinutes.peak)} min` : null,
  ].filter((value): value is string => Boolean(value))
  return (
    <div className={`activity-row ${detailed ? 'is-detailed' : ''}`}>
      <DuoIcon icon={ActivityIcon} className="activity-icon" />
      <div className="activity-copy">
        <strong>{item.name}</strong>
        <span>
          {formatDate(item.date, { day: 'numeric', month: 'short' })}
          {item.time ? ` · ${item.time}` : ''}
          {sourceSummary ? <small className="activity-source"> · {sourceSummary}</small> : null}
        </span>
      </div>
      <div className="activity-meta">
        {item.durationMinutes > 0 && <span>{item.durationMinutes} min</span>}
        {hasValue(item.distanceKm) && <span>{formatDecimal(item.distanceKm)} km</span>}
        {hasValue(item.averageHeartRate) && <span>{formatNumber(item.averageHeartRate)} bpm</span>}
        {detailed && hasValue(item.calories) && <span>{formatNumber(item.calories)} kcal</span>}
      </div>
      {detailed && (hasValue(item.steps) || pace || zoneDetails.length > 0) && (
        <div className="activity-detail-row">
          {hasValue(item.steps) && <span><strong>{formatNumber(item.steps)}</strong> steps</span>}
          {pace && <span><strong>{pace}</strong> average pace</span>}
          {zoneDetails.map((detail) => <span key={detail}>{detail}</span>)}
        </div>
      )}
    </div>
  )
}

function trendLabels(data: DashboardData) {
  return data.trends.map((point) => formatDate(point.date, { day: 'numeric', month: 'short' }))
}

function trendXValues(data: DashboardData) {
  return data.trends.map((point, index) => {
    const value = new Date(`${point.date}T12:00:00`).getTime()
    return Number.isFinite(value) ? value : index
  })
}

function timeXValues(labels: string[]) {
  return labels.map((label, index) => {
    const match = label.match(/(\d{1,2}):(\d{2})/)
    return match ? Number(match[1]) * 60 + Number(match[2]) : index
  })
}

function hourlyBuckets(points: TimePoint[]) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0, seen: false }))
  points.forEach((point) => {
    const match = point.time.match(/(\d{1,2}):(\d{2})/)
    if (!match) return
    const hour = Number(match[1])
    if (hour < 0 || hour > 23) return
    buckets[hour].value += point.value
    buckets[hour].seen = true
  })
  return {
    values: buckets.map((bucket) => bucket.seen ? bucket.value : null),
    labels: buckets.map((bucket) => `${String(bucket.hour).padStart(2, '0')}:00`),
    xValues: buckets.map((bucket) => bucket.hour),
  }
}

type HomeCategory = 'activity' | 'heart' | 'sleep' | 'recovery' | 'body'

const trendColors: Record<HomeCategory, string> = {
  activity: 'var(--category-activity)',
  heart: 'var(--category-heart)',
  sleep: 'var(--category-sleep)',
  recovery: 'var(--category-recovery)',
  body: 'var(--category-body)',
}

function MetricTrendPanel({
  data,
  category,
  icon,
  title,
  values,
  formatter,
  target = null,
}: {
  data: DashboardData
  category: HomeCategory
  icon: AppIcon
  title: string
  values: Array<number | null>
  formatter: (value: number) => string
  target?: number | null
}) {
  const count = values.filter(hasValue).length
  if (count < 2) return null
  const latest = [...values].reverse().find(hasValue) ?? null
  return (
    <Panel className="metric-trend-card" category={category}>
      <PanelHeader
        eyebrow={`${count} days with data`}
        title={title}
        icon={icon}
        action={latest === null ? null : <Badge variant="secondary">{formatter(latest)}</Badge>}
      />
      <LineChart
        values={values}
        labels={trendLabels(data)}
        xValues={trendXValues(data)}
        target={target}
        color={trendColors[category]}
        height={156}
        compact
        showRangeLabels
        variant="area"
        formatter={formatter}
        ariaLabel={`${title} during the synced period`}
      />
    </Panel>
  )
}

function signedNumber(value: number, digits = 0) {
  const formatted = formatNumber(Math.abs(value), { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatted}`
}

function baselineNote(comparison: BaselineComparison, unit: string, digits = 0) {
  if (comparison.difference === null || comparison.sampleCount < 3) return 'Building baseline'
  return `${signedNumber(comparison.difference, digits)} ${unit} · ${comparison.sampleCount} days`
}

function DetailAction({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="panel-detail-action" onClick={onClick} aria-label={label}><ChevronRightIcon aria-hidden="true" /></button>
}

function HomeSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const titleId = `home-section-${id}`
  return (
    <section className="home-section" aria-labelledby={titleId}>
      <div className="home-section-title"><h2 id={titleId}>{title}</h2></div>
      {children}
    </section>
  )
}

function DailySummaryMetric({
  category,
  icon: Icon,
  label,
  value,
  note,
  onClick,
}: {
  category: HomeCategory
  icon: AppIcon
  label: string
  value: string
  note: string
  onClick: () => void
}) {
  return (
    <Panel className="daily-summary-metric" category={category} onClick={onClick} ariaLabel={`${label}: ${value}, ${note}`}>
      <DuoIcon icon={Icon} className="daily-summary-icon" />
      <span className="daily-summary-copy"><small>{label}</small><strong>{value}</strong><span>{note}</span></span>
    </Panel>
  )
}

function TrendStats({
  current,
  average,
  difference,
  sampleCount,
}: {
  current: string
  average: string
  difference: string
  sampleCount: number
}) {
  return (
    <div className="mini-trend-stats">
      <div><span>Today</span><strong>{current}</strong></div>
      <div><span>{sampleCount ? `${sampleCount}-day average` : 'Recent average'}</span><strong>{average}</strong></div>
      <div><span>vs average</span><strong>{difference}</strong></div>
    </div>
  )
}

function VitalSnapshot({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="vital-snapshot">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const SCORE_META: Record<ScoreKey, { title: string; category: HomeCategory; icon: AppIcon }> = {
  recovery: { title: 'Recovery', category: 'recovery', icon: GaugeIcon },
  load: { title: 'Load', category: 'activity', icon: ActivityIcon },
  sleepQuality: { title: 'Sleep quality', category: 'sleep', icon: SleepIcon },
}

const SCORE_ORDER: ScoreKey[] = ['recovery', 'load', 'sleepQuality']

function scoreStatusCopy(status: ScoreStatus) {
  if (status === 'low') return 'Low'
  if (status === 'high') return 'High'
  return 'Typical'
}

function scoreMeaning(key: ScoreKey, status: ScoreStatus) {
  if (key === 'recovery') {
    if (status === 'low') return 'Your body signals suggest an easier day.'
    if (status === 'high') return 'Your body signals look favorable for activity.'
    return 'Your recovery signals are close to your normal range.'
  }
  if (key === 'load') {
    if (status === 'low') return 'A light cardiovascular load compared with your recent hard days.'
    if (status === 'high') return 'A high cardiovascular load compared with your recent hard days.'
    return 'A moderate cardiovascular load for you.'
  }
  if (status === 'low') return 'Your sleep was less restorative than your usual night.'
  if (status === 'high') return 'Your sleep was more restorative than your usual night.'
  return 'Your sleep was close to your usual quality.'
}

function deviationCopy(z: number | null) {
  if (z === null) return 'Based on today’s value'
  if (z <= -1) return 'Well below your usual'
  if (z < -0.35) return 'Below your usual'
  if (z < 0.35) return 'Near your usual'
  if (z < 1) return 'Above your usual'
  return 'Well above your usual'
}

function ScoreContributionRow({ contribution, color }: { contribution: ScoreContribution; color: string }) {
  const maximumPoints = Math.round(contribution.weight * 100)
  const ceiling = Math.max(maximumPoints, Math.abs(contribution.points), 1)
  const fillPercent = Math.min(100, Math.max(0, (contribution.points / ceiling) * 100))
  return (
    <div className="score-contribution">
      <div className="score-contribution-row">
        <span className="score-contribution-label"><strong>{contribution.label}</strong><small>{deviationCopy(contribution.z)}</small></span>
        <span className="score-contribution-points">{contribution.points} of {maximumPoints}</span>
      </div>
      <div className="score-contribution-track">
        <span className="score-contribution-fill" style={{ width: `${fillPercent}%`, background: color }} />
      </div>
    </div>
  )
}

function ScoreCard({ result, expanded, onToggle }: { result: ScoreResult; expanded: boolean; onToggle: () => void }) {
  const meta = SCORE_META[result.key]
  const color = trendColors[meta.category]
  const contentId = `score-expansion-${result.key}`
  return (
    <Panel className={cn('score-card', expanded && 'is-expanded')} category={meta.category}>
      <button type="button" className="score-card-trigger" aria-expanded={expanded} aria-controls={contentId} onClick={onToggle}>
        <PanelHeader
          title={meta.title}
          icon={meta.icon}
          action={<ChevronDownIcon className={cn('score-card-chevron', expanded && 'is-flipped')} aria-hidden="true" />}
        />
        {result.confidence === 'insufficient' ? (
          <div className="score-card-building">
            <strong>Building baseline</strong>
            <span>{result.baselineDays}/{SETTLED_BASELINE_DAYS} days</span>
          </div>
        ) : (
          <div className="score-card-lead">
            <RadialProgress value={result.value} color={color} label="of 100" valueLabel={String(result.value)} size={84} />
            <div className="score-card-status">
              <span className={cn('score-status-badge', `is-${result.status}`)}>{scoreStatusCopy(result.status)}</span>
              <strong>{scoreMeaning(result.key, result.status)}</strong>
              {result.confidence === 'building' && (
                <span className="score-card-provisional">Still learning your normal · {result.baselineDays} of {SETTLED_BASELINE_DAYS} baseline days</span>
              )}
            </div>
          </div>
        )}
      </button>
      {expanded && (
        <div id={contentId} className="score-card-expansion">
          <div className="score-explanation">
            <strong>What shaped this score</strong>
            <p>Each row shows how many points today’s reading added. “9 of 35” means this factor could contribute up to 35 points.</p>
          </div>
          {result.contributions.map((contribution) => (
            <ScoreContributionRow key={contribution.key} contribution={contribution} color={color} />
          ))}
          {result.missing.length > 0 && (
            <p className="score-missing-note">
              Not counted — {result.missing.join(', ')}: not reported by your device today, so their weight moved to the remaining factors.
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}

function ScoresSection({ scores }: { scores: Scores }) {
  const [expandedKey, setExpandedKey] = useState<ScoreKey | null>(null)
  const allInsufficient = SCORE_ORDER.every((key) => scores[key].confidence === 'insufficient')
  const maxBaselineDays = Math.max(...SCORE_ORDER.map((key) => scores[key].baselineDays))

  return (
    <HomeSection id="scores" title="Today's scores">
      <p className="score-section-note">
        A personal 0–100 summary calculated by OpenFit from your recent measurements. It is not a medical rating or a Google/Fitbit score. Open a card to see what influenced it.
      </p>
      {allInsufficient ? (
        <Panel className="score-building-note" category="recovery">
          <p>
            Still building your personal baseline. Recovery, load, and sleep quality need at least {MINIMUM_BASELINE_DAYS} days of history
            — {maxBaselineDays}/{MINIMUM_BASELINE_DAYS} so far.
          </p>
        </Panel>
      ) : (
        <div className="score-card-grid">
          {SCORE_ORDER.map((key) => (
            <ScoreCard
              key={key}
              result={scores[key]}
              expanded={expandedKey === key}
              onToggle={() => setExpandedKey((current) => current === key ? null : key)}
            />
          ))}
        </div>
      )}
    </HomeSection>
  )
}

export function TodayView({ data, navigate, scores }: ViewProps) {
  const analysis = analyzeHome(data)
  const stepsByHour = hourlyBuckets(data.activity.stepsIntraday)
  const steps = hasValue(data.activity.steps) ? data.activity.steps : null
  const hasSteps = steps !== null
  const hasHeart = hasValue(data.health.restingHeartRate) || data.health.heartRateIntraday.length > 0
  const hasSleep = hasSleepData(data)
  const stepsTrend = data.trends.map((point) => point.steps)
  const sleepTrend = data.trends.map((point) => point.sleepMinutes)
  const restingHeartTrend = data.trends.map((point) => point.restingHeartRate)
  const stepsTrendCount = stepsTrend.filter(hasValue).length
  const sleepTrendCount = sleepTrend.filter(hasValue).length
  const restingHeartTrendCount = restingHeartTrend.filter(hasValue).length
  const labels = trendLabels(data)
  const xValues = trendXValues(data)
  const sleepGoalNote = data.sleep.totalMinutes === null ? 'Duration unavailable' : analysis.sleepGoalDifference === null
    ? baselineNote(analysis.sleep, 'min')
    : `${formatMinutes(analysis.sleepGoalDifference)} · goal`
  const stepsSourceLabel = data.activity.stepsSource === 'google-fit'
    ? 'Google Fit'
    : data.activity.stepsSource === 'google-fit+health'
      ? 'Google Fit + Health'
    : data.activity.stepsSource === 'google-health'
      ? 'Google Health'
      : data.activity.stepsSource === 'fitbit'
        ? 'Fitbit'
        : null
  const activityProgressNote = analysis.stepsGoalProgress === null
    ? baselineNote(analysis.steps, 'steps')
    : `${Math.round(analysis.stepsGoalProgress * 100)}% of goal`
  const activityNote = stepsSourceLabel ? `${activityProgressNote} · ${stepsSourceLabel}` : activityProgressNote
  const sleepPrimaryValue = hasValue(data.sleep.totalMinutes)
    ? compactMinutes(data.sleep.totalMinutes)
    : hasValue(data.sleep.score)
      ? `Score ${formatNumber(data.sleep.score)}`
      : data.sleep.stages.some((stage) => stage.minutes > 0) ? 'Stages recorded' : 'Partial data'
  const sleepNote = sleepGoalNote
  const heartNote = baselineNote(analysis.restingHeartRate, 'bpm')
  const vitalSnapshots = [
    hasValue(data.health.hrvMs) ? {
      id: 'hrv', label: 'HRV', value: `${formatNumber(data.health.hrvMs)} ms`,
    } : null,
    hasValue(data.health.spo2) ? {
      id: 'spo2', label: 'SpO₂', value: `${formatDecimal(data.health.spo2)}%`,
    } : null,
    hasValue(data.health.breathingRate) ? {
      id: 'breathing', label: 'Breathing', value: `${formatDecimal(data.health.breathingRate)} rpm`,
    } : null,
    hasValue(data.health.skinTemperature) ? {
      id: 'temperature', label: 'Temperature', value: `${data.health.skinTemperature > 0 ? '+' : ''}${formatDecimal(data.health.skinTemperature)} °C`,
    } : null,
    hasValue(data.health.coreTemperature) ? {
      id: 'core-temperature', label: 'Body temperature', value: `${formatDecimal(data.health.coreTemperature)} °C`,
    } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null)
  const bodySnapshots = [
    hasValue(data.body.weightKg) ? { label: 'Weight', value: `${formatDecimal(data.body.weightKg)} kg`, note: data.body.weightGoalKg === null ? 'Latest measurement' : `${data.body.weightKg >= data.body.weightGoalKg ? '+' : '−'}${formatDecimal(Math.abs(data.body.weightKg - data.body.weightGoalKg))} kg · goal` } : null,
    hasValue(data.body.bodyFat) ? { label: 'Body fat', value: `${formatDecimal(data.body.bodyFat)}%`, note: 'Estimate' } : null,
    hasValue(data.body.waterMl) ? { label: 'Water', value: `${formatNumber(data.body.waterMl)} ml`, note: data.body.waterGoalMl === null || data.body.waterGoalMl <= 0 ? 'Log' : `${Math.round(data.body.waterMl / data.body.waterGoalMl * 100)}% of goal` } : null,
    hasValue(data.body.caloriesIn) ? { label: 'Calories', value: `${formatNumber(data.body.caloriesIn)} kcal`, note: 'Log' } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null)

  return (
    <div className="page-stack today-page">
      <div className="home-dashboard scores-standalone">
        <ScoresSection scores={scores} />
      </div>

      {!hasSteps && !hasHeart && !hasSleep && !hasHealthData(data) && !hasBodyData(data) && data.activities.length === 0 && (
        <Panel className="first-sync-state">
          <CloudIcon aria-hidden="true" />
          <h2>No measurements for this day</h2>
          <p>The connection is working. Try another date or refresh your data.</p>
        </Panel>
      )}

      {(hasSteps || hasHeart || hasSleep || vitalSnapshots.length > 0 || bodySnapshots.length > 0 || data.activities.length > 0) && (
        <div className="home-dashboard">
          <HomeSection id="overview" title="Overview">
            <div className="daily-summary-grid">
              <DailySummaryMetric category="activity" icon={StepsIcon} label="Movement" value={hasSteps ? formatNumber(steps) : '—'} note={hasSteps ? activityNote : 'Unavailable'} onClick={() => navigate('activity')} />
              <DailySummaryMetric category="sleep" icon={SleepIcon} label="Sleep" value={hasSleep ? sleepPrimaryValue : '—'} note={hasSleep ? sleepNote : 'Unavailable'} onClick={() => navigate('sleep')} />
              <DailySummaryMetric category="heart" icon={HeartIcon} label="Resting heart rate" value={hasValue(data.health.restingHeartRate) ? `${formatNumber(data.health.restingHeartRate)} bpm` : '—'} note={hasValue(data.health.restingHeartRate) ? heartNote : 'Unavailable'} onClick={() => navigate('health')} />
            </div>
          </HomeSection>

          <HomeSection id="activity-recovery" title="Activity and recovery">
            <div className="home-core-grid">
            {hasSteps && (
              <Panel className="home-movement-card" category="activity" onClick={() => navigate('activity')} ariaLabel="Open Activity">
                <PanelHeader title="Movement" icon={StepsIcon} action={<ChevronRightIcon aria-hidden="true" />} />
                <div className="home-card-lead">
                  <div><strong>{formatNumber(steps)}</strong><span>steps</span></div>
                  {data.activity.stepsGoal !== null && data.activity.stepsGoal > 0 && <RadialProgress value={steps} max={data.activity.stepsGoal} color="var(--category-activity)" label="goal" valueLabel={`${Math.round(steps / data.activity.stepsGoal * 100)}%`} size={78} />}
                </div>
                {data.activity.stepsIntraday.length > 0 && (
                  <div className="home-primary-chart">
                    <div className="home-chart-label"><span>Steps per hour</span></div>
                    <ColumnChart values={stepsByHour.values} labels={stepsByHour.labels} xValues={stepsByHour.xValues} color="var(--category-activity)" height={156} compact showRangeLabels formatter={(value) => `${formatNumber(value)} steps`} ariaLabel="Steps per hour on the selected day" />
                  </div>
                )}
                <div className="home-fact-row">
                  {hasValue(data.activity.activeMinutes) && <TinyStat label="Active minutes" value={formatNumber(data.activity.activeMinutes)} unit=" min" />}
                  {hasValue(data.activity.zoneMinutes) && <TinyStat label="Zone minutes" value={formatNumber(data.activity.zoneMinutes)} unit=" min" />}
                  {hasValue(data.activity.distanceKm) && <TinyStat label="Distance" value={formatDecimal(data.activity.distanceKm)} unit=" km" />}
                  {hasValue(data.activity.sedentaryMinutes) && <TinyStat label="Sedentary time" value={formatMinutes(data.activity.sedentaryMinutes)} />}
                </div>
              </Panel>
            )}

            {(hasSleep || vitalSnapshots.length > 0) && (
              <div className="home-side-stack">
                {hasSleep && (
                  <Panel className="home-sleep-overview" category="sleep" onClick={() => navigate('sleep')} ariaLabel="Open Sleep">
                    <PanelHeader title="Sleep" icon={SleepIcon} action={<ChevronRightIcon aria-hidden="true" />} />
                    <div className="sleep-overview-lead">
                      <div className="sleep-overview-duration"><strong>{sleepPrimaryValue}</strong>{(data.sleep.startTime || data.sleep.endTime) && <span>{formatTime(data.sleep.startTime)} – {formatTime(data.sleep.endTime)}</span>}<small>{sleepGoalNote}</small></div>
                      {hasValue(data.sleep.efficiency) && <RadialProgress value={data.sleep.efficiency} color="var(--category-sleep)" label="efficiency" valueLabel={formatNumber(data.sleep.efficiency)} size={68} />}
                    </div>
                    {data.sleep.stages.some((stage) => stage.minutes > 0) && <SleepStageBar stages={data.sleep.stages} compact showLegend={false} />}
                  </Panel>
                )}

                {vitalSnapshots.length > 0 && (
                  <Panel className="home-vitals-card" category="recovery" onClick={() => navigate('health')} ariaLabel="Open Health">
                    <PanelHeader title="Nightly signals" icon={SignalIcon} action={<ChevronRightIcon aria-hidden="true" />} />
                    <div className="vital-snapshot-grid">{vitalSnapshots.map((item) => <VitalSnapshot key={item.id} {...item} />)}</div>
                  </Panel>
                )}
              </div>
            )}
            </div>
          </HomeSection>

          {(stepsTrendCount > 1 || sleepTrendCount > 1 || restingHeartTrendCount > 1) && (
            <HomeSection id="trends" title="Personal trends">
              <div className="home-trend-grid">
                {stepsTrendCount > 1 && (
                  <Panel className="home-mini-trend" category="activity">
                    <div className="mini-trend-heading"><DuoIcon icon={StepsIcon} className="mini-trend-icon" /><strong>Steps</strong></div>
                    <TrendStats
                      current={formatNumber(analysis.steps.current)}
                      average={formatNumber(analysis.steps.baseline)}
                      difference={analysis.steps.difference === null ? '—' : signedNumber(analysis.steps.difference)}
                      sampleCount={analysis.steps.sampleCount}
                    />
                    <ColumnChart values={stepsTrend} labels={labels} xValues={xValues} target={data.activity.stepsGoal} color="var(--category-activity)" height={108} compact showRangeLabels formatter={(value) => `${formatNumber(value)} steps`} ariaLabel="Daily steps over the last 14 days" />
                  </Panel>
                )}
                {sleepTrendCount > 1 && (
                  <Panel className="home-mini-trend" category="sleep">
                    <div className="mini-trend-heading"><DuoIcon icon={SleepIcon} className="mini-trend-icon" /><strong>Sleep</strong></div>
                    <TrendStats
                      current={compactMinutes(analysis.sleep.current)}
                      average={compactMinutes(analysis.sleep.baseline)}
                      difference={formatMinutes(analysis.sleep.difference)}
                      sampleCount={analysis.sleep.sampleCount}
                    />
                    <ColumnChart values={sleepTrend} labels={labels} xValues={xValues} target={data.sleep.goalMinutes} color="var(--category-sleep)" height={108} compact showRangeLabels formatter={(value) => compactMinutes(value)} ariaLabel="Sleep duration over the last 14 days" />
                  </Panel>
                )}
                {restingHeartTrendCount > 1 && (
                  <Panel className="home-mini-trend" category="heart">
                    <div className="mini-trend-heading"><DuoIcon icon={HeartIcon} className="mini-trend-icon" /><strong>Resting heart rate</strong></div>
                    <TrendStats
                      current={analysis.restingHeartRate.current === null ? '—' : `${formatNumber(analysis.restingHeartRate.current)} bpm`}
                      average={analysis.restingHeartRate.baseline === null ? '—' : `${formatNumber(analysis.restingHeartRate.baseline)} bpm`}
                      difference={analysis.restingHeartRate.difference === null ? '—' : `${signedNumber(analysis.restingHeartRate.difference)} bpm`}
                      sampleCount={analysis.restingHeartRate.sampleCount}
                    />
                    <LineChart values={restingHeartTrend} labels={labels} xValues={xValues} target={analysis.restingHeartRate.baseline} color="var(--category-heart)" height={108} compact showRangeLabels formatter={(value) => `${Math.round(value)} bpm`} ariaLabel="Resting heart rate over the last 14 days" />
                  </Panel>
                )}
              </div>
            </HomeSection>
          )}

          {(data.activities.length > 0 || bodySnapshots.length > 0) && (
            <HomeSection id="context" title="Additional context">
              <div className="home-lower-grid">
                {data.activities.length > 0 && (
                  <Panel className="home-activities-card activity-panel" category="activity">
                    <PanelHeader title="Recent activities" icon={ActivityIcon} action={<DetailAction label="Open all activities" onClick={() => navigate('activity')} />} />
                    {data.activities.slice(0, 2).map((item, index) => <div key={item.id}>{index > 0 && <Separator />}<CompactActivity item={item} /></div>)}
                  </Panel>
                )}

                {bodySnapshots.length > 0 && (
                  <Panel className="home-body-strip" category="body">
                    <PanelHeader title="Body and log" icon={BodyIcon} action={<DetailAction label="Open Body" onClick={() => navigate('body')} />} />
                    <div className="body-snapshot-row">{bodySnapshots.map((item) => <div className="body-snapshot" key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.note}</small></div>)}</div>
                  </Panel>
                )}
              </div>
            </HomeSection>
          )}
        </div>
      )}
    </div>
  )
}

type ActivityHistoryMetric = 'steps' | 'activeMinutes' | 'distanceKm' | 'calories'

export function ActivityView({ data, rangeDays, onRangeChange, historyDays }: ViewProps) {
  const [historyMetric, setHistoryMetric] = useState<ActivityHistoryMetric>('steps')
  const stepsByHour = hourlyBuckets(data.activity.stepsIntraday)
  const history = {
    steps: { label: 'Daily steps', icon: StepsIcon, values: data.trends.map((point) => point.steps), target: data.activity.stepsGoal, formatter: (value: number) => `${formatNumber(value)} steps` },
    activeMinutes: { label: 'Active minutes', icon: ActiveIcon, values: data.trends.map((point) => point.activeMinutes), target: data.activity.activeMinutesGoal, formatter: (value: number) => `${formatNumber(value)} min` },
    distanceKm: { label: 'Distance', icon: DistanceIcon, values: data.trends.map((point) => point.distanceKm), target: data.activity.distanceGoalKm, formatter: (value: number) => `${formatDecimal(value)} km` },
    calories: { label: 'Calories burned', icon: CaloriesIcon, values: data.trends.map((point) => point.calories), target: data.activity.caloriesGoal, formatter: (value: number) => `${formatNumber(value)} kcal` },
  } satisfies Record<ActivityHistoryMetric, { label: string; icon: AppIcon; values: Array<number | null>; target: number | null; formatter: (value: number) => string }>
  const selectedHistory = history[historyMetric]
  const selectedHistoryValues = selectedHistory.values.filter(hasValue)
  const selectedHistoryAverage = selectedHistoryValues.length
    ? selectedHistoryValues.reduce((sum, value) => sum + value, 0) / selectedHistoryValues.length
    : null
  const openHistory = (metric: ActivityHistoryMetric) => {
    setHistoryMetric(metric)
    requestAnimationFrame(() => document.getElementById('activity-metric-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  const supporting = [
    hasValue(data.activity.floors) ? { label: 'Floors', value: formatNumber(data.activity.floors), icon: FloorsIcon } : null,
    hasValue(data.activity.lightActiveMinutes) ? { label: 'Light activity', value: formatNumber(data.activity.lightActiveMinutes), unit: 'min', icon: ActivityIcon } : null,
    hasValue(data.activity.moderateActiveMinutes) ? { label: 'Moderate activity', value: formatNumber(data.activity.moderateActiveMinutes), unit: 'min', icon: ActiveIcon } : null,
    hasValue(data.activity.vigorousActiveMinutes) ? { label: 'Vigorous activity', value: formatNumber(data.activity.vigorousActiveMinutes), unit: 'min', icon: CaloriesIcon } : null,
    hasValue(data.activity.zoneMinutes) ? { label: 'Zone minutes', value: formatNumber(data.activity.zoneMinutes), unit: 'min', icon: GaugeIcon } : null,
    hasValue(data.activity.sedentaryMinutes) ? { label: 'Sedentary time', value: formatNumber(data.activity.sedentaryMinutes), unit: 'min', icon: DurationIcon } : null,
  ].filter((item): item is SupportingMetric => item !== null)
  const activityTrendValues = [
    data.trends.map((point) => point.zoneMinutes),
    data.trends.map((point) => point.sedentaryMinutes),
    data.trends.map((point) => point.floors),
  ]
  const hasActivityTrends = activityTrendValues.some((values) => values.filter(hasValue).length > 1)

  return (
    <div className="page-stack activity-page">
      <div className="metric-grid activity-primary-metrics">
        <MetricTile label="Steps" value={data.activity.steps} goal={data.activity.stepsGoal} icon={StepsIcon} onClick={() => openHistory('steps')} selected={historyMetric === 'steps'} />
        <MetricTile label="Active minutes" value={data.activity.activeMinutes} goal={data.activity.activeMinutesGoal} unit=" min" icon={ActiveIcon} onClick={() => openHistory('activeMinutes')} selected={historyMetric === 'activeMinutes'} />
        <MetricTile label="Distance" value={data.activity.distanceKm} goal={data.activity.distanceGoalKm} unit=" km" icon={DistanceIcon} decimals={1} onClick={() => openHistory('distanceKm')} selected={historyMetric === 'distanceKm'} />
        <MetricTile label="Calories" value={data.activity.calories} goal={data.activity.caloriesGoal} unit=" kcal" icon={CaloriesIcon} onClick={() => openHistory('calories')} selected={historyMetric === 'calories'} />
      </div>

      <section id="activity-metric-history" className="activity-metric-history">
        <Panel className="chart-panel activity-history-panel" category="activity">
          <PanelHeader
            eyebrow={`${selectedHistoryValues.length} days with data`}
            title={selectedHistory.label}
            icon={selectedHistory.icon}
            action={selectedHistoryAverage === null ? null : <Badge variant="secondary">Average {selectedHistory.formatter(selectedHistoryAverage)}</Badge>}
          />
          {selectedHistoryValues.length > 1 ? (
            historyMetric === 'steps'
              ? <ColumnChart values={selectedHistory.values} labels={trendLabels(data)} xValues={trendXValues(data)} target={selectedHistory.target} height={226} ariaLabel={`${selectedHistory.label} during the synced period`} />
              : <LineChart values={selectedHistory.values} labels={trendLabels(data)} xValues={trendXValues(data)} target={selectedHistory.target} color="var(--category-activity)" height={226} showRangeLabels variant="area" formatter={selectedHistory.formatter} ariaLabel={`${selectedHistory.label} during the synced period`} />
          ) : <EmptyValue>Not enough historical data for this metric yet.</EmptyValue>}
        </Panel>
      </section>

      <SupportingMetrics items={supporting} />

      <div className="chart-grid activity-chart-grid">
        {data.activity.stepsIntraday.length > 0 && (
          <Panel className="chart-panel" category="activity">
            <PanelHeader eyebrow="Day" title="Steps per hour" icon={ActivityIcon} />
            <ColumnChart
              values={stepsByHour.values}
              labels={stepsByHour.labels}
              xValues={stepsByHour.xValues}
              height={226}
              ariaLabel="Steps aggregated by hour"
            />
          </Panel>
        )}

      </div>

      {hasActivityTrends && (
        <section>
          <SectionTitle title="More activity trends" copy="Additional daily series returned by Google Health." action={<RangeSelector value={rangeDays} onChange={onRangeChange} historyDays={historyDays} />} />
          <div className="metric-trend-grid">
            <MetricTrendPanel data={data} category="activity" icon={GaugeIcon} title="Zone minutes" values={data.trends.map((point) => point.zoneMinutes)} formatter={(value) => `${formatNumber(value)} min`} />
            <MetricTrendPanel data={data} category="activity" icon={DurationIcon} title="Sedentary time" values={data.trends.map((point) => point.sedentaryMinutes)} formatter={(value) => formatMinutes(value)} />
            <MetricTrendPanel data={data} category="activity" icon={FloorsIcon} title="Floors" values={data.trends.map((point) => point.floors)} formatter={(value) => formatNumber(value)} />
          </div>
        </section>
      )}

      <section>
        <SectionTitle title="Workouts" copy={`${data.activities.length} activities in the synced period`} />
        <Panel className="activity-panel full-list" category="activity">
          {data.activities.map((item, index) => <div key={item.id}>{index > 0 && <Separator />}<CompactActivity item={item} detailed /></div>)}
          {!data.activities.length && <EmptyValue>No workouts recorded during this period.</EmptyValue>}
        </Panel>
      </section>

      {!hasActivityData(data) && <EmptyValue>No movement data available for this day.</EmptyValue>}
    </div>
  )
}

export function HealthView({ data, history, rangeDays, onRangeChange, historyDays }: ViewProps) {
  // Each past day is scored against the days before it, so the series is a
  // fair trend rather than today's baseline applied backwards.
  const heartHeatmapDays = history.days.filter((day) => day.heartIntraday !== null).length
  // One cell per day-hour, averaging the minutes that fall inside it. Hours the
  // device did not record simply have no cell and stay transparent.
  const heartHeatmapCells = history.days.flatMap((day) => {
    if (!day.heartIntraday) return []
    const hours = new Map<number, { total: number; count: number }>()
    for (const point of day.heartIntraday) {
      const hour = Number(point.time.slice(0, 2))
      if (!Number.isFinite(hour)) continue
      const bucket = hours.get(hour) ?? { total: 0, count: 0 }
      bucket.total += point.value
      bucket.count += 1
      hours.set(hour, bucket)
    }
    return [...hours.entries()].map(([hour, bucket]) => ({
      date: day.date,
      hour,
      value: Math.round(bucket.total / bucket.count),
    }))
  })
  const heartValues = data.health.heartRateIntraday.map((point) => point.value)
  const heartLabels = data.health.heartRateIntraday.map((point) => point.time)
  const restingValues = data.trends.map((point) => point.restingHeartRate)
  const restingCount = restingValues.filter(hasValue).length
  const signals = overnightSignals(data)
  const secondary = presentSignals([
    hasValue(data.health.cardioScore) ? { label: 'Cardio fitness', value: formatNumber(data.health.cardioScore), note: 'Latest score', icon: GaugeIcon } : null,
    hasValue(data.health.bloodGlucoseMgDl) ? { label: 'Blood glucose', value: formatNumber(data.health.bloodGlucoseMgDl), unit: 'mg/dL', note: 'Latest measurement', icon: WaterIcon } : null,
    hasValue(data.health.irregularRhythmAlerts) ? { label: 'Irregular rhythm', value: formatNumber(data.health.irregularRhythmAlerts), unit: 'alerts', note: 'During the synced period', icon: ShieldIcon } : null,
    data.health.ecgClassification ? { label: 'ECG', value: data.health.ecgClassification, note: 'Latest classification', icon: HeartIcon } : null,
    data.health.vo2Max ? { label: 'VO₂ max', value: data.health.vo2Max, unit: 'ml/kg/min', note: 'Cardio fitness estimate', icon: GaugeIcon } : null,
  ])
  const hasHeartSummary = heartValues.length > 0 || hasValue(data.health.currentHeartRate) || hasValue(data.health.restingHeartRate)
  const physiologyTrendValues = [
    data.trends.map((point) => point.hrvMs),
    data.trends.map((point) => point.spo2),
    data.trends.map((point) => point.breathingRate),
    data.trends.map((point) => point.skinTemperature),
    data.trends.map((point) => point.coreTemperature),
    data.trends.map((point) => point.cardioScore),
  ]
  const hasPhysiologyTrends = physiologyTrendValues.some((values) => values.filter(hasValue).length > 1)

  return (
    <div className="page-stack health-page">
      {hasHeartSummary && (
        <Panel className="heart-detail-card" category="heart">
          <PanelHeader eyebrow="Day" title="Heart rate" icon={HeartIcon} />
          <div className="heart-kpis">
            {hasValue(data.health.currentHeartRate) && <div className="primary-kpi"><strong>{formatNumber(data.health.currentHeartRate)}</strong><span>recent bpm</span></div>}
            {hasValue(data.health.restingHeartRate) && <TinyStat label="At rest" value={formatNumber(data.health.restingHeartRate)} unit=" bpm" />}
            {hasValue(data.health.heartRateMin) && <TinyStat label="Range" value={`${formatNumber(data.health.heartRateMin)}–${formatNumber(data.health.heartRateMax)}`} unit=" bpm" />}
          </div>
          {heartValues.length > 0 && (
            <LineChart
              values={heartValues}
              labels={heartLabels}
              xValues={timeXValues(heartLabels)}
              color="var(--category-heart)"
              target={data.health.restingHeartRate}
              targetLabel="Resting reference"
              height={266}
              formatter={(value) => `${Math.round(value)} bpm`}
              ariaLabel="Heart rate throughout the day"
            />
          )}
        </Panel>
      )}

      <div className="health-grid">
        {signals.length > 0 && (
          <section>
            <SectionTitle title="Nightly metrics" copy="Latest available measurements, without diagnostic thresholds." />
            <Panel className="signal-panel" category="heart">
              {signals.map((signal, index) => <div key={signal.label}>{index > 0 && <Separator />}<SignalRow signal={signal} /></div>)}
            </Panel>
          </section>
        )}

        {restingCount > 1 && (
          <section>
            <SectionTitle title="Resting heart rate" copy={`${restingCount} days with data`} />
            <Panel className="chart-panel compact-chart-panel" category="heart">
              <LineChart values={restingValues} labels={trendLabels(data)} xValues={trendXValues(data)} color="var(--category-heart)" height={226} formatter={(value) => `${Math.round(value)} bpm`} ariaLabel="Resting heart rate trend" />
            </Panel>
          </section>
        )}
      </div>

      {heartHeatmapCells.length > 0 && (
        <section>
          <SectionTitle
            title="Heart rate by hour"
            copy={`${heartHeatmapDays} days with intraday detail. Shading is relative to your own range, not a fixed scale.`}
          />
          <Panel className="chart-panel" category="heart">
            <Heatmap
              cells={heartHeatmapCells}
              layout="dayHour"
              color="var(--category-heart)"
              formatter={(value) => `${Math.round(value)} bpm`}
              ariaLabel="Average heart rate by day and hour"
            />
          </Panel>
        </section>
      )}

      {hasPhysiologyTrends && (
        <section>
          <SectionTitle title="Physiological trends" copy="Compare measurements with your personal trends, not generic thresholds." action={<RangeSelector value={rangeDays} onChange={onRangeChange} historyDays={historyDays} />} />
          <div className="metric-trend-grid">
            <MetricTrendPanel data={data} category="heart" icon={SignalIcon} title="HRV" values={data.trends.map((point) => point.hrvMs)} formatter={(value) => `${formatDecimal(value)} ms`} />
            <MetricTrendPanel data={data} category="heart" icon={CloudIcon} title="Average SpO₂" values={data.trends.map((point) => point.spo2)} formatter={(value) => `${formatDecimal(value)}%`} />
            <MetricTrendPanel data={data} category="heart" icon={BreathingIcon} title="Breathing rate" values={data.trends.map((point) => point.breathingRate)} formatter={(value) => `${formatDecimal(value)} rpm`} />
            <MetricTrendPanel data={data} category="recovery" icon={GaugeIcon} title="Skin temperature" values={data.trends.map((point) => point.skinTemperature)} formatter={(value) => `${signedNumber(value, 1)} °C`} />
            <MetricTrendPanel data={data} category="recovery" icon={GaugeIcon} title="Body temperature" values={data.trends.map((point) => point.coreTemperature)} formatter={(value) => `${formatDecimal(value)} °C`} />
            <MetricTrendPanel data={data} category="heart" icon={GaugeIcon} title="Cardio fitness" values={data.trends.map((point) => point.cardioScore)} formatter={(value) => formatNumber(value)} />
            <MetricTrendPanel data={data} category="recovery" icon={SparkleIcon} title="Recovery score" values={scoreSeries(data.trends, 'recovery')} formatter={(value) => `${Math.round(value)} / 100`} />
          </div>
        </section>
      )}

      {secondary.length > 0 && (
        <section>
          <SectionTitle title="Other measurements" />
          <Panel className="signal-panel secondary-signal-panel" category="heart">
            {secondary.map((signal, index) => <div key={signal.label}>{index > 0 && <Separator />}<SignalRow signal={signal} /></div>)}
          </Panel>
        </section>
      )}

      {!hasHealthData(data) && <EmptyValue>No cardiac or physiological data available for this day.</EmptyValue>}
      <div className="medical-note"><InfoIcon aria-hidden="true" /><p>Look at trends over time, not a single reading. OpenFit does not provide medical diagnoses.</p></div>
    </div>
  )
}

export function SleepView({ data, rangeDays, onRangeChange, historyDays }: ViewProps) {
  const sleepValues = data.trends.map((point) => point.sleepMinutes)
  const sleepCount = sleepValues.filter(hasValue).length
  const efficiencyValues = data.trends.map((point) => point.sleepEfficiency)
  const efficiencyCount = efficiencyValues.filter(hasValue).length
  const stageNights = data.trends.map((point) => {
    const { sleepDeepMinutes: deep, sleepLightMinutes: light, sleepRemMinutes: rem, sleepAwakeMinutes: wake } = point
    if (!hasValue(deep) || !hasValue(light) || !hasValue(rem) || !hasValue(wake)) return null
    return { deep, light, rem, wake }
  })
  const stageNightsCount = stageNights.filter((night) => night !== null).length
  const stageTimeline = data.sleep.stageTimeline ?? []
  const stageTransitions = data.sleep.stageTransitions
  const hasSummary = hasValue(data.sleep.totalMinutes) || hasValue(data.sleep.efficiency)
  return (
    <div className="page-stack sleep-page">
      {hasSummary && (
        <div className="sleep-layout">
          <Panel className="sleep-main-card" tone="violet" category="sleep">
            <PanelHeader eyebrow="Last night" title="Duration and quality" icon={SleepIcon} />
            <div className="sleep-main-summary">
              <div className="sleep-duration-large">
                <span>Sleep time</span>
                <strong>{compactMinutes(data.sleep.totalMinutes)}</strong>
                <small>{formatTime(data.sleep.startTime)} – {formatTime(data.sleep.endTime)}</small>
              </div>
              {hasValue(data.sleep.efficiency) && (
                <div className="sleep-efficiency-ring">
                  <RadialProgress
                    value={data.sleep.efficiency}
                    color="var(--category-sleep)"
                    label="Efficiency"
                    valueLabel={`${formatNumber(data.sleep.efficiency)}%`}
                    size={116}
                  />
                  <small className="sleep-efficiency-caption">asleep / time in bed</small>
                </div>
              )}
            </div>
            <div className="sleep-bullets">
              {hasValue(data.sleep.totalMinutes) && hasValue(data.sleep.goalMinutes) && (
                <BulletChart
                  value={data.sleep.totalMinutes}
                  target={data.sleep.goalMinutes}
                  max={Math.max(data.sleep.totalMinutes, data.sleep.goalMinutes) * 1.08}
                  label="Duration compared with goal"
                  valueLabel={`${compactMinutes(data.sleep.totalMinutes)} / ${compactMinutes(data.sleep.goalMinutes)}`}
                  color="var(--color-cyan)"
                />
              )}
            </div>
          </Panel>

          {data.sleep.stages.some((stage) => stage.minutes > 0) && (
            <Panel className="sleep-stage-card" category="sleep">
              <PanelHeader eyebrow="Recorded period" title="Time by stage" icon={SignalIcon} />
              {/* The legend and caption below state the denominator this card uses. */}
              <SleepStageBar stages={data.sleep.stages} showLegend={false} caption={null} />
              <div className="sleep-stage-legend">
                {data.sleep.stages.map((stage) => {
                  const percent = stage.key === 'deep' ? data.sleep.deepPercent
                    : stage.key === 'rem' ? data.sleep.remPercent
                      : stage.key === 'light' ? data.sleep.lightPercent
                        : null
                  return (
                    <div key={stage.key}>
                      <span className="legend-dot" style={{ background: `var(--sleep-${stage.key})` }} />
                      <span>{stage.name}</span>
                      <strong>
                        {stage.key !== 'wake' && hasValue(percent) ? `${Math.round(percent)}% · ` : ''}
                        {Math.floor(stage.minutes / 60) ? `${Math.floor(stage.minutes / 60)}h ` : ''}{stage.minutes % 60}m
                      </strong>
                    </div>
                  )
                })}
              </div>
              <p className="sleep-stage-caption">Deep, light, and REM percentages are of time asleep; awake shows minutes only, since it isn't part of that total.</p>
              {data.sleep.totalMinutes !== null && data.sleep.goalMinutes !== null && (
                <div className="compact-stats">
                  <TinyStat label="Difference from goal" value={formatMinutes(data.sleep.totalMinutes - data.sleep.goalMinutes)} />
                </div>
              )}
            </Panel>
          )}
        </div>
      )}

      {stageTimeline.length > 0 && (
        <Panel className="sleep-timeline-card" category="sleep">
          <PanelHeader eyebrow={`${stageTimeline.length} segments detected`} title="Night timeline" icon={TrendIcon} />
          <SleepStageTimeline segments={stageTimeline} />
          <div className="sleep-detail-stats">
            {hasValue(data.sleep.timeInBed) && <TinyStat label="Time in bed" value={formatMinutes(data.sleep.timeInBed)} />}
            {hasValue(data.sleep.minutesAwake) && <TinyStat label="Time awake" value={formatMinutes(data.sleep.minutesAwake)} />}
            {hasValue(data.sleep.minutesToFallAsleep) && <TinyStat label="Time to fall asleep" value={formatMinutes(data.sleep.minutesToFallAsleep)} />}
            {hasValue(data.sleep.minutesAfterWakeUp) && <TinyStat label="After waking" value={formatMinutes(data.sleep.minutesAfterWakeUp)} />}
            {hasValue(stageTransitions?.wake) && <TinyStat label="Awake episodes" value={formatNumber(stageTransitions.wake)} />}
          </div>
        </Panel>
      )}

      {(sleepCount > 1 || efficiencyCount > 1 || stageNightsCount > 1) && (
        <section>
          <SectionTitle title="Sleep trends" copy="Duration and efficiency of recorded nights." action={<RangeSelector value={rangeDays} onChange={onRangeChange} historyDays={historyDays} />} />
          <div className="chart-grid sleep-history-grid">
            {sleepCount > 1 && (
              <Panel className="chart-panel sleep-trend-panel" category="sleep">
                <PanelHeader eyebrow={`${sleepCount} nights with data`} title="Duration per night" icon={SleepIcon} />
                <ColumnChart values={sleepValues} labels={trendLabels(data)} xValues={trendXValues(data)} target={data.sleep.goalMinutes} color="var(--category-sleep)" height={196} formatter={(value) => compactMinutes(value)} ariaLabel="Minutes of sleep per night" />
              </Panel>
            )}
            <MetricTrendPanel data={data} category="sleep" icon={GaugeIcon} title="Efficiency" values={efficiencyValues} formatter={(value) => `${formatNumber(value)}%`} target={90} />
            <MetricTrendPanel data={data} category="sleep" icon={SparkleIcon} title="Sleep quality score" values={scoreSeries(data.trends, 'sleepQuality')} formatter={(value) => `${Math.round(value)} / 100`} />
            {stageNightsCount > 1 && (
              <Panel className="chart-panel sleep-trend-panel" category="sleep">
                <PanelHeader eyebrow={`${stageNightsCount} nights with data`} title="Stage composition" icon={SignalIcon} />
                <StackedColumnChart points={stageNights} labels={trendLabels(data)} xValues={trendXValues(data)} height={196} formatter={(value) => compactMinutes(value)} ariaLabel="Sleep stage minutes per night" />
              </Panel>
            )}
          </div>
        </section>
      )}

      {!hasSleepData(data) && <EmptyValue>No sleep data available for this day.</EmptyValue>}
    </div>
  )
}

function BodyMetric({ label, value, unit, icon: Icon, note }: { label: string; value: string; unit?: string; icon: AppIcon; note: string }) {
  return (
    <div className="body-metric">
      <DuoIcon icon={Icon} className="body-metric-icon" />
      <div><span>{label}</span><strong>{value}{unit && <small>{unit}</small>}</strong><p>{note}</p></div>
    </div>
  )
}

export function BodyView({ data, rangeDays, onRangeChange, historyDays }: ViewProps) {
  const weightValues = data.trends.map((point) => point.weight)
  const weightCount = weightValues.filter(hasValue).length
  const hasComposition = hasValue(data.body.bmi) || hasValue(data.body.bodyFat)
  const hasDaily = hasValue(data.body.waterMl) || hasValue(data.body.caloriesIn)
  const bodyTrendValues = [
    data.trends.map((point) => point.bodyFat),
    data.trends.map((point) => point.waterMl),
    data.trends.map((point) => point.caloriesIn),
  ]
  const hasBodyTrends = bodyTrendValues.some((values) => values.filter(hasValue).length > 1)
  return (
    <div className="page-stack body-page">
      <div className="body-layout">
        {hasValue(data.body.weightKg) && (
          <Panel className="weight-card" category="body">
            <PanelHeader eyebrow={`${weightCount} measurements`} title="Weight" icon={BodyIcon} />
            <div className="body-weight-value"><strong>{formatDecimal(data.body.weightKg)}</strong><span>kg</span></div>
            {hasValue(data.body.weightGoalKg) && (
              <div className="weight-goal-copy">
                <span>Goal {formatDecimal(data.body.weightGoalKg)} kg</span>
                <strong>{formatDecimal(data.body.weightKg - data.body.weightGoalKg)} kg difference</strong>
              </div>
            )}
            {weightCount > 1 && (
              <LineChart values={weightValues} labels={trendLabels(data)} xValues={trendXValues(data)} target={data.body.weightGoalKg} targetLabel="Goal" height={238} formatter={(value) => `${formatDecimal(value)} kg`} ariaLabel="Weight trend" />
            )}
          </Panel>
        )}

        {(hasComposition || hasDaily) && (
          <div className="body-side-stack">
            {hasComposition && (
              <Panel className="body-metrics-panel" category="body">
                <PanelHeader eyebrow="Latest measurement" title="Composition" icon={GaugeIcon} />
                <div className="body-metrics-list">
                  {hasValue(data.body.bmi) && <BodyMetric label="BMI" value={formatDecimal(data.body.bmi)} icon={GaugeIcon} note="Body mass index" />}
                  {hasValue(data.body.bodyFat) && <BodyMetric label="Body fat" value={formatDecimal(data.body.bodyFat)} unit="%" icon={SignalIcon} note="Estimated percentage" />}
                </div>
              </Panel>
            )}
            {hasDaily && (
              <Panel className="body-metrics-panel body-daily-panel" category="body">
                <PanelHeader eyebrow="Day" title="Balance" icon={NutritionIcon} />
                {hasValue(data.body.waterMl) && (
                  <BulletChart
                    value={data.body.waterMl}
                    target={data.body.waterGoalMl}
                    max={Math.max(data.body.waterMl, data.body.waterGoalMl ?? 0) * 1.08}
                    label="Water"
                    valueLabel={`${formatNumber(data.body.waterMl)} ml${data.body.waterGoalMl ? ` / ${formatNumber(data.body.waterGoalMl)} ml` : ''}`}
                    color="var(--color-cyan)"
                  />
                )}
                {hasValue(data.body.caloriesIn) && <BodyMetric label="Calories consumed" value={formatNumber(data.body.caloriesIn)} unit="kcal" icon={CaloriesIcon} note="Recorded total" />}
              </Panel>
            )}
          </div>
        )}
      </div>
      {hasBodyTrends && (
        <section>
          <SectionTitle title="Body and log trends" copy="Only measurements recorded during the synced period." action={<RangeSelector value={rangeDays} onChange={onRangeChange} historyDays={historyDays} />} />
          <div className="metric-trend-grid">
            <MetricTrendPanel data={data} category="body" icon={SignalIcon} title="Body fat" values={data.trends.map((point) => point.bodyFat)} formatter={(value) => `${formatDecimal(value)}%`} />
            <MetricTrendPanel data={data} category="body" icon={WaterIcon} title="Hydration" values={data.trends.map((point) => point.waterMl)} formatter={(value) => `${formatNumber(value)} ml`} />
            <MetricTrendPanel data={data} category="body" icon={CaloriesIcon} title="Calories consumed" values={data.trends.map((point) => point.caloriesIn)} formatter={(value) => `${formatNumber(value)} kcal`} />
          </div>
        </section>
      )}
      {!hasBodyData(data) && <EmptyValue>No body measurements available for this account.</EmptyValue>}
    </div>
  )
}

function CoverageRow({ icon: Icon, label, items }: { icon: AppIcon; label: string; items: string[] }) {
  return (
    <div className="coverage-row">
      <DuoIcon icon={Icon} className="coverage-icon" />
      <div><strong>{label}</strong><span>{items.length ? items.join(' · ') : 'No data'}</span></div>
      {items.length > 0 && <CheckIcon className="coverage-check" aria-label="Available" />}
    </div>
  )
}

/**
 * Importing history means one provider round trip per missing day, so it is
 * always explicit: never triggered by opening a page or by the scheduler.
 */
function HistoryImport({ historyDays }: { historyDays: number }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BackfillProgress | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)

  useEffect(() => window.fitbit?.onBackfillProgress(setProgress), [])

  const start = async (days: number) => {
    if (!window.fitbit || running) return
    setRunning(true)
    setOutcome(null)
    try {
      const result = await window.fitbit.backfillHistory(days)
      setOutcome(result.requested === 0
        ? 'Nothing left to import for this range.'
        : `Imported ${result.imported} of ${result.requested} days.`
          + (result.empty ? ` ${result.empty} had no data.` : '')
          + (result.failed ? ` ${result.failed} failed.` : '')
          + (result.canceled ? ' Stopped early.' : ''))
    } catch (error) {
      setOutcome(error instanceof Error ? error.message : 'Import failed.')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <Panel className="history-import" category="device">
      <PanelHeader
        eyebrow={`${historyDays} ${historyDays === 1 ? 'day' : 'days'} stored locally`}
        title="Import history"
        icon={CloudIcon}
      />
      <p className="history-import-copy">
        Fetches days missing from the local archive, one request per day and newest first.
        A longer range takes proportionally longer. Days the provider has no data for are not asked for again.
      </p>
      {running ? (
        <div className="history-import-progress">
          <span>{progress?.date ? `Importing ${formatDate(progress.date, { day: 'numeric', month: 'short' })}…` : 'Preparing…'}</span>
          {progress && progress.total > 0 && <strong>{progress.completed} / {progress.total}</strong>}
          <button type="button" onClick={() => window.fitbit?.cancelBackfill()}>Stop</button>
        </div>
      ) : (
        <div className="history-import-actions">
          {[30, 90, 365].map((days) => (
            <button key={days} type="button" onClick={() => void start(days)}>
              {days === 365 ? 'Last year' : `Last ${days} days`}
            </button>
          ))}
        </div>
      )}
      {outcome && <p className="history-import-outcome">{outcome}</p>}
    </Panel>
  )
}

export function DevicesView({ data, status, historyDays }: ViewProps) {
  const stepsSourceLabel = data.activity.stepsSource === 'google-fit'
    ? 'Google Fit'
    : data.activity.stepsSource === 'google-fit+health'
      ? 'Google Fit + Health'
    : data.activity.stepsSource === 'google-health'
      ? 'Google Health'
      : data.activity.stepsSource === 'fitbit'
        ? 'Fitbit'
        : null
  const movement = [
    hasValue(data.activity.steps) && `steps${stepsSourceLabel ? ` · ${stepsSourceLabel}` : ''}`,
    data.activity.stepsIntraday.length > 0 && 'steps per hour',
    data.activities.length > 0 && `${data.activities.length} workouts`,
    hasValue(data.activity.activeMinutes) && 'active minutes',
  ].filter((item): item is string => Boolean(item))
  const heart = [
    data.health.heartRateIntraday.length > 0 && 'heart rate throughout the day',
    hasValue(data.health.restingHeartRate) && 'resting heart rate',
    hasValue(data.health.hrvMs) && 'HRV',
    data.health.ecgClassification && 'ECG',
  ].filter((item): item is string => Boolean(item))
  const sleep = [hasSleepData(data) && 'duration and stages', hasValue(data.sleep.score) && 'score'].filter((item): item is string => Boolean(item))
  const nightly = overnightSignals(data).map((signal) => signal.label.toLowerCase())
  const body = [
    hasValue(data.body.weightKg) && 'weight',
    hasValue(data.body.bodyFat) && 'body fat',
    hasValue(data.body.waterMl) && 'hydration',
    hasValue(data.body.caloriesIn) && 'nutrition',
  ].filter((item): item is string => Boolean(item))
  const isDemo = data.source === 'demo'
  const isConnected = status.connected || isDemo
  const sourceName = isDemo ? 'Sample data' : status.provider === 'fitbit-legacy' ? 'Fitbit legacy' : 'Google Health'
  const deviceName = data.device?.name ?? (isDemo ? 'Google Fitbit Air' : sourceName)

  return (
    <div className="page-stack devices-page">
      <div className="data-overview">
        <div className="data-source-column">
          <Panel className="device-card" category="device">
            <div className="device-visual device-product-visual">
              <img src="/fitbit-air.png" alt="Google Fitbit Air in Obsidian" />
            </div>
            <div className="device-copy">
              <Badge variant="secondary" className={`connection-badge ${isConnected ? 'is-connected' : ''}`}><span className={`status-dot ${isConnected ? 'online' : ''}`} /> {isConnected ? 'Connected' : 'Not connected'}</Badge>
              <h2>{deviceName}</h2>
              <p>{data.device?.type ?? sourceName}{data.device?.firmware && !isDemo ? ` · firmware ${data.device.firmware}` : ''}</p>
              <div className="device-facts">
                {hasValue(data.device?.batteryLevel ?? null) && <span><BatteryIcon /> {formatNumber(data.device?.batteryLevel ?? null)}%</span>}
                {data.device?.lastSyncTime && <span><CloudIcon /> Updated {relativeTime(data.device.lastSyncTime)}</span>}
                <span><SignalIcon /> {availableMetricCount(data)} metrics available</span>
              </div>
            </div>
          </Panel>

          <div className={`privacy-card ${status.storageEncrypted ? '' : 'is-warning'}`}>
            <ShieldIcon aria-hidden="true" />
            <div>
              <strong>{status.storageEncrypted ? 'Encrypted local storage' : 'Local encryption unavailable'}</strong>
              <p>{status.storageEncrypted ? 'Credentials and health cache are protected by the operating system keychain.' : 'Demo data does not contain personal health information; connect the Electron app to use the system vault.'}</p>
            </div>
          </div>
        </div>

        <Panel className="coverage-card" category="device">
          <PanelHeader eyebrow="Sync quality" title="Data coverage" icon={CloudIcon} />
          <BulletChart
            value={data.sync.successCount}
            target={data.sync.endpointCount}
            max={Math.max(data.sync.endpointCount, 1)}
            label="Available sources"
            valueLabel={`${data.sync.successCount} / ${data.sync.endpointCount}`}
            color="var(--color-emerald)"
          />
          <div className="coverage-list">
            <CoverageRow icon={ActivityIcon} label="Movement" items={movement} />
            <Separator />
            <CoverageRow icon={HeartIcon} label="Heart" items={heart} />
            <Separator />
            <CoverageRow icon={SleepIcon} label="Sleep" items={sleep} />
            <Separator />
            <CoverageRow icon={SignalIcon} label="Nightly signals" items={nightly} />
            <Separator />
            <CoverageRow icon={BodyIcon} label="Body and nutrition" items={body} />
          </div>
        </Panel>
      </div>

      {!isDemo && status.connected && <HistoryImport historyDays={historyDays} />}

      {data.sync.errors.length > 0 && <div className="sync-note"><InfoIcon aria-hidden="true" /><p>{data.sync.errors.length} sources returned no data for the selected period. Available measurements remain visible.</p></div>}
      {!isDemo && status.provider === 'google-health' && (
        <div className="sync-note"><InfoIcon aria-hidden="true" /><p>{status.googleFitStatus === 'active'
          ? 'Google Fit step access is active; Google Fit steps take priority when available.'
          : status.googleFitStatus === 'reconnect-required'
            ? 'Google Fit step authorization expired or was revoked. Open settings to reconnect it.'
            : status.googleFitStatus === 'error'
              ? 'Google Fit steps are temporarily unavailable. OpenFit is continuing with Google Health data.'
              : 'Open settings and authorize Google Fit steps separately.'}</p></div>
      )}
    </div>
  )
}
