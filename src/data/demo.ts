import type { ActivityItem, DashboardData, HeartZoneMinutes, SleepStage, SleepStageKey, SleepStageSegment, TimePoint, TrendPoint } from '../types.js'
import type { History, HistoryDay } from './history.js'

const dayMs = 86_400_000

function localIso(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function dateFromIso(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

function seeded(index: number, salt: number) {
  return Math.sin(index * 12.9898 + salt * 78.233) * 0.5 + 0.5
}

// Midpoint of the night in minutes relative to local midnight, folded onto (-720, 720].
function midSleepMinutes(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  const mid = new Date(start + (end - start) / 2)
  const minutesFromMidnight = mid.getHours() * 60 + mid.getMinutes() + mid.getSeconds() / 60
  const folded = minutesFromMidnight > 720 ? minutesFromMidnight - 1440 : minutesFromMidnight
  return Math.round(folded)
}

// A full year of history is generated on every demo render, so this must stay O(days).
const TREND_DAYS = 365

function makeTrends(selectedDate: string): TrendPoint[] {
  const end = dateFromIso(selectedDate)
  const formatter = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
  return Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = new Date(end.getTime() - (TREND_DAYS - 1 - index) * dayMs)
    const weekday = date.getDay() // 0 = Sunday .. 6 = Saturday
    const isWeekend = weekday === 0 || weekday === 6
    // One full sine cycle across the year, for a gentle seasonal drift on
    // weight/resting heart rate rather than pure day-to-day noise.
    const seasonalPhase = (index / TREND_DAYS) * Math.PI * 2
    const activityWave = Math.sin(index * 0.9) * 1_350
    const weekendAdjustment = isWeekend ? -1_200 : 300
    const steps = Math.round(7_200 + activityWave + weekendAdjustment + seeded(index, 2) * 3_100)
    const sleepMinutes = Math.round(390 + seeded(index, 4) * 85)
    const activeMinutes = Math.round(38 + seeded(index, 5) * 48)
    const sleepDeepMinutes = Math.round(sleepMinutes * (0.19 + seeded(index, 21) * 0.04))
    const sleepRemMinutes = Math.round(sleepMinutes * (0.21 + seeded(index, 22) * 0.05))
    const sleepLightMinutes = Math.max(0, sleepMinutes - sleepDeepMinutes - sleepRemMinutes)
    const heartRateMin = Math.round(46 + seeded(index, 30) * 10)
    const heartRateMax = Math.round(140 + seeded(index, 31) * 40)
    const heartRateAvg = Math.round(68 + seeded(index, 32) * 12)
    const sleepingHeartRate = Math.max(heartRateMin, Math.min(heartRateAvg, Math.round(50 + seeded(index, 33) * 10)))
    return {
      date: localIso(date),
      label: formatter.format(date).replace('.', ''),
      steps,
      calories: Math.round(1_750 + steps * 0.055),
      distanceKm: Number((steps * 0.00079).toFixed(2)),
      floors: Math.round(5 + seeded(index, 9) * 11),
      activeMinutes,
      zoneMinutes: Math.round(activeMinutes * (0.72 + seeded(index, 10) * 0.45)),
      sedentaryMinutes: Math.round(480 + seeded(index, 11) * 130),
      restingHeartRate: Math.round(60 + Math.sin(seasonalPhase) * 2 + seeded(index, 6) * 6),
      heartRateAvg,
      heartRateMin,
      heartRateMax,
      sleepingHeartRate,
      hrvMs: Math.round(42 + seeded(index, 12) * 14),
      breathingRate: Number((14.1 + seeded(index, 13) * 1.5).toFixed(1)),
      spo2: Number((96.2 + seeded(index, 14) * 1.6).toFixed(1)),
      skinTemperature: Number((-0.35 + seeded(index, 15) * 0.7).toFixed(1)),
      coreTemperature: null,
      cardioScore: Math.round(49 + seeded(index, 16) * 5),
      sleepMinutes,
      sleepScore: null,
      sleepEfficiency: Math.round(86 + seeded(index, 17) * 9),
      sleepDeepMinutes,
      sleepRemMinutes,
      sleepLightMinutes,
      sleepAwakeMinutes: Math.round(20 + seeded(index, 23) * 30),
      sleepLatencyMinutes: Math.round(5 + seeded(index, 24) * 15),
      sleepMidTime: Math.round(170 + seeded(index, 25) * 60),
      weight: Number((72.5 + Math.sin(seasonalPhase) * 0.6 + seeded(index, 3) * 0.28).toFixed(1)),
      bodyFat: Number((16.7 + Math.sin(seasonalPhase) * 0.3 + seeded(index, 18) * 0.4).toFixed(1)),
      waterMl: Math.round(1_650 + seeded(index, 19) * 850),
      caloriesIn: Math.round(1_720 + seeded(index, 20) * 520),
    }
  })
}

function makeHeartSeries(): TimePoint[] {
  return Array.from({ length: 48 }, (_, index) => {
    const hours = Math.floor(index / 2)
    const minutes = index % 2 ? '30' : '00'
    const base = hours < 7 ? 58 : hours < 17 ? 74 : 69
    const training = hours === 18 || hours === 19 ? 55 * Math.sin(((index - 35) / 8) * Math.PI) : 0
    return {
      time: `${String(hours).padStart(2, '0')}:${minutes}`,
      value: Math.round(base + Math.sin(index * 0.7) * 5 + Math.max(0, training)),
    }
  })
}

/**
 * Synthetic minute-series for one archived history day. Only called for the
 * days that actually get intraday data (see `createDemoHistory`), so it stays
 * off the hot path for the other ~335 days of a year of history.
 */
function makeHeartSeriesForDay(dayIndex: number, trend: TrendPoint): TimePoint[] {
  const pointCount = 48 + Math.round(seeded(dayIndex, 40) * 48) // 48-96 points/day
  const minutesPerPoint = 1_440 / pointCount
  const min = trend.heartRateMin ?? 50
  const max = trend.heartRateMax ?? 160
  const avg = trend.heartRateAvg ?? 72
  return Array.from({ length: pointCount }, (_, index) => {
    const minuteOfDay = Math.round(index * minutesPerPoint)
    const hours = Math.floor(minuteOfDay / 60)
    const minutes = minuteOfDay % 60
    const hourFrac = hours + minutes / 60
    const base = hourFrac < 7 ? min + (avg - min) * 0.3 : hourFrac < 17 ? avg + (max - avg) * 0.15 : avg
    const training = hourFrac >= 18 && hourFrac <= 19.5
      ? (max - avg) * Math.max(0, Math.sin(((hourFrac - 18) / 1.5) * Math.PI))
      : 0
    const noise = (seeded(dayIndex * 97 + index, 41) - 0.5) * 8
    const value = Math.round(Math.min(max, Math.max(min, base + training + noise)))
    return { time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, value }
  })
}

/**
 * Plausible heart-zone minute counts for one archived history day, scaled up
 * on days whose intraday max was higher (harder-effort days).
 */
function makeZoneMinutesForDay(dayIndex: number, trend: TrendPoint): HeartZoneMinutes {
  const max = trend.heartRateMax ?? 160
  const intensity = Math.min(1, Math.max(0, (max - 140) / 40))
  return {
    light: Math.round(30 + intensity * 20 + seeded(dayIndex, 42) * 15),
    moderate: Math.round(10 + intensity * 15 + seeded(dayIndex, 43) * 10),
    vigorous: Math.round(5 + intensity * 20 + seeded(dayIndex, 44) * 10),
    peak: Math.round(intensity * 10 + seeded(dayIndex, 45) * 5),
  }
}

function makeStepsSeries(): TimePoint[] {
  const values = [0, 0, 0, 0, 0, 0, 45, 420, 510, 180, 230, 340, 680, 320, 210, 460, 290, 370, 1720, 1420, 610, 280, 90, 18]
  return values.map((value, index) => ({
    time: `${String(index).padStart(2, '0')}:00`,
    value,
  }))
}

const stages: SleepStage[] = [
  { name: 'Deep', key: 'deep', minutes: 81, color: '#555b64' },
  { name: 'Light', key: 'light', minutes: 218, color: '#858c95' },
  { name: 'REM', key: 'rem', minutes: 96, color: '#bcc1c7' },
  { name: 'Awake', key: 'wake', minutes: 38, color: '#363a40' },
]

function makeSleepTimeline(selectedDate: string): SleepStageSegment[] {
  const endDate = dateFromIso(selectedDate)
  const start = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 1, 23, 42)
  const sequence: Array<[SleepStageKey, number]> = [
    ['light', 25], ['deep', 35], ['light', 42], ['rem', 18], ['wake', 5],
    ['light', 35], ['deep', 30], ['light', 40], ['rem', 28], ['wake', 8],
    ['light', 36], ['deep', 16], ['light', 40], ['rem', 25], ['wake', 10],
    ['rem', 25], ['wake', 15],
  ]
  let cursor = start.getTime()
  return sequence.map(([type, minutes]) => {
    const startTime = new Date(cursor).toISOString()
    cursor += minutes * 60_000
    return { type, startTime, endTime: new Date(cursor).toISOString() }
  })
}

function makeActivities(selectedDate: string): ActivityItem[] {
  return [
    {
      id: 'run-demo',
      name: 'Outdoor run',
      date: selectedDate,
      time: '18:24',
      durationMinutes: 38,
      calories: 438,
      distanceKm: 6.24,
      averageHeartRate: 148,
      zoneMinutes: 52,
      steps: 7_842,
      averagePaceSecondsPerMeter: 38 * 60 / 6_240,
      heartZoneMinutes: { light: 6, moderate: 10, vigorous: 15, peak: 7 },
      sources: ['Fitbit'],
    },
    {
      id: 'walk-demo',
      name: 'Walk',
      date: selectedDate,
      time: '12:46',
      durationMinutes: 24,
      calories: 116,
      distanceKm: 1.72,
      averageHeartRate: 101,
      zoneMinutes: 8,
      steps: 2_236,
      averagePaceSecondsPerMeter: 24 * 60 / 1_720,
      heartZoneMinutes: { light: 16, moderate: 8, vigorous: 0, peak: 0 },
      sources: ['WalkingPad', 'Fitbit'],
    },
    {
      id: 'strength-demo',
      name: 'Functional training',
      date: localIso(new Date(dateFromIso(selectedDate).getTime() - dayMs)),
      time: '19:08',
      durationMinutes: 46,
      calories: 326,
      distanceKm: null,
      averageHeartRate: 126,
      zoneMinutes: 34,
      steps: null,
      averagePaceSecondsPerMeter: null,
      heartZoneMinutes: { light: 10, moderate: 15, vigorous: 18, peak: 3 },
      sources: ['Wahoo Fitness · Magene'],
    },
  ]
}

export function createDemoData(selectedDate = localIso()): DashboardData {
  const trends = makeTrends(selectedDate)
  const latest = trends.at(-1)!
  const latestSteps = latest.steps ?? 0
  const latestSleepMinutes = latest.sleepMinutes ?? 0
  const stepsIntraday = makeStepsSeries()
  const heartRateIntraday = makeHeartSeries()
  const sleepStartTime = `${localIso(new Date(dateFromIso(selectedDate).getTime() - dayMs))}T23:42:00`
  const sleepEndTime = `${selectedDate}T06:55:00`
  const stageMinutes = (key: SleepStage['key']) => stages.find((stage) => stage.key === key)?.minutes ?? 0
  const sleepAsleepMinutes = stages.reduce((sum, stage) => sum + (stage.key === 'wake' ? 0 : stage.minutes), 0)
  const sleepWakeMinutes = stageMinutes('wake')
  // Percentages are shown next to the stage bar, so they use the same asleep
  // total the bar renders rather than the independently seeded trend value.
  const stagePercent = (key: SleepStage['key']) => Number((stageMinutes(key) / sleepAsleepMinutes * 100).toFixed(1))

  return {
    source: 'demo',
    selectedDate,
    generatedAt: new Date().toISOString(),
    profile: {
      displayName: 'Flavio',
      avatar: null,
      memberSince: '2021-03-12',
      timezone: 'Europe/Rome',
    },
    device: {
      id: 'demo-tracker',
      name: 'Google Fitbit Air',
      type: 'SCREENLESS FITNESS TRACKER',
      battery: 'High',
      batteryLevel: 82,
      lastSyncTime: new Date(Date.now() - 6 * 60_000).toISOString(),
      firmware: '20001.194.91',
      features: ['STEPS', 'HEART_RATE', 'SLEEP', 'SPO2', 'SKIN_TEMPERATURE', 'ACTIVE_ZONE_MINUTES'],
    },
    activity: {
      steps: latest.steps,
      stepsSource: null,
      stepsGoal: 10_000,
      calories: latest.calories,
      caloriesGoal: 2_450,
      distanceKm: latest.distanceKm,
      distanceGoalKm: 8,
      floors: latest.floors,
      floorsGoal: 10,
      activeMinutes: latest.activeMinutes,
      lightActiveMinutes: 245,
      moderateActiveMinutes: Math.max(0, (latest.activeMinutes ?? 0) - 22),
      vigorousActiveMinutes: 22,
      activeMinutesGoal: 60,
      zoneMinutes: latest.zoneMinutes,
      sedentaryMinutes: latest.sedentaryMinutes,
      stepsIntraday,
      caloriesIntraday: stepsIntraday.map((point, index) => ({
        time: point.time,
        value: Math.round(62 + point.value * 0.055 + Math.sin(index) * 5),
      })),
    },
    health: {
      currentHeartRate: 72,
      restingHeartRate: latest.restingHeartRate,
      heartRateMin: 53,
      heartRateMax: 171,
      heartRateIntraday,
      hrvMs: latest.hrvMs,
      hrvDeepSleepRmssdMs: (latest.hrvMs ?? 0) + 7,
      hrvEntropy: 3.61,
      nonRemHeartRate: 57,
      breathingRate: latest.breathingRate,
      spo2: latest.spo2,
      spo2Min: (latest.spo2 ?? 97) - 1.8,
      spo2Max: Math.min(100, (latest.spo2 ?? 97) + 1.1),
      skinTemperature: latest.skinTemperature,
      skinNightlyTemperatureCelsius: 33.63,
      skinBaselineTemperatureCelsius: 33.55,
      skinTemperatureStddev30dCelsius: 0.13,
      coreTemperature: null,
      vo2Max: '49–53',
      cardioScore: latest.cardioScore,
      ecgClassification: 'Ritmo sinusale',
      bloodGlucoseMgDl: null,
      irregularRhythmAlerts: 0,
    },
    sleep: {
      totalMinutes: latest.sleepMinutes,
      goalMinutes: 480,
      score: latest.sleepScore,
      efficiency: latest.sleepEfficiency,
      startTime: sleepStartTime,
      endTime: sleepEndTime,
      stages,
      stageTimeline: makeSleepTimeline(selectedDate),
      stageTransitions: { deep: 3, light: 6, rem: 4, wake: 4 },
      minutesToFallAsleep: 0,
      minutesAfterWakeUp: 0,
      timeInBed: 433,
      minutesAwake: 38,
      minutesInSleepPeriod: sleepAsleepMinutes + sleepWakeMinutes,
      deepPercent: stagePercent('deep'),
      remPercent: stagePercent('rem'),
      lightPercent: stagePercent('light'),
      midSleepTime: midSleepMinutes(sleepStartTime, sleepEndTime),
    },
    body: {
      weightKg: latest.weight,
      weightGoalKg: 71.5,
      bmi: 22.6,
      bodyFat: latest.bodyFat,
      waterMl: latest.waterMl,
      waterGoalMl: 2_500,
      caloriesIn: latest.caloriesIn,
    },
    trends,
    activities: makeActivities(selectedDate),
    insights: [
      {
        id: 'activity',
        tone: 'mint',
        title: latestSteps >= 10_000 ? 'Step goal reached' : 'Movement recorded',
        body: latestSteps >= 10_000
          ? 'You exceeded your personal goal of 10,000 steps.'
          : `You are ${(10_000 - latestSteps).toLocaleString('en-US')} steps away from your personal goal.`,
      },
      {
        id: 'sleep',
        tone: 'violet',
        title: 'Sleep duration',
        body: `${latestSleepMinutes < 480 ? `${480 - latestSleepMinutes} minutes short` : 'Goal reached'} compared with your personal goal.`,
      },
      {
        id: 'heart',
        tone: 'blue',
        title: 'Resting heart rate detected',
        body: `${latest.restingHeartRate} bpm: compare it with your personal trend, not with a single day.`,
      },
    ],
    sync: {
      endpointCount: 25,
      successCount: 25,
      errors: [],
      rateLimitRemaining: 126,
    },
  }
}

// Real archives only carry intraday for days that were actually synced; the
// demo mirrors that by only generating intraday for the most recent window.
const HISTORY_INTRADAY_DAYS = 30

export function createDemoHistory(selectedDate = localIso()): History {
  const trends = makeTrends(selectedDate)
  const total = trends.length
  let maxHeartRate: number | null = null

  const days: HistoryDay[] = trends.map((trend, index) => {
    const hasIntraday = index >= total - HISTORY_INTRADAY_DAYS
    const heartIntraday = hasIntraday ? makeHeartSeriesForDay(index, trend) : null
    const heartZoneMinutes = hasIntraday ? makeZoneMinutesForDay(index, trend) : null
    if (trend.heartRateMax !== null && (maxHeartRate === null || trend.heartRateMax > maxHeartRate)) {
      maxHeartRate = trend.heartRateMax
    }
    return {
      date: trend.date,
      trend,
      heartIntraday,
      heartZoneMinutes,
    }
  })

  return { days, maxHeartRate }
}

export { localIso }
