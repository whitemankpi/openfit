import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { EncryptedStore } from './storage.js'

const require = createRequire(import.meta.url)
const googleHealth = require(path.resolve('electron/google-health-service.cjs'))
const fitbitLegacy = require(path.resolve('electron/fitbit-legacy-service.cjs'))
const healthCache = require(path.resolve('electron/health-cache.cjs'))

type ProviderName = 'google-health' | 'fitbit-legacy'
type Config = { provider: ProviderName; clientId: string; clientSecret: string; redirectUri: string }
type Credentials = { config: Config; token: any; googleFitToken?: any; lastSyncAt: string | null }

const port = Number(process.env.PORT || 3000)
const dataDirectory = process.env.OPENFIT_DATA_DIR || '/data'
const username = requiredEnv('OPENFIT_USERNAME')
const password = requiredEnv('OPENFIT_PASSWORD')
const appBaseUrl = validBaseUrl(requiredEnv('APP_BASE_URL'))
const callbackUrl = new URL('/oauth/callback', appBaseUrl).toString()
const store = new EncryptedStore(dataDirectory, requiredEnv('OPENFIT_ENCRYPTION_KEY'))
const providers = { 'google-health': googleHealth, 'fitbit-legacy': fitbitLegacy } as const
const defaultCredentials: Credentials = {
  config: { provider: 'google-health', clientId: '', clientSecret: '', redirectUri: callbackUrl },
  token: null,
  lastSyncAt: null,
}
const distDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist')

let syncInFlight: Promise<any> | null = null
let oauth: { state: string; verifier: string; createdAt: number; purpose: 'health' | 'google-fit' } | null = null
let oauthResult: { sequence: number; ok: boolean; error?: string } = { sequence: 0, ok: false }

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function validBaseUrl(value: string): URL {
  const parsed = new URL(value)
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !localHttp) throw new Error('APP_BASE_URL must use HTTPS (HTTP is allowed only on localhost).')
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('APP_BASE_URL must be an origin without a path.')
  return parsed
}

function credentials(): Credentials {
  const value = store.read<Credentials>('credentials.json', defaultCredentials)
  return { ...value, config: { ...value.config, redirectUri: callbackUrl } }
}

function publicStatus() {
  const value = credentials()
  const healthTokenHasFitScope = String(value.token?.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read')
  const healthTokenUsable = value.config.provider !== 'google-health' || !healthTokenHasFitScope
  return {
    isElectron: false,
    configured: Boolean(value.config.clientId && value.config.redirectUri && (value.config.provider !== 'google-health' || value.config.clientSecret)),
    connected: healthTokenUsable && Boolean(value.token?.access_token || value.token?.refresh_token),
    clientId: value.config.clientId || '',
    redirectUri: callbackUrl,
    hasClientSecret: Boolean(value.config.clientSecret),
    storageEncrypted: true,
    lastSyncAt: value.lastSyncAt,
    provider: value.config.provider,
    googleFitAuthorized: value.config.provider === 'google-health'
      && String(value.googleFitToken?.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read'),
  }
}

function providerFor(value: Credentials) {
  return providers[value.config.provider] || providers['google-health']
}

function validateConfig(input: any, previous: Config): Config {
  const provider: ProviderName = input?.provider === 'fitbit-legacy' ? 'fitbit-legacy' : 'google-health'
  const clientId = String(input?.clientId || '').trim()
  const sameProvider = previous.provider === provider
  const clientSecret = String(input?.clientSecret || (sameProvider ? previous.clientSecret : '') || '').trim()
  if (!clientId) throw new Error('Enter the OAuth Client ID.')
  if (provider === 'google-health' && !clientSecret) throw new Error('Google Health requires the Cloud project Client Secret.')
  return { provider, clientId, clientSecret, redirectUri: callbackUrl }
}

async function accessCredentials(): Promise<Credentials> {
  const value = credentials()
  if (!value.token) throw new Error('Account not connected.')
  if (value.config.provider === 'google-health' && String(value.token.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read')) {
    throw new Error('Reauthorize Google Health to replace the legacy combined OAuth token.')
  }
  if (Number(value.token.expiresAt || 0) > Date.now() + 90_000 && value.token.access_token) return value
  const token = await providerFor(value).refreshAccessToken(value.config, value.token)
  const updated = { ...value, token }
  store.write('credentials.json', updated)
  return updated
}

async function googleFitCredentials(value: Credentials): Promise<Credentials> {
  if (!value.googleFitToken) throw new Error('Google Fit step access is not connected.')
  if (Number(value.googleFitToken.expiresAt || 0) > Date.now() + 90_000 && value.googleFitToken.access_token) return value
  const googleFitToken = await googleHealth.refreshAccessToken(value.config, value.googleFitToken)
  const updated = { ...value, googleFitToken }
  store.write('credentials.json', updated)
  return updated
}

function localIsoDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function validSyncDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > localIsoDate()) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

async function syncData(date: string): Promise<any> {
  const archive = store.read<any>('health-cache.json', null)
  if (date < localIsoDate()) {
    const cached = healthCache.cachedDay(archive, date)
    if (cached) return { ...cached, cacheHit: true }
  }
  let value = await accessCredentials()
  const service = providerFor(value)
  let googleFitAccessToken: string | null = null
  if (service.provider === 'google-health' && value.googleFitToken) {
    try {
      value = await googleFitCredentials(value)
      googleFitAccessToken = value.googleFitToken.access_token
    } catch (error) {
      console.warn('Google Fit token refresh failed; syncing Google Health without Fit steps.', error)
    }
  }
  const payload = await service.syncData(value.token.access_token, date, () => undefined, googleFitAccessToken)
  const total = Number(payload.requestStats?.total || 0)
  const succeeded = Number(payload.requestStats?.succeeded || 0)
  const successfulKeys = Array.isArray(payload.requestStats?.successfulKeys) ? payload.requestStats.successfulKeys : []
  const measurementKeys = service.provider === 'google-health'
    ? ['stepsDaily', 'caloriesDaily', 'distanceDaily', 'activeMinutesDaily', 'zoneMinutesDaily', 'weightDaily', 'waterDaily', 'nutritionDaily', 'heartIntradayRaw', 'restingHeartRaw', 'hrvRaw', 'spo2Raw', 'spo2SamplesRaw', 'breathingRaw', 'skinTemperatureRaw', 'cardioRaw', 'sleepRaw', 'activitiesRaw', 'ecgRaw', 'irnAlertsRaw', 'glucoseRaw']
    : ['activity', 'stepsIntraday', 'stepsTrend', 'caloriesTrend', 'heartIntraday', 'heartTrend', 'sleep', 'sleepTrend', 'bodyWeight', 'bodyFat', 'food', 'water', 'breathing', 'hrv', 'spo2', 'skinTemperature', 'coreTemperature', 'cardio', 'ecg', 'irregularRhythmAlerts', 'bloodGlucose', 'activities']
  const hasMeasurements = successfulKeys.some((key: string) => measurementKeys.includes(key))
  if (!total || succeeded < Math.max(3, Math.ceil(total * 0.2)) || !hasMeasurements) throw new Error('The sync did not return enough valid sources. The previous cache was preserved.')
  store.write('health-cache.json', healthCache.storeDay(archive, payload))
  store.write('credentials.json', { ...value, lastSyncAt: payload.generatedAt })
  return payload
}

function authorized(request: IncomingMessage): boolean {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const actual = request.headers.authorization || ''
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function oauthPage(ok: boolean, message: string): string {
  const safe = message.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
  return `<!doctype html><meta charset="utf-8"><title>OpenFit</title><style>body{font-family:system-ui;background:#101112;color:#f4f7f7;display:grid;place-items:center;min-height:100vh}main{max-width:32rem;text-align:center;padding:2rem}</style><main><h1>${ok ? 'Account connected' : 'Connection failed'}</h1><p>${safe}</p><script>setTimeout(()=>window.close(),1500)</script></main>`
}

async function handleOAuthCallback(url: URL, response: ServerResponse): Promise<void> {
  const current = oauth
  oauth = null
  try {
    if (!current || Date.now() - current.createdAt > 5 * 60_000 || url.searchParams.get('state') !== current.state) throw new Error('Invalid or expired OAuth state.')
    const code = url.searchParams.get('code')
    if (!code) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Authorization canceled.')
    const value = credentials()
    const service = providerFor(value)
    const token = await service.exchangeAuthorizationCode(value.config, code, current.verifier)
    if (current.purpose === 'health' && service.provider === 'google-health'
      && String(token.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read')) {
      throw new Error('Google returned a combined token. Revoke OpenFit access in your Google Account and try again.')
    }
    store.write('credentials.json', current.purpose === 'google-fit'
      ? { ...value, googleFitToken: token, lastSyncAt: null }
      : { ...value, token, lastSyncAt: null })
    oauthResult = { sequence: oauthResult.sequence + 1, ok: true }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(oauthPage(true, 'Return to OpenFit.'))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OAuth failed.'
    oauthResult = { sequence: oauthResult.sequence + 1, ok: false, error: message }
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
    response.end(oauthPage(false, message))
  }
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false
  if (request.method === 'GET' && url.pathname === '/api/status') return json(response, 200, publicStatus()), true
  if (request.method === 'GET' && url.pathname === '/api/cache') return json(response, 200, healthCache.latestDay(store.read('health-cache.json', null))), true
  if (request.method === 'GET' && url.pathname === '/api/archive') return json(response, 200, healthCache.normalizeArchive(store.read('health-cache.json', null))), true
  if (request.method === 'GET' && url.pathname === '/api/oauth/status') return json(response, 200, oauthResult), true
  if (request.method === 'POST' && url.pathname === '/api/config') {
    const value = credentials()
    const config = validateConfig(await body(request), value.config)
    const changed = ['provider', 'clientId', 'clientSecret'].some((key) => String((value.config as any)[key] || '') !== String((config as any)[key] || ''))
    store.write('credentials.json', { ...value, config, token: changed ? null : value.token, googleFitToken: changed ? null : value.googleFitToken, lastSyncAt: changed ? null : value.lastSyncAt })
    if (changed) store.delete('health-cache.json')
    return json(response, 200, publicStatus()), true
  }
  if (request.method === 'POST' && url.pathname === '/api/oauth/start') {
    const value = credentials()
    if (!publicStatus().configured) throw new Error('Complete the OAuth configuration first.')
    const service = providerFor(value)
    const pkce = service.createPkce()
    oauth = { state: crypto.randomBytes(24).toString('hex'), verifier: pkce.verifier, createdAt: Date.now(), purpose: 'health' }
    return json(response, 200, { ok: true, url: service.createAuthorizationUrl(value.config, oauth.state, pkce), sequence: oauthResult.sequence }), true
  }
  if (request.method === 'POST' && url.pathname === '/api/google-fit/oauth/start') {
    const value = credentials()
    if (!publicStatus().connected || value.config.provider !== 'google-health') throw new Error('Connect Google Health before authorizing Google Fit.')
    const pkce = googleHealth.createPkce()
    oauth = { state: crypto.randomBytes(24).toString('hex'), verifier: pkce.verifier, createdAt: Date.now(), purpose: 'google-fit' }
    return json(response, 200, { ok: true, url: googleHealth.createGoogleFitAuthorizationUrl(value.config, oauth.state, pkce), sequence: oauthResult.sequence }), true
  }
  if (request.method === 'POST' && url.pathname === '/api/disconnect') {
    const value = credentials()
    try { await providerFor(value).revokeToken(value.token, value.config) } catch (error) { console.warn('Remote token revocation failed.', error) }
    try { await googleHealth.revokeToken(value.googleFitToken, value.config) } catch (error) { console.warn('Google Fit token revocation failed.', error) }
    store.write('credentials.json', { ...value, token: null, googleFitToken: null, lastSyncAt: null })
    store.delete('health-cache.json')
    oauth = null
    return json(response, 200, publicStatus()), true
  }
  if (request.method === 'POST' && url.pathname === '/api/sync') {
    const date = String((await body(request)).date || '')
    if (!validSyncDate(date)) throw new Error('Invalid sync date.')
    if (syncInFlight) throw new Error('A sync is already in progress.')
    syncInFlight = syncData(date)
    try { return json(response, 200, await syncInFlight), true } finally { syncInFlight = null }
  }
  if (request.method === 'POST' && url.pathname === '/api/google-fit/audit') {
    const date = String((await body(request)).date || localIsoDate())
    if (!validSyncDate(date)) throw new Error('Invalid audit date.')
    let value = await accessCredentials()
    const service = providerFor(value)
    if (service.provider !== 'google-health' || typeof service.auditGoogleFitSteps !== 'function') throw new Error('Google Fit audit requires the Google Health provider.')
    value = await googleFitCredentials(value)
    return json(response, 200, await service.auditGoogleFitSteps(value.token.access_token, value.googleFitToken.access_token, date)), true
  }
  if (request.method === 'GET' && url.pathname === '/api/export') {
    const archive = healthCache.normalizeArchive(store.read('health-cache.json', null))
    if (!Object.keys(archive.days).length) throw new Error('There is no real data to export yet.')
    response.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="openfit-archive-${archive.lastDate || 'health'}.json"` })
    response.end(JSON.stringify(archive, null, 2))
    return true
  }
  json(response, 404, { error: 'Not found.' })
  return true
}

function staticFile(response: ServerResponse, pathname: string): void {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1)
  let file = path.resolve(distDirectory, requested)
  if (!file.startsWith(`${distDirectory}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDirectory, 'index.html')
  const extension = path.extname(file)
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' }
  response.writeHead(200, { 'content-type': types[extension] || 'application/octet-stream', 'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
  fs.createReadStream(file).pipe(response)
}

const server = http.createServer(async (request, response) => {
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'")
  const url = new URL(request.url || '/', appBaseUrl)
  if (url.pathname === '/healthz') return json(response, 200, { ok: true })
  if (url.pathname === '/oauth/callback') return void await handleOAuthCallback(url, response)
  if (!authorized(request)) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="OpenFit", charset="UTF-8"' })
    return response.end('Authentication required.')
  }
  try {
    if (await api(request, response, url)) return
    staticFile(response, url.pathname)
  } catch (error) {
    console.error(error)
    json(response, 400, { error: error instanceof Error ? error.message : 'Request failed.' })
  }
})

server.listen(port, '0.0.0.0', () => console.log(`OpenFit web listening on port ${port}`))
