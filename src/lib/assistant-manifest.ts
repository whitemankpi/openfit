import type { DashboardData, PageId } from '@/types'
import type { History } from '@/data/history'
import { computeScores } from './scores'
import { METRIC_KEYS } from './assistant-tools'

/**
 * What the model gets before it asks for anything.
 *
 * Deliberately not the archive: it says what exists and over what range, and
 * leaves the model to pull only the numbers its question needs. Less of the
 * wearer's history leaves the machine for a question about one night.
 */
export function buildAssistantManifest(data: DashboardData, history: History, page: PageId): string {
  const dates = history.days.map((day) => day.date)
  const present = METRIC_KEYS.filter((metric) => history.days.some((day) => {
    const value = (day.trend as unknown as Record<string, number | null>)[metric]
    return value !== null && value !== undefined && Number.isFinite(value)
  }))
  const scores = computeScores(data, history)

  return JSON.stringify({
    schema: 'openfit-assistant-manifest/v1',
    generatedAt: new Date().toISOString(),
    source: data.source,
    app: {
      currentPage: page,
      selectedDate: data.selectedDate,
      navigablePages: ['today', 'activity', 'health', 'sleep', 'body', 'devices'],
    },
    profile: { displayName: data.profile.displayName, timezone: data.profile.timezone },
    units: {
      heartRate: 'bpm', hrv: 'ms', breathingRate: 'breaths/min', spo2: '%',
      temperature: '°C', weight: 'kg', distance: 'km', energy: 'kcal', duration: 'minutes',
    },
    archive: {
      dayCount: history.days.length,
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
      intradayDays: history.days.filter((day) => day.heartIntraday !== null).length,
      metrics: present,
    },
    selectedDay: {
      date: data.selectedDate,
      steps: data.activity.steps,
      restingHeartRate: data.health.restingHeartRate,
      hrvMs: data.health.hrvMs,
      sleepMinutes: data.sleep.totalMinutes,
      sleepEfficiency: data.sleep.efficiency,
    },
    scores: {
      recovery: { value: scores.recovery.value, confidence: scores.recovery.confidence },
      load: { value: scores.load.value, confidence: scores.load.confidence },
      sleepQuality: { value: scores.sleepQuality.value, confidence: scores.sleepQuality.confidence },
    },
    syncCoverage: data.sync,
  })
}
