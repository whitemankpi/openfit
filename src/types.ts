export type PageId = 'today' | 'activity' | 'health' | 'sleep' | 'body' | 'devices'

export type DataSource = 'demo' | 'fitbit' | 'google-health' | 'cache'

export type HealthProvider = 'google-health' | 'fitbit-legacy'

export interface TimePoint {
  time: string
  value: number
}

export interface TrendPoint {
  date: string
  label: string
  steps: number | null
  calories: number | null
  distanceKm: number | null
  floors: number | null
  activeMinutes: number | null
  zoneMinutes: number | null
  sedentaryMinutes: number | null
  restingHeartRate: number | null
  /**
   * Intraday-derived aggregates. Only the day a payload was synced for carries
   * them; other days in the same payload's window have daily rollups only.
   */
  heartRateAvg: number | null
  heartRateMin: number | null
  heartRateMax: number | null
  sleepingHeartRate: number | null
  hrvMs: number | null
  breathingRate: number | null
  spo2: number | null
  skinTemperature: number | null
  coreTemperature: number | null
  cardioScore: number | null
  sleepMinutes: number | null
  sleepScore: number | null
  sleepEfficiency: number | null
  sleepDeepMinutes: number | null
  sleepRemMinutes: number | null
  sleepLightMinutes: number | null
  sleepAwakeMinutes: number | null
  sleepLatencyMinutes: number | null
  sleepMidTime: number | null
  weight: number | null
  bodyFat: number | null
  waterMl: number | null
  caloriesIn: number | null
}

export interface ActivityItem {
  id: string
  name: string
  date: string
  time: string
  durationMinutes: number
  calories: number | null
  distanceKm: number | null
  averageHeartRate: number | null
  zoneMinutes: number | null
  steps: number | null
  averagePaceSecondsPerMeter: number | null
  heartZoneMinutes: HeartZoneMinutes | null
  sources: string[]
}

export type SleepStageKey = 'deep' | 'light' | 'rem' | 'wake'

export interface HeartZoneMinutes {
  light: number | null
  moderate: number | null
  vigorous: number | null
  peak: number | null
}

export interface SleepStage {
  name: 'Deep' | 'Light' | 'REM' | 'Awake'
  key: SleepStageKey
  minutes: number
  color: string
}

export interface SleepStageSegment {
  startTime: string
  endTime: string
  type: SleepStageKey
}

export interface SleepStageCounts {
  deep: number | null
  light: number | null
  rem: number | null
  wake: number | null
}

export interface DashboardData {
  source: DataSource
  selectedDate: string
  generatedAt: string
  profile: {
    displayName: string
    avatar: string | null
    memberSince: string | null
    timezone: string | null
  }
  device: {
    id: string | null
    name: string
    type: string | null
    battery: string | null
    batteryLevel: number | null
    lastSyncTime: string | null
    firmware: string | null
    features: string[]
  } | null
  activity: {
    steps: number | null
    stepsSource: 'google-fit' | 'google-health' | 'google-fit+health' | 'fitbit' | null
    stepsGoal: number | null
    calories: number | null
    caloriesGoal: number | null
    distanceKm: number | null
    distanceGoalKm: number | null
    floors: number | null
    floorsGoal: number | null
    activeMinutes: number | null
    lightActiveMinutes: number | null
    moderateActiveMinutes: number | null
    vigorousActiveMinutes: number | null
    activeMinutesGoal: number | null
    zoneMinutes: number | null
    sedentaryMinutes: number | null
    stepsIntraday: TimePoint[]
    caloriesIntraday: TimePoint[]
  }
  health: {
    currentHeartRate: number | null
    restingHeartRate: number | null
    heartRateMin: number | null
    heartRateMax: number | null
    heartRateIntraday: TimePoint[]
    hrvMs: number | null
    hrvDeepSleepRmssdMs: number | null
    hrvEntropy: number | null
    nonRemHeartRate: number | null
    breathingRate: number | null
    spo2: number | null
    spo2Min: number | null
    spo2Max: number | null
    skinTemperature: number | null
    skinNightlyTemperatureCelsius: number | null
    skinBaselineTemperatureCelsius: number | null
    skinTemperatureStddev30dCelsius: number | null
    coreTemperature: number | null
    vo2Max: string | null
    cardioScore: number | null
    ecgClassification: string | null
    bloodGlucoseMgDl: number | null
    irregularRhythmAlerts: number | null
  }
  sleep: {
    totalMinutes: number | null
    goalMinutes: number | null
    score: number | null
    efficiency: number | null
    startTime: string | null
    endTime: string | null
    stages: SleepStage[]
    stageTimeline: SleepStageSegment[]
    stageTransitions: SleepStageCounts
    minutesToFallAsleep: number | null
    minutesAfterWakeUp: number | null
    timeInBed: number | null
    minutesAwake: number | null
    minutesInSleepPeriod: number | null
    deepPercent: number | null
    remPercent: number | null
    lightPercent: number | null
    /**
     * Midpoint of the night in minutes relative to local midnight, normalised to
     * (-720, 720] so that 23:00 reads as -60 rather than 1380. Comparable across
     * nights, which is what bedtime consistency needs.
     */
    midSleepTime: number | null
  }
  body: {
    weightKg: number | null
    weightGoalKg: number | null
    bmi: number | null
    bodyFat: number | null
    waterMl: number | null
    waterGoalMl: number | null
    caloriesIn: number | null
  }
  trends: TrendPoint[]
  activities: ActivityItem[]
  insights: Array<{
    id: string
    tone: 'mint' | 'blue' | 'amber' | 'violet'
    title: string
    body: string
  }>
  sync: {
    endpointCount: number
    successCount: number
    errors: Array<{ key: string; message: string }>
    rateLimitRemaining: number | null
  }
}

export interface RawFitbitPayload {
  source: 'fitbit' | 'google-health'
  date: string
  generatedAt: string
  cacheHit?: boolean
  endpoints: Record<string, unknown>
  errors: Array<{ key: string; message: string; status?: number }>
  rateLimit: {
    limit: number | null
    remaining: number | null
    resetSeconds: number | null
  }
  requestStats?: {
    total: number
    succeeded: number
    successfulKeys?: string[]
  }
}

export interface RawHealthArchive {
  version: number
  lastDate: string | null
  days: Record<string, RawFitbitPayload>
  /** Days a backfill asked for and the provider had nothing to give. */
  attempted?: string[]
}

export interface FitbitAuthStatus {
  isElectron: boolean
  configured: boolean
  connected: boolean
  clientId: string
  redirectUri: string
  hasClientSecret: boolean
  storageEncrypted: boolean
  lastSyncAt: string | null
  provider: HealthProvider
  googleFitAuthorized: boolean
}

export interface FitbitConfigInput {
  provider: HealthProvider
  clientId: string
  clientSecret?: string
  redirectUri: string
}

export interface BackfillProgress {
  /** The day being imported, or null once the run has finished. */
  date: string | null
  completed: number
  total: number
}

export interface BackfillResult {
  requested: number
  imported: number
  /** Days the provider had no data for; they are not retried. */
  empty: number
  failed: number
  canceled: boolean
}

export interface FitbitBridge {
  getStatus: () => Promise<FitbitAuthStatus>
  saveConfig: (config: FitbitConfigInput) => Promise<FitbitAuthStatus>
  connect: () => Promise<{ ok: boolean; message?: string }>
  connectGoogleFit: () => Promise<{ ok: boolean; message?: string }>
  disconnect: () => Promise<FitbitAuthStatus>
  sync: (date: string) => Promise<RawFitbitPayload>
  getCachedData: () => Promise<RawFitbitPayload | null>
  getCachedArchive: () => Promise<RawHealthArchive>
  backfillHistory: (days: number) => Promise<BackfillResult>
  cancelBackfill: () => Promise<{ canceled: boolean }>
  exportData: () => Promise<{ canceled: boolean; path?: string }>
  openExternal: (url: string) => Promise<void>
  onAuthComplete: (callback: (result: { ok: boolean; error?: string }) => void) => () => void
  onSyncProgress: (callback: (progress: { completed: number; total: number; key: string; date?: string }) => void) => () => void
  onBackfillProgress: (callback: (progress: BackfillProgress) => void) => () => void
  onDataUpdated: (callback: (event: { date: string; generatedAt?: string | null; reason?: string }) => void) => () => void
}

export type AssistantProvider = 'codex' | 'deepseek'

export interface AssistantConfig {
  provider: AssistantProvider
  /** Whether a DeepSeek key is stored. The key itself never leaves the main process. */
  hasApiKey: boolean
}

export interface HealthAssistantStatus {
  /** Which provider this status describes, so the UI never names the wrong one. Null before the first status fetch. */
  provider: AssistantProvider | null
  available: boolean
  connected: boolean
  authenticated: boolean
  version: string | null
  error?: string
}

export type HealthAssistantEvent =
  | { requestId: string; type: 'delta'; delta: string }
  | { requestId: string; type: 'complete'; text?: string }
  | { requestId: string; type: 'error'; message: string }
  | { requestId: string; type: 'cancelled' }
  | { requestId: string; type: 'tool'; name: string; ok: boolean }

export interface HealthAssistantBridge {
  getStatus: () => Promise<HealthAssistantStatus>
  startTurn: (input: {
    requestId: string
    message: string
    healthContext: string
    tools: Array<{ name: string; description: string; schema: Record<string, unknown> }>
    toolNames: string[]
  }) => Promise<{ requestId: string }>
  cancel: (requestId: string) => Promise<void>
  reset: () => Promise<void>
  getConfig: () => Promise<AssistantConfig>
  saveConfig: (input: { provider: AssistantProvider; apiKey?: string }) => Promise<AssistantConfig>
  onEvent: (callback: (event: HealthAssistantEvent) => void) => () => void
  respondToTool: (response: { callId: string; result?: unknown; error?: string }) => Promise<void>
  onToolRequest: (callback: (request: { callId: string; name: string; args: Record<string, unknown> }) => void) => () => void
}
