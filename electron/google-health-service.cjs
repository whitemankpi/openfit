'use strict'

const crypto = require('node:crypto')

const API_BASE = 'https://health.googleapis.com/v4'
const GOOGLE_FIT_API_BASE = 'https://www.googleapis.com/fitness/v1'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const HEALTH_SCOPES = [
  'openid',
  'profile',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.ecg.readonly',
  'https://www.googleapis.com/auth/googlehealth.irn.readonly',
  'https://www.googleapis.com/auth/googlehealth.location.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
]
const GOOGLE_FIT_SCOPES = ['https://www.googleapis.com/auth/fitness.activity.read']

const GOOGLE_FIT_ESTIMATED_STEPS = 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps'

let nextApiRequestAt = 0

function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
}

function base64Url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(48))
  return {
    verifier,
    challenge: base64Url(crypto.createHash('sha256').update(verifier).digest()),
  }
}

function authorizationUrl(config, state, pkce, scopes) {
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'false',
    prompt: 'consent',
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

function createAuthorizationUrl(config, state, pkce) {
  return authorizationUrl(config, state, pkce, HEALTH_SCOPES)
}

function createGoogleFitAuthorizationUrl(config, state, pkce) {
  return authorizationUrl(config, state, pkce, GOOGLE_FIT_SCOPES)
}

async function tokenRequest(parameters) {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google OAuth ha risposto ${response.status}.`)
  }
  return {
    ...payload,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  }
}

function exchangeAuthorizationCode(config, code, verifier) {
  return tokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  })
}

async function refreshAccessToken(config, token) {
  if (!token.refresh_token) throw new Error('The Google refresh token is unavailable: reconnect the account.')
  const refreshed = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  })
  return { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token }
}

async function revokeToken(token) {
  const value = token?.refresh_token || token?.access_token
  if (!value) return
  const response = await fetchWithTimeout(REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: value }),
  })
  if (!response.ok) throw new Error(`Google did not confirm token revocation (${response.status}).`)
}

async function waitForApiSlot() {
  const now = Date.now()
  const slot = Math.max(now, nextApiRequestAt)
  nextApiRequestAt = slot + 225
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now))
}

async function request(path, accessToken, { method = 'GET', body, retryCount = 0 } = {}) {
  await waitForApiSlot()
  const response = await fetchWithTimeout(path.startsWith('http') ? path : `${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status === 429 && retryCount < 2) {
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30_000, retryAfter * 1000)
      : Math.min(30_000, 1_100 * (2 ** retryCount))
    await new Promise((resolve) => setTimeout(resolve, delay))
    return request(path, accessToken, { method, body, retryCount: retryCount + 1 })
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Google Health ha risposto ${response.status}.`)
    error.status = response.status
    throw error
  }
  return payload
}

function shiftIso(value, days) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days, 12))
  return date.toISOString().slice(0, 10)
}

function civilDateTime(value, endOfDay = false) {
  const [year, month, day] = value.split('-').map(Number)
  // Match the REST example exactly. Although the schema describes a
  // closed-open interval, the current v4 endpoint expects the final civil day
  // at 23:59:59 instead of the following day at midnight.
  return {
    date: { year, month, day },
    time: endOfDay
      ? { hours: 23, minutes: 59, seconds: 59, nanos: 0 }
      : { hours: 0, minutes: 0, seconds: 0, nanos: 0 },
  }
}

function dateFromCivil(value) {
  const date = value?.date || value
  if (!date?.year || !date?.month || !date?.day) return null
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function timeFromCivil(value) {
  const time = value?.time || value
  if (typeof time?.hours !== 'number') return null
  return `${String(time.hours).padStart(2, '0')}:${String(time.minutes || 0).padStart(2, '0')}`
}

function durationSeconds(value) {
  if (typeof value !== 'string') return 0
  const parsed = Number(value.replace(/s$/, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function dataFilter(type, recordType, start, end) {
  if (recordType === 'daily') return `${type.replaceAll('-', '_')}.date >= "${start}" AND ${type.replaceAll('-', '_')}.date < "${end}"`
  if (recordType === 'sleep') return `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${end}"`
  if (recordType === 'ecg') return `electrocardiogram.interval.start_time >= "${start}T00:00:00Z"`
  if (recordType === 'sample') return `${type.replaceAll('-', '_')}.sample_time.civil_time >= "${start}" AND ${type.replaceAll('-', '_')}.sample_time.civil_time < "${end}"`
  return `${type.replaceAll('-', '_')}.interval.civil_start_time >= "${start}" AND ${type.replaceAll('-', '_')}.interval.civil_start_time < "${end}"`
}

async function listData(accessToken, type, recordType, start, end, dataSourceFamily = 'all-sources', operation = 'reconcile') {
  const baseParams = {
    filter: dataFilter(type, recordType, start, end),
    pageSize: type === 'sleep' || type === 'exercise' ? '25' : '10000',
  }
  if (operation === 'reconcile') baseParams.dataSourceFamily = `users/me/dataSourceFamilies/${dataSourceFamily}`
  const endpoint = operation === 'list' ? 'dataPoints' : 'dataPoints:reconcile'
  const merged = { dataPoints: [] }
  let pageToken = ''
  let pageCount = 0
  do {
    const params = new URLSearchParams(baseParams)
    if (pageToken) params.set('pageToken', pageToken)
    const page = await request(`/users/me/dataTypes/${type}/${endpoint}?${params}`, accessToken)
    if (Array.isArray(page.dataPoints)) merged.dataPoints.push(...page.dataPoints)
    pageToken = page.nextPageToken || ''
    pageCount += 1
    if (pageCount >= 100 && pageToken) throw new Error(`Google Health ha restituito troppe pagine per ${type}.`)
  } while (pageToken)
  return merged
}

function dailyRollup(accessToken, type, start, end) {
  return request(`/users/me/dataTypes/${type}/dataPoints:dailyRollUp`, accessToken, {
    method: 'POST',
    body: {
      range: {
        start: civilDateTime(start),
        end: civilDateTime(shiftIso(end, -1), true),
      },
      windowSizeDays: 1,
    },
  })
}

function zonedDateParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

function zonedMidnightMillis(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number)
  const target = Date.UTC(year, month - 1, day)
  let candidate = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateParts(candidate, timeZone)
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    candidate += target - represented
  }
  return candidate
}

function fitStepValue(bucket) {
  const points = (bucket?.dataset || []).flatMap((dataset) => dataset?.point || [])
  let present = false
  let total = 0
  for (const point of points) {
    for (const value of point?.value || []) {
      const parsed = numeric(value?.intVal ?? value?.fpVal)
      if (parsed === null) continue
      present = true
      total += parsed
    }
  }
  return { present, value: present ? total : null }
}

function fitPayloadHasSteps(payload) {
  return (payload?.bucket || []).some((bucket) => fitStepValue(bucket).present)
}

function googleFitAggregate(accessToken, startTimeMillis, endTimeMillis, bucketByTime, aggregateBy) {
  return request(`${GOOGLE_FIT_API_BASE}/users/me/dataset:aggregate`, accessToken, {
    method: 'POST',
    body: { startTimeMillis, endTimeMillis, aggregateBy: [aggregateBy], bucketByTime },
  })
}

async function preferredGoogleFitAggregate(accessToken, startTimeMillis, endTimeMillis, bucketByTime) {
  let estimated = null
  try {
    estimated = await googleFitAggregate(accessToken, startTimeMillis, endTimeMillis, bucketByTime, {
      dataSourceId: GOOGLE_FIT_ESTIMATED_STEPS,
    })
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error
  }
  if (fitPayloadHasSteps(estimated)) return { mode: 'estimated-steps', payload: estimated }
  const aggregate = await googleFitAggregate(accessToken, startTimeMillis, endTimeMillis, bucketByTime, {
    dataTypeName: 'com.google.step_count.delta',
  })
  return { mode: 'all-step-sources', payload: aggregate }
}

async function syncGoogleFitSteps(accessToken, selectedDate, timeZone = 'UTC') {
  const trendStart = shiftIso(selectedDate, -13)
  const dayAfter = shiftIso(selectedDate, 1)
  const trendStartMillis = zonedMidnightMillis(trendStart, timeZone)
  const selectedStartMillis = zonedMidnightMillis(selectedDate, timeZone)
  const dayAfterMillis = zonedMidnightMillis(dayAfter, timeZone)
  const [daily, hourly] = await Promise.all([
    preferredGoogleFitAggregate(accessToken, trendStartMillis, dayAfterMillis, {
      period: { type: 'day', value: 1, timeZoneId: timeZone },
    }),
    preferredGoogleFitAggregate(accessToken, selectedStartMillis, dayAfterMillis, { durationMillis: 60 * 60 * 1000 }),
  ])
  return { timeZone, daily, hourly }
}

function fitDailyMap(raw) {
  const timeZone = raw?.timeZone || 'UTC'
  return new Map((raw?.daily?.payload?.bucket || []).map((bucket) => {
    const start = numeric(bucket.startTimeMillis)
    const result = fitStepValue(bucket)
    return [start === null ? null : zonedDateParts(start, timeZone).date, result.value]
  }).filter(([date, value]) => date && value !== null))
}

function fitHourlyPoints(raw, selectedDate) {
  const timeZone = raw?.timeZone || 'UTC'
  return (raw?.hourly?.payload?.bucket || []).map((bucket) => {
    const start = numeric(bucket.startTimeMillis)
    const result = fitStepValue(bucket)
    if (start === null || !result.present) return null
    const local = zonedDateParts(start, timeZone)
    if (local.date !== selectedDate) return null
    return { time: local.time, value: result.value }
  }).filter(Boolean).sort((left, right) => left.time.localeCompare(right.time))
}

function hourlyStepMap(points) {
  const result = new Map()
  for (const point of points) {
    const hour = String(point?.time || '').slice(0, 2)
    const value = numeric(point?.value)
    if (!/^\d{2}$/.test(hour) || value === null) continue
    result.set(hour, (result.get(hour) || 0) + value)
  }
  return result
}

function mergeHourlySteps(googleHealthPoints, googleFitPoints) {
  if (!googleHealthPoints.length) return { points: googleFitPoints, healthContributes: false, fitContributes: googleFitPoints.length > 0 }
  if (!googleFitPoints.length) return { points: googleHealthPoints, healthContributes: true, fitContributes: false }

  const health = hourlyStepMap(googleHealthPoints)
  const fit = hourlyStepMap(googleFitPoints)
  let healthContributes = false
  let fitContributes = false
  const points = [...new Set([...health.keys(), ...fit.keys()])].sort().map((hour) => {
    const healthValue = health.get(hour)
    const fitValue = fit.get(hour)
    if (fitValue === undefined || (healthValue !== undefined && healthValue > fitValue)) healthContributes = true
    else fitContributes = true
    return { time: `${hour}:00`, value: Math.max(healthValue ?? 0, fitValue ?? 0) }
  })
  return { points, healthContributes, fitContributes }
}

function fitBucketSummary(payload, timeZone) {
  return (payload?.bucket || []).map((bucket) => {
    const start = numeric(bucket.startTimeMillis)
    const result = fitStepValue(bucket)
    if (start === null || !result.present) return null
    const local = zonedDateParts(start, timeZone)
    return { date: local.date, time: local.time, steps: result.value }
  }).filter(Boolean)
}

async function auditGoogleFitSteps(healthAccessToken, fitAccessToken, selectedDate) {
  const settings = await request('/users/me/settings', healthAccessToken)
  const timeZone = settings?.timeZone || 'UTC'
  const startTimeMillis = zonedMidnightMillis(selectedDate, timeZone)
  const endTimeMillis = zonedMidnightMillis(shiftIso(selectedDate, 1), timeZone)
  const sourcePayload = await request(`${GOOGLE_FIT_API_BASE}/users/me/dataSources?dataTypeName=com.google.step_count.delta`, fitAccessToken)
  const aggregate = async (aggregateBy, bucketByTime) => {
    try {
      return await googleFitAggregate(fitAccessToken, startTimeMillis, endTimeMillis, bucketByTime, aggregateBy)
    } catch (error) {
      return { error: { status: error.status ?? null, message: error.message || 'Google Fit request failed.' } }
    }
  }
  const modes = [
    ['estimated-steps', { dataSourceId: GOOGLE_FIT_ESTIMATED_STEPS }],
    ['all-step-sources', { dataTypeName: 'com.google.step_count.delta' }],
  ]
  const results = {}
  await Promise.all(modes.map(async ([mode, aggregateBy]) => {
    const [daily, hourly] = await Promise.all([
      aggregate(aggregateBy, { period: { type: 'day', value: 1, timeZoneId: timeZone } }),
      aggregate(aggregateBy, { durationMillis: 60 * 60 * 1000 }),
    ])
    results[mode] = {
      daily: daily.error || fitBucketSummary(daily, timeZone),
      hourly: hourly.error || fitBucketSummary(hourly, timeZone).filter((item) => item.date === selectedDate),
    }
  }))
  return {
    date: selectedDate,
    timeZone,
    sources: (sourcePayload?.dataSource || []).map((source) => ({
      streamId: source.dataStreamId || null,
      streamName: source.dataStreamName || null,
      app: source.application?.name || null,
      device: [source.device?.manufacturer, source.device?.model].filter(Boolean).join(' ') || null,
      type: source.type || null,
    })),
    results,
  }
}

async function syncGoogleHealthData(accessToken, selectedDate, onProgress = () => {}, googleFitAccessToken = null) {
  const trendStart = shiftIso(selectedDate, -13)
  const dayAfter = shiftIso(selectedDate, 1)
  const ecgStart = shiftIso(selectedDate, -90)
  const jobs = [
    ['identity', () => request('/users/me/identity', accessToken)],
    ['profileRaw', () => request('/users/me/profile', accessToken)],
    ['settingsRaw', () => request('/users/me/settings', accessToken)],
    ['devicesRaw', () => request('/users/me/pairedDevices?pageSize=100', accessToken)],
    ['userInfo', () => request('https://www.googleapis.com/oauth2/v3/userinfo', accessToken)],
    ...(googleFitAccessToken ? [['googleFitSteps', async () => {
      const settings = await request('/users/me/settings', accessToken)
      return syncGoogleFitSteps(googleFitAccessToken, selectedDate, settings?.timeZone || 'UTC')
    }]] : []),
    ['stepsDaily', () => dailyRollup(accessToken, 'steps', trendStart, dayAfter)],
    ['caloriesDaily', () => dailyRollup(accessToken, 'total-calories', trendStart, dayAfter)],
    ['distanceDaily', () => dailyRollup(accessToken, 'distance', trendStart, dayAfter)],
    ['floorsDaily', () => dailyRollup(accessToken, 'floors', trendStart, dayAfter)],
    ['activeMinutesDaily', () => dailyRollup(accessToken, 'active-minutes', trendStart, dayAfter)],
    ['zoneMinutesDaily', () => dailyRollup(accessToken, 'active-zone-minutes', trendStart, dayAfter)],
    ['sedentaryDaily', () => dailyRollup(accessToken, 'sedentary-period', trendStart, dayAfter)],
    ['weightDaily', () => dailyRollup(accessToken, 'weight', trendStart, dayAfter)],
    ['fatDaily', () => dailyRollup(accessToken, 'body-fat', trendStart, dayAfter)],
    ['waterDaily', () => dailyRollup(accessToken, 'hydration-log', trendStart, dayAfter)],
    ['nutritionDaily', () => dailyRollup(accessToken, 'nutrition-log', trendStart, dayAfter)],
    ['coreTemperatureDaily', () => dailyRollup(accessToken, 'core-body-temperature', trendStart, dayAfter)],
    ['stepsIntradayRaw', () => listData(accessToken, 'steps', 'interval', selectedDate, dayAfter, 'google-wearables')],
    ['heartIntradayRaw', () => listData(accessToken, 'heart-rate', 'sample', selectedDate, dayAfter, 'all-sources')],
    ['restingHeartRaw', () => listData(accessToken, 'daily-resting-heart-rate', 'daily', trendStart, dayAfter)],
    ['hrvRaw', () => listData(accessToken, 'daily-heart-rate-variability', 'daily', trendStart, dayAfter)],
    ['spo2Raw', () => listData(accessToken, 'daily-oxygen-saturation', 'daily', trendStart, dayAfter)],
    ['spo2SamplesRaw', () => listData(accessToken, 'oxygen-saturation', 'sample', trendStart, dayAfter)],
    ['breathingRaw', () => listData(accessToken, 'daily-respiratory-rate', 'daily', trendStart, dayAfter)],
    ['skinTemperatureRaw', () => listData(accessToken, 'daily-sleep-temperature-derivations', 'daily', trendStart, dayAfter)],
    ['cardioRaw', () => listData(accessToken, 'daily-vo2-max', 'daily', trendStart, dayAfter)],
    ['sleepRaw', () => listData(accessToken, 'sleep', 'sleep', trendStart, dayAfter, 'google-wearables')],
    ['activitiesRaw', () => listData(accessToken, 'exercise', 'session', trendStart, dayAfter)],
    ['activitySourcesRaw', () => listData(accessToken, 'exercise', 'session', trendStart, dayAfter, 'all-sources', 'list')],
    ['ecgRaw', () => listData(accessToken, 'electrocardiogram', 'ecg', ecgStart, dayAfter, 'all-sources', 'list')],
    ['irnProfileRaw', () => request('/users/me/irnProfile', accessToken)],
    ['irnAlertsRaw', () => listData(accessToken, 'irregular-rhythm-notification', 'session', trendStart, dayAfter, 'all-sources', 'list')],
    ['glucoseRaw', () => listData(accessToken, 'blood-glucose', 'sample', trendStart, dayAfter)],
  ]
  const endpoints = {}
  const errors = []
  let completed = 0

  await Promise.all(jobs.map(async ([key, run]) => {
    try {
      endpoints[key] = await run()
    } catch (error) {
      errors.push({ key, message: error.message || 'Source unavailable', status: error.status })
    } finally {
      completed += 1
      onProgress({ completed, total: jobs.length, key })
    }
  }))

  if (errors.some((error) => error.status === 401)) {
    throw new Error('The Google Health authorization is no longer valid. Reconnect the account.')
  }

  return {
    source: 'google-health',
    date: selectedDate,
    generatedAt: new Date().toISOString(),
    endpoints: translateGoogleHealth(endpoints, selectedDate),
    errors,
    rateLimit: { limit: 300, remaining: null, resetSeconds: 60 },
    requestStats: { total: jobs.length, succeeded: Object.keys(endpoints).length, successfulKeys: Object.keys(endpoints) },
  }
}

function rollupPoints(payload) {
  return Array.isArray(payload?.rollupDataPoints) ? payload.rollupDataPoints : []
}

function dataPoints(payload) {
  return Array.isArray(payload?.dataPoints) ? payload.dataPoints : []
}

function dailyMap(payload, extractor) {
  return new Map(rollupPoints(payload).map((point) => [dateFromCivil(point.civilStartTime), extractor(point)]).filter(([date]) => date))
}

function dailyRecordMap(payload, key, extractor) {
  return new Map(dataPoints(payload).map((point) => {
    const record = point[key]
    return [dateFromCivil(record?.date), extractor(record)]
  }).filter(([date]) => date))
}

function oxygenSampleMap(payload) {
  const grouped = new Map()
  for (const point of dataPoints(payload)) {
    const record = point.oxygenSaturation
    const date = dateFromCivil(record?.sampleTime?.civilTime)
      || record?.sampleTime?.time?.slice?.(0, 10)
    const percentage = numeric(record?.percentage)
    if (!date || percentage === null || percentage < 0 || percentage > 100) continue
    const values = grouped.get(date) || []
    values.push(percentage)
    grouped.set(date, values)
  }
  return new Map([...grouped].map(([date, values]) => [date, {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    lowerBound: Math.min(...values),
    upperBound: Math.max(...values),
  }]))
}

function selected(map, date) {
  return map.get(date) ?? null
}

function localDateAndTime(now = new Date()) {
  return {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  }
}

function numeric(value, transform = (number) => number) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? transform(parsed) : null
}

const APPLICATION_LABELS = [
  [/kingsmith|xiaojin/i, 'WalkingPad'],
  [/wahoofitness|wahoo/i, 'Wahoo Fitness'],
  [/whoop/i, 'WHOOP'],
  [/magene/i, 'Magene'],
  [/fitbit/i, 'Fitbit'],
  [/google\.android\.apps\.fitness/i, 'Google Fit'],
]

function deviceSourceLabel(device) {
  const displayName = String(device?.displayName || device?.model || '').trim()
  const manufacturer = String(device?.manufacturer || '').trim()
  if (displayName && manufacturer && !displayName.toLowerCase().includes(manufacturer.toLowerCase())) {
    return `${manufacturer} ${displayName}`
  }
  return displayName || manufacturer || null
}

function applicationSourceLabel(application) {
  const identity = String(application?.packageName || application?.bundleId || '').trim()
  return APPLICATION_LABELS.find(([pattern]) => pattern.test(identity))?.[1] || null
}

function activitySourceLabel(dataSource) {
  if (!dataSource || typeof dataSource !== 'object') return null
  const application = applicationSourceLabel(dataSource.application)
  const device = deviceSourceLabel(dataSource.device)
  if (application && device && application !== device) return `${application} · ${device}`
  if (application || device) return application || device
  if (dataSource.platform === 'FITBIT') return 'Fitbit'
  if (dataSource.platform === 'HEALTH_CONNECT') return 'Health Connect'
  if (dataSource.platform === 'GOOGLE_WEB_API') return 'Google Health'
  return null
}

function exerciseInterval(point) {
  const exercise = point?.exercise || {}
  const start = Date.parse(exercise.interval?.startTime || '')
  const end = Date.parse(exercise.interval?.endTime || '')
  return {
    start,
    end,
    type: String(exercise.exerciseType || ''),
    name: String(exercise.displayName || '').trim().toLowerCase(),
  }
}

function matchingActivitySources(activityPoint, rawPoints) {
  const activity = exerciseInterval(activityPoint)
  if (!Number.isFinite(activity.start)) return []
  const matches = rawPoints.filter((point) => {
    const candidate = exerciseInterval(point)
    if (!Number.isFinite(candidate.start)) return false
    const startDelta = Math.abs(activity.start - candidate.start)
    const overlaps = Number.isFinite(activity.end) && Number.isFinite(candidate.end)
      && Math.min(activity.end, candidate.end) > Math.max(activity.start, candidate.start)
    const sameType = activity.type && candidate.type && activity.type === candidate.type
    const sameName = activity.name && candidate.name && activity.name === candidate.name
    return (overlaps && (sameType || sameName)) || (startDelta <= 2 * 60_000 && (sameType || sameName))
  })

  const labels = [
    activitySourceLabel(activityPoint?.dataSource),
    ...matches.map((point) => activitySourceLabel(point?.dataSource)),
  ].filter(Boolean)

  return [...new Set(labels)].sort((left, right) => {
    const rank = (label) => label === 'Fitbit' ? 2 : label === 'Health Connect' || label === 'Google Health' ? 1 : 0
    return rank(left) - rank(right) || left.localeCompare(right)
  })
}

function sleepStageKey(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'awake' || type === 'restless') return 'wake'
  if (type === 'asleep') return 'light'
  return ['deep', 'light', 'rem', 'wake'].includes(type) ? type : null
}

function toLegacySleep(point) {
  const sleep = point.sleep || {}
  const summary = sleep.summary || {}
  const stageSummaries = summary.stagesSummary || []
  const hasDetailedStages = stageSummaries.some((stage) => ['LIGHT', 'DEEP', 'REM'].includes(String(stage.type || '').toUpperCase()))
  const uniqueStageSummaries = stageSummaries.reduce((result, stage) => {
    const rawType = String(stage.type || '').toLowerCase()
    if (!rawType) return result
    const previous = result[rawType] || { minutes: 0, count: null }
    const count = numeric(stage.count)
    result[rawType] = {
      // Reconciled responses can repeat the same aggregate. Keep the largest
      // value per raw type before merging compatible classic-sleep buckets.
      minutes: Math.max(previous.minutes, numeric(stage.minutes) ?? 0),
      count: count === null ? previous.count : Math.max(previous.count ?? 0, count),
    }
    return result
  }, {})
  const stageMap = Object.entries(uniqueStageSummaries).reduce((result, [rawType, values]) => {
    // ASLEEP is the aggregate of LIGHT/DEEP/REM when detailed stages exist.
    if (rawType === 'asleep' && hasDetailedStages) return result
    const key = sleepStageKey(rawType)
    if (!key) return result
    const previous = result[key] || { minutes: 0, count: null }
    result[key] = {
      minutes: previous.minutes + values.minutes,
      count: values.count === null ? previous.count : (previous.count ?? 0) + values.count,
    }
    return result
  }, {})
  const stageTimeline = (Array.isArray(sleep.stages) ? sleep.stages : []).map((stage) => {
    const level = sleepStageKey(stage.type)
    if (!level || !stage.startTime || !stage.endTime) return null
    const seconds = (new Date(stage.endTime) - new Date(stage.startTime)) / 1000
    return {
      dateTime: stage.startTime,
      endTime: stage.endTime,
      level,
      seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : null,
    }
  }).filter(Boolean)
  const asleep = numeric(summary.minutesAsleep) ?? 0
  const period = numeric(summary.minutesInSleepPeriod)
  const endCivil = sleep.interval?.civilEndTime
  const dateOfSleep = dateFromCivil(endCivil) || sleep.interval?.endTime?.slice(0, 10)
  return {
    logId: point.dataPointName ?? point.name,
    dateOfSleep,
    isMainSleep: sleep.metadata?.nap !== true,
    minutesAsleep: asleep,
    minutesAwake: numeric(summary.minutesAwake),
    minutesToFallAsleep: numeric(summary.minutesToFallAsleep),
    minutesAfterWakeUp: numeric(summary.minutesAfterWakeUp),
    timeInBed: period,
    efficiency: period && period > 0 ? Math.round(asleep / period * 100) : null,
    startTime: sleep.interval?.startTime || null,
    endTime: sleep.interval?.endTime || null,
    levels: { summary: stageMap, data: stageTimeline },
  }
}

function translateGoogleHealth(raw, selectedDate, now = new Date()) {
  const current = localDateAndTime(now)
  const isFutureTimeToday = (time) => selectedDate === current.date && time > current.time
  const googleHealthSteps = dailyMap(raw.stepsDaily, (point) => numeric(point.steps?.countSum))
  const googleFitSteps = fitDailyMap(raw.googleFitSteps)
  const steps = new Map(googleHealthSteps)
  for (const [date, value] of googleFitSteps) {
    const healthValue = steps.get(date)
    steps.set(date, healthValue === undefined || healthValue === null ? value : Math.max(healthValue, value))
  }
  const calories = dailyMap(raw.caloriesDaily, (point) => numeric(point.totalCalories?.kcalSum))
  const distance = dailyMap(raw.distanceDaily, (point) => numeric(point.distance?.millimetersSum, (value) => value / 1_000_000))
  const floors = dailyMap(raw.floorsDaily, (point) => numeric(point.floors?.countSum))
  const activeMinutes = dailyMap(raw.activeMinutesDaily, (point) => {
    if (!point.activeMinutes) return null
    const levels = point.activeMinutes?.activeMinutesRollupByActivityLevel || []
    return Object.fromEntries(levels.map((level) => [level.activityLevel, Number(level.activeMinutesSum || 0)]))
  })
  const zoneMinutes = dailyMap(raw.zoneMinutesDaily, (point) => point.activeZoneMinutes ? Object.values(point.activeZoneMinutes).reduce((sum, value) => sum + Number(value || 0), 0) : null)
  const sedentary = dailyMap(raw.sedentaryDaily, (point) => point.sedentaryPeriod?.durationSum === undefined ? null : durationSeconds(point.sedentaryPeriod.durationSum) / 60)
  const weights = dailyMap(raw.weightDaily, (point) => numeric(point.weight?.weightGramsAvg, (value) => value / 1000))
  const bodyFat = dailyMap(raw.fatDaily, (point) => numeric(point.bodyFat?.bodyFatPercentageAvg))
  const water = dailyMap(raw.waterDaily, (point) => numeric(point.hydrationLog?.amountConsumed?.millilitersSum))
  const nutrition = dailyMap(raw.nutritionDaily, (point) => numeric(point.nutritionLog?.energy?.kcalSum))
  const coreTemperature = dailyMap(raw.coreTemperatureDaily, (point) => numeric(point.coreBodyTemperature?.temperatureCelsiusAvg))
  const restingHeart = dailyRecordMap(raw.restingHeartRaw, 'dailyRestingHeartRate', (record) => numeric(record?.beatsPerMinute))
  const hrv = dailyRecordMap(raw.hrvRaw, 'dailyHeartRateVariability', (record) => ({
    averageMs: numeric(record?.averageHeartRateVariabilityMilliseconds ?? record?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
    deepSleepRmssdMs: numeric(record?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
    entropy: numeric(record?.entropy),
    nonRemHeartRate: numeric(record?.nonRemHeartRateBeatsPerMinute),
  }))
  const dailySpo2 = dailyRecordMap(raw.spo2Raw, 'dailyOxygenSaturation', (record) => ({
    average: numeric(record?.averagePercentage),
    lowerBound: numeric(record?.lowerBoundPercentage),
    upperBound: numeric(record?.upperBoundPercentage),
  }))
  const sampleSpo2 = oxygenSampleMap(raw.spo2SamplesRaw)
  const spo2 = new Map(sampleSpo2)
  for (const [date, summary] of dailySpo2) {
    const samples = sampleSpo2.get(date)
    spo2.set(date, {
      average: summary.average ?? samples?.average ?? null,
      lowerBound: summary.lowerBound ?? samples?.lowerBound ?? null,
      upperBound: summary.upperBound ?? samples?.upperBound ?? null,
    })
  }
  const breathing = dailyRecordMap(raw.breathingRaw, 'dailyRespiratoryRate', (record) => numeric(record?.breathsPerMinute))
  const skinTemp = dailyRecordMap(raw.skinTemperatureRaw, 'dailySleepTemperatureDerivations', (record) => {
    const nightly = numeric(record?.nightlyTemperatureCelsius)
    const baseline = numeric(record?.baselineTemperatureCelsius)
    return {
      relative: nightly === null || baseline === null ? null : Number((nightly - baseline).toFixed(2)),
      nightly,
      baseline,
      stddev30d: numeric(record?.relativeNightlyStddev30dCelsius),
    }
  })
  const cardio = dailyRecordMap(raw.cardioRaw, 'dailyVo2Max', (record) => numeric(record?.vo2Max))
  const selectedActivityLevels = selected(activeMinutes, selectedDate)
  const todayActivityLevels = selectedActivityLevels || {}
  const sleepRecords = dataPoints(raw.sleepRaw).map(toLegacySleep)
  const selectedSleepRecords = sleepRecords.filter((item) => item.dateOfSleep === selectedDate)
  const selectedSleep = selectedSleepRecords.find((item) => item.isMainSleep)
    || selectedSleepRecords.sort((a, b) => b.minutesAsleep - a.minutesAsleep)[0]
    || null
  const allDates = [...new Set([
    ...steps.keys(),
    ...calories.keys(),
    ...distance.keys(),
    ...floors.keys(),
    ...activeMinutes.keys(),
    ...zoneMinutes.keys(),
    ...sedentary.keys(),
    ...restingHeart.keys(),
    ...hrv.keys(),
    ...spo2.keys(),
    ...breathing.keys(),
    ...skinTemp.keys(),
    ...coreTemperature.keys(),
    ...cardio.keys(),
    ...weights.keys(),
    ...bodyFat.keys(),
    ...water.keys(),
    ...nutrition.keys(),
    ...sleepRecords.map((item) => item.dateOfSleep).filter(Boolean),
  ])].sort()
  const sleepByDate = new Map(sleepRecords
    .filter((item) => item.dateOfSleep && item.isMainSleep !== false)
    .map((item) => [item.dateOfSleep, item]))
  const activeMinutesFor = (date) => {
    const levels = activeMinutes.get(date)
    if (!levels) return null
    const moderate = numeric(levels.MODERATE)
    const vigorous = numeric(levels.VIGOROUS)
    if (moderate === null && vigorous === null) return null
    return (moderate || 0) + (vigorous || 0)
  }
  const googleHealthStepPoints = dataPoints(raw.stepsIntradayRaw).map((point) => {
    const record = point.steps || {}
    const date = dateFromCivil(record.interval?.civilStartTime)
    if (date && date !== selectedDate) return null
    const time = timeFromCivil(record.interval?.civilStartTime) || record.interval?.startTime?.slice(11, 16)
    if (time && isFutureTimeToday(time)) return null
    return { time, value: Number(record.count || 0) }
  }).filter((point) => point?.time).sort((a, b) => a.time.localeCompare(b.time))
  const googleFitStepPoints = fitHourlyPoints(raw.googleFitSteps, selectedDate)
  const mergedSteps = mergeHourlySteps(googleHealthStepPoints, googleFitStepPoints)
  const stepPoints = mergedSteps.points
  if (stepPoints.length) {
    const intradayTotal = stepPoints.reduce((sum, point) => sum + point.value, 0)
    steps.set(selectedDate, Math.max(steps.get(selectedDate) ?? 0, intradayTotal))
  }
  const heartPoints = dataPoints(raw.heartIntradayRaw).map((point) => {
    const record = point.heartRate || {}
    const date = dateFromCivil(record.sampleTime?.civilTime)
    if (date && date !== selectedDate) return null
    const time = timeFromCivil(record.sampleTime?.civilTime) || record.sampleTime?.physicalTime?.slice(11, 16)
    if (time && isFutureTimeToday(time)) return null
    return { time, value: Number(record.beatsPerMinute || 0) }
  }).filter((point) => point?.time && point.value).sort((a, b) => a.time.localeCompare(b.time))
  const profile = raw.profileRaw || {}
  const settings = raw.settingsRaw || {}
  const userInfo = raw.userInfo || {}
  const membershipDate = dateFromCivil(profile.membershipStartDate)
  const devices = (raw.devicesRaw?.pairedDevices || []).map((device) => ({
    id: String(device.name || '').split('/').at(-1),
    type: device.deviceType,
    deviceVersion: device.deviceVersion,
    battery: device.batteryStatus,
    batteryLevel: device.batteryLevel,
    lastSyncTime: device.lastSyncTime,
    features: device.features,
  }))
  const todaySteps = selected(steps, selectedDate)
  const healthDaily = googleHealthSteps.get(selectedDate)
  const fitDaily = googleFitSteps.get(selectedDate)
  const healthContributes = mergedSteps.healthContributes
    || (healthDaily !== undefined && (fitDaily === undefined || healthDaily > fitDaily) && healthDaily === todaySteps)
  const fitContributes = mergedSteps.fitContributes
    || (fitDaily !== undefined && (healthDaily === undefined || fitDaily >= healthDaily) && fitDaily === todaySteps)
  const stepsSource = healthContributes && fitContributes
    ? { provider: 'google-fit+health', mode: `${raw.googleFitSteps?.daily?.mode || raw.googleFitSteps?.hourly?.mode || 'google-fit'}+reconciled` }
    : fitContributes
      ? { provider: 'google-fit', mode: raw.googleFitSteps?.daily?.mode || raw.googleFitSteps?.hourly?.mode || null }
      : healthContributes || todaySteps !== null
        ? { provider: 'google-health', mode: 'reconciled' }
        : null
  const todayCalories = selected(calories, selectedDate)
  const todayDistance = selected(distance, selectedDate)
  const todayFloors = selected(floors, selectedDate)
  const todayZone = selected(zoneMinutes, selectedDate)
  const todaySedentary = selected(sedentary, selectedDate)
  const currentWeight = selected(weights, selectedDate) ?? [...weights.values()].filter((value) => value !== null).at(-1) ?? null
  const currentFat = selected(bodyFat, selectedDate) ?? [...bodyFat.values()].filter((value) => value !== null).at(-1) ?? null
  const currentHrv = selected(hrv, selectedDate)
  const currentSpo2 = selected(spo2, selectedDate)
  const currentBreathing = selected(breathing, selectedDate)
  const currentTemp = selected(skinTemp, selectedDate)
  const currentCardio = selected(cardio, selectedDate)
  const currentCoreTemperature = selected(coreTemperature, selectedDate)
  const ecgUpperBound = `${shiftIso(selectedDate, 1)}T00:00:00Z`
  const ecgReadings = dataPoints(raw.ecgRaw)
    .filter((point) => {
      const startTime = point.electrocardiogram?.interval?.startTime
      return !startTime || startTime < ecgUpperBound
    })
    .map((point) => ({
      ...(point.electrocardiogram || {}),
      readingTime: point.electrocardiogram?.interval?.startTime,
    }))
  const activitySourcePoints = dataPoints(raw.activitySourcesRaw)
  const activities = dataPoints(raw.activitiesRaw).map((point) => {
    const exercise = point.exercise || {}
    const summary = exercise.metricsSummary || {}
    const start = exercise.interval?.startTime || ''
    const end = exercise.interval?.endTime || ''
    const intervalDuration = (new Date(end) - new Date(start)) / 1000
    const duration = durationSeconds(exercise.activeDuration) || (Number.isFinite(intervalDuration) ? Math.max(0, intervalDuration) : 0)
    const zoneDurations = summary.heartRateZoneDurations || {}
    const zoneMinutes = (value) => value === undefined || value === null ? null : durationSeconds(value) / 60
    const heartZoneMinutes = Object.keys(zoneDurations).length ? {
      light: zoneMinutes(zoneDurations.lightTime),
      moderate: zoneMinutes(zoneDurations.moderateTime),
      vigorous: zoneMinutes(zoneDurations.vigorousTime),
      peak: zoneMinutes(zoneDurations.peakTime),
    } : null
    return {
      logId: point.dataPointName ?? point.name,
      activityName: exercise.displayName || String(exercise.exerciseType || 'Activity').replaceAll('_', ' '),
      startTime: start,
      duration: duration * 1000,
      calories: summary.caloriesKcal,
      distance: numeric(summary.distanceMillimeters, (value) => value / 1_000_000),
      averageHeartRate: summary.averageHeartRateBeatsPerMinute,
      steps: numeric(summary.steps),
      averagePaceSecondsPerMeter: numeric(summary.averagePaceSecondsPerMeter),
      heartZoneMinutes,
      activeZoneMinutes: { totalMinutes: summary.activeZoneMinutes },
      sources: matchingActivitySources(point, activitySourcePoints),
    }
  })

  return {
    profile: { user: { displayName: userInfo.name || 'Atleta', avatar640: userInfo.picture || null, memberSince: membershipDate, timezone: settings.timeZone || null } },
    devices,
    activity: { summary: {
      steps: todaySteps,
      caloriesOut: todayCalories,
      distances: [{ activity: 'total', distance: todayDistance }],
      floors: todayFloors,
      lightlyActiveMinutes: selectedActivityLevels === null ? null : numeric(todayActivityLevels.LIGHT) ?? 0,
      fairlyActiveMinutes: selectedActivityLevels === null ? null : numeric(todayActivityLevels.MODERATE) ?? 0,
      veryActiveMinutes: selectedActivityLevels === null ? null : numeric(todayActivityLevels.VIGOROUS) ?? 0,
      activeZoneMinutes: { totalMinutes: todayZone },
      sedentaryMinutes: todaySedentary,
    } },
    stepsSource,
    activityGoals: { goals: {} },
    stepsIntraday: { 'activities-steps-intraday': { dataset: stepPoints } },
    caloriesIntraday: { 'activities-calories-intraday': { dataset: [] } },
    heartIntraday: {
      'activities-heart': [{ dateTime: selectedDate, value: { restingHeartRate: selected(restingHeart, selectedDate) } }],
      'activities-heart-intraday': { dataset: heartPoints },
    },
    sleep: { sleep: selectedSleep ? [selectedSleep] : [] },
    sleepTrend: { sleep: sleepRecords },
    sleepGoal: { goal: {} },
    stepsTrend: { 'activities-steps': allDates.map((date) => ({ dateTime: date, value: steps.get(date) })) },
    caloriesTrend: { 'activities-calories': allDates.map((date) => ({ dateTime: date, value: calories.get(date) })) },
    heartTrend: { 'activities-heart': allDates.map((date) => ({ dateTime: date, value: { restingHeartRate: restingHeart.get(date) } })) },
    metricTrends: { values: allDates.map((date) => ({
      dateTime: date,
      distanceKm: distance.get(date) ?? null,
      floors: floors.get(date) ?? null,
      activeMinutes: activeMinutesFor(date),
      zoneMinutes: zoneMinutes.get(date) ?? null,
      sedentaryMinutes: sedentary.get(date) ?? null,
      hrvMs: hrv.get(date)?.averageMs ?? null,
      breathingRate: breathing.get(date) ?? null,
      spo2: spo2.get(date)?.average ?? null,
      skinTemperature: skinTemp.get(date)?.relative ?? null,
      coreTemperature: coreTemperature.get(date) ?? null,
      cardioScore: cardio.get(date) ?? null,
      sleepEfficiency: sleepByDate.get(date)?.efficiency ?? null,
      bodyFat: bodyFat.get(date) ?? null,
      waterMl: water.get(date) ?? null,
      caloriesIn: nutrition.get(date) ?? null,
    })) },
    bodyWeight: { weight: [...weights].filter(([, weight]) => weight !== null).map(([date, weight]) => ({ date, weight, bmi: null })) },
    bodyFat: { fat: [...bodyFat].filter(([, fat]) => fat !== null).map(([date, fat]) => ({ date, fat })) },
    weightGoal: { goal: {} },
    water: { summary: { water: selected(water, selectedDate) } },
    waterGoal: { goal: {} },
    food: { summary: { calories: selected(nutrition, selectedDate) } },
    breathing: { br: currentBreathing === null ? [] : [{ dateTime: selectedDate, value: { breathingRate: currentBreathing } }] },
    hrv: { hrv: currentHrv === null ? [] : [{ dateTime: selectedDate, value: {
      dailyRmssd: currentHrv.averageMs,
      deepRmssd: currentHrv.deepSleepRmssdMs,
      entropy: currentHrv.entropy,
      nonRemHeartRate: currentHrv.nonRemHeartRate,
    } }] },
    spo2: currentSpo2 === null ? {} : { dateTime: selectedDate, value: {
      avg: currentSpo2.average,
      min: currentSpo2.lowerBound,
      max: currentSpo2.upperBound,
    } },
    skinTemperature: { tempSkin: currentTemp === null ? [] : [{ dateTime: selectedDate, value: {
      nightlyRelative: currentTemp.relative,
      nightlyTemperatureCelsius: currentTemp.nightly,
      baselineTemperatureCelsius: currentTemp.baseline,
      relativeNightlyStddev30dCelsius: currentTemp.stddev30d,
    } }] },
    coreTemperature: { tempCore: currentCoreTemperature === null ? [] : [{ dateTime: selectedDate, value: { coreTemperature: currentCoreTemperature } }] },
    cardio: { cardioScore: currentCardio === null ? [] : [{ dateTime: selectedDate, value: { vo2Max: String(currentCardio) } }] },
    ecg: { ecgReadings },
    activities: { activities },
    identity: raw.identity,
    ...(raw.irnProfileRaw !== undefined || raw.irnAlertsRaw !== undefined
      ? { irregularRhythm: { profile: raw.irnProfileRaw, alerts: raw.irnAlertsRaw } }
      : {}),
    bloodGlucose: raw.glucoseRaw,
  }
}

module.exports = {
  provider: 'google-health',
  scopes: HEALTH_SCOPES,
  googleFitScopes: GOOGLE_FIT_SCOPES,
  createPkce,
  createAuthorizationUrl,
  createGoogleFitAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  syncData: syncGoogleHealthData,
  auditGoogleFitSteps,
  __test: { translateGoogleHealth, dateFromCivil, durationSeconds, fitStepValue, zonedMidnightMillis, activitySourceLabel, matchingActivitySources },
}
