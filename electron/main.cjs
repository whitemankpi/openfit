'use strict'

const { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const googleHealth = require('./google-health-service.cjs')
const fitbitLegacy = require('./fitbit-legacy-service.cjs')
const healthCache = require('./health-cache.cjs')
const { createCodexService, resolveCodexBinary } = require('./assistant-codex.cjs')
const { createDeepSeekService } = require('./assistant-deepseek.cjs')
const assistantConfigLogic = require('./assistant-config.cjs')
const { createDispatcher, DEFAULT_TIMEOUT_MS } = require('./assistant-dispatch.cjs')

app.commandLine.appendSwitch('lang', 'en-US')

const APP_ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png')
const APP_DISPLAY_NAME = 'OpenFit'
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:42813/oauth/callback'
// safeStorage keys are tied to the historical app name, so initialize Electron
// with the legacy identity before the secure storage backend is created.
const LEGACY_USER_DATA_NAME = 'pulseboard-fitbit-desktop'
app.setName(LEGACY_USER_DATA_NAME)
const PROVIDERS = {
  'google-health': googleHealth,
  'fitbit-legacy': fitbitLegacy,
}

let mainWindow = null
let oauthServer = null
let oauthTimeout = null
let credentialFile = null
let cacheFile = null
let assistantConfigFile = null
let syncInFlight = null
let backfillCanceled = false
let codexService = null
let assistantProvider = null
let assistantRequestId = null
// The exact service instance handling the in-flight turn, so a config save
// (which rebuilds assistantProvider) can never leave cancel/reset targeting a
// freshly-constructed instance instead of the one actually streaming.
let assistantInFlight = null

// CommonJS twin of parseAssistantToolRequest/stripAssistantToolRequest in
// src/lib/health-assistant.ts. main.cjs cannot import that TypeScript module
// (the alternative was duplicating the whole normalisation stack instead of
// just this directive), so the regex and rejection rules are hand-kept in
// step with the source of truth. If they ever drift, it would show up as:
// the renderer's own openfit:tool directive test suite
// (src/lib/health-assistant.test.ts) staying green while a directive that it
// accepts (or rejects) behaves the other way here — e.g. a Codex response
// containing a directive that the renderer would parse gets silently ignored
// by runCodexToolRounds below, or vice versa. There is no automated guard
// against that; a change to one regex must be mirrored in the other by hand.
const TOOL_DIRECTIVE_PATTERN = /\s*<!--\s*openfit:tool\s+(\{[\s\S]*?\})\s*-->\s*/g

function parseToolDirective(text) {
  TOOL_DIRECTIVE_PATTERN.lastIndex = 0
  const match = TOOL_DIRECTIVE_PATTERN.exec(String(text || ''))
  if (!match) return null
  try {
    const value = JSON.parse(match[1])
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name) return null
    if (value.args !== undefined && (typeof value.args !== 'object' || value.args === null || Array.isArray(value.args))) {
      return null
    }
    return { name, args: value.args || {} }
  } catch {
    return null
  }
}

function stripToolDirective(text) {
  TOOL_DIRECTIVE_PATTERN.lastIndex = 0
  return String(text || '').replace(TOOL_DIRECTIVE_PATTERN, '').trim()
}

const MAX_DIRECTIVE_ROUNDS = 8

/**
 * Codex asks for a tool by writing a directive rather than through the
 * protocol, so a tool call costs a full turn. The dispatcher's budget still
 * applies; this bound stops a model that keeps asking.
 */
async function runCodexToolRounds(assistant, requestId, firstText, dispatcher, onDelta) {
  let text = firstText
  for (let round = 0; round < MAX_DIRECTIVE_ROUNDS; round += 1) {
    const request = parseToolDirective(text)
    if (!request) return text
    const outcome = await dispatcher.call(request.name, request.args)
    if (assistantRequestId !== requestId) return text
    sendAssistantEvent({ requestId, type: 'tool', name: request.name, ok: outcome.ok })
    const followUp = await assistant.startTurn({
      text: `<OPENFIT_TOOL_RESULT tool="${request.name}">\n${JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error })}\n</OPENFIT_TOOL_RESULT>`,
      healthContext: '',
      onDelta,
      onToolCall: async (name, args) => {
        const toolOutcome = await dispatcher.call(name, args)
        if (assistantRequestId === requestId) {
          sendAssistantEvent({ requestId, type: 'tool', name, ok: toolOutcome.ok })
        }
        return toolOutcome
      },
    })
    if (assistantRequestId !== requestId) return text
    text = followUp.text
  }
  return text
}

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function storageEncryptionAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true
  try {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    return false
  }
}

function writeSecure(file, value) {
  if (!storageEncryptionAvailable()) {
    throw new Error('The operating system secure storage is unavailable. Enable it before saving credentials or health data.')
  }
  const serialized = JSON.stringify(value)
  atomicWrite(file, JSON.stringify({ version: 1, encrypted: true, data: safeStorage.encryptString(serialized).toString('base64') }))
}

function readSecure(file, fallback = null) {
  try {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (envelope.encrypted !== true || !storageEncryptionAvailable()) {
      if (envelope.encrypted !== true) deleteIfPresent(file)
      return fallback
    }
    const decoded = safeStorage.decryptString(Buffer.from(envelope.data, 'base64'))
    return JSON.parse(decoded)
  } catch {
    return fallback
  }
}

function deleteIfPresent(file) {
  try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
}

function getCredentials() {
  return readSecure(credentialFile, {
    config: {
      provider: 'google-health',
      clientId: '',
      clientSecret: '',
      redirectUri: DEFAULT_REDIRECT_URI,
    },
    token: null,
    lastSyncAt: null,
  })
}

function saveCredentials(credentials) {
  writeSecure(credentialFile, credentials)
}

function getAssistantConfig() {
  return assistantConfigLogic.normalizeConfig(readSecure(assistantConfigFile, null))
}

function publicAssistantConfig() {
  return assistantConfigLogic.toPublicConfig(getAssistantConfig())
}

/** Resolves the configured provider, rebuilding it after a settings change. */
function activeAssistant() {
  if (assistantProvider) return assistantProvider
  const config = getAssistantConfig()
  assistantProvider = config.provider === 'deepseek'
    ? (config.apiKey ? createDeepSeekService({ apiKey: config.apiKey }) : null)
    : codexService
  return assistantProvider
}

function publicStatus() {
  const credentials = getCredentials()
  const config = credentials.config || {}
  const provider = PROVIDERS[config.provider] ? config.provider : 'google-health'
  const needsSecret = provider === 'google-health'
  const healthTokenHasFitScope = String(credentials.token?.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read')
  return {
    isElectron: true,
    configured: Boolean(config.clientId && config.redirectUri && (!needsSecret || config.clientSecret)),
    connected: (provider !== 'google-health' || !healthTokenHasFitScope)
      && Boolean(credentials.token?.access_token || credentials.token?.refresh_token),
    clientId: config.clientId || '',
    redirectUri: config.redirectUri || DEFAULT_REDIRECT_URI,
    hasClientSecret: Boolean(config.clientSecret),
    storageEncrypted: storageEncryptionAvailable(),
    lastSyncAt: credentials.lastSyncAt || null,
    provider,
    googleFitAuthorized: provider === 'google-health'
      && String(credentials.googleFitToken?.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read'),
  }
}

function providerFor(credentials) {
  const provider = credentials.config?.provider || 'google-health'
  const service = PROVIDERS[provider]
  if (!service) throw new Error(`Unsupported health provider: ${provider}`)
  return service
}

function validateConfig(input, previous) {
  const provider = PROVIDERS[input.provider] ? input.provider : 'google-health'
  const clientId = String(input.clientId || '').trim()
  const redirectUri = String(input.redirectUri || DEFAULT_REDIRECT_URI).trim()
  const sameProvider = previous?.provider === provider
  const clientSecret = String(input.clientSecret || (sameProvider ? previous?.clientSecret : '') || '').trim()
  if (!clientId) throw new Error('Enter the OAuth Client ID.')
  if (provider === 'google-health' && !clientSecret) throw new Error('Google Health requires the Cloud project Client Secret.')
  let parsed
  try { parsed = new URL(redirectUri) } catch { throw new Error('The callback URL is invalid.') }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.hash) {
    throw new Error('For the desktop app, use an http://127.0.0.1 loopback callback with a fixed port.')
  }
  return { provider, clientId, clientSecret, redirectUri }
}

function closeOAuthServer() {
  if (oauthTimeout) clearTimeout(oauthTimeout)
  oauthTimeout = null
  if (oauthServer) {
    try { oauthServer.close() } catch { /* server already stopped */ }
  }
  oauthServer = null
}

function oauthPage(success, message) {
  const color = success ? '#5ae4c0' : '#ff7b74'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>OpenFit</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;color:#edf4f5;background:#080c11;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{width:min(420px,calc(100vw - 40px));padding:34px;border:1px solid #ffffff12;border-radius:20px;background:#111820;text-align:center;box-shadow:0 25px 80px #0008}.orb{display:grid;width:58px;height:58px;place-items:center;margin:0 auto 18px;border-radius:50%;color:${color};background:${color}16;font-size:25px}h1{margin:0 0 10px;font-size:22px}p{margin:0;color:#83909b;font-size:13px;line-height:1.55}</style></head><body><main class="card"><div class="orb">${success ? '✓' : '!'}</div><h1>${success ? 'Account connected' : 'Connection failed'}</h1><p>${escapeHtml(message)}<br>You can close this tab and return to OpenFit.</p></main></body></html>`
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}

async function startOAuthFlow(purpose = 'health') {
  if (oauthServer) throw new Error('A connection process is already in progress.')
  const credentials = getCredentials()
  const status = publicStatus()
  if (!status.configured) throw new Error('Complete the OAuth configuration first.')
  const service = providerFor(credentials)
  if (purpose === 'google-fit' && (service.provider !== 'google-health' || !status.connected)) {
    throw new Error('Connect Google Health before authorizing Google Fit.')
  }
  const redirect = new URL(credentials.config.redirectUri)
  const state = crypto.randomBytes(24).toString('hex')
  const pkce = service.createPkce()

  await new Promise((resolve, reject) => {
    oauthServer = http.createServer(async (request, response) => {
      const incoming = new URL(request.url, credentials.config.redirectUri)
      if (incoming.pathname !== redirect.pathname) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const returnedState = incoming.searchParams.get('state')
      const code = incoming.searchParams.get('code')
      const oauthError = incoming.searchParams.get('error')
      if (returnedState !== state) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthPage(false, 'The request security check is invalid.'))
        mainWindow?.webContents.send('fitbit:auth-complete', { ok: false, error: 'Invalid OAuth state.' })
        closeOAuthServer()
        return
      }
      if (oauthError || !code) {
        const message = incoming.searchParams.get('error_description') || oauthError || 'Authorization canceled.'
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthPage(false, message))
        mainWindow?.webContents.send('fitbit:auth-complete', { ok: false, error: message })
        closeOAuthServer()
        return
      }
      try {
        const token = await service.exchangeAuthorizationCode(credentials.config, code, pkce.verifier)
        if (purpose === 'health' && service.provider === 'google-health'
          && String(token.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read')) {
          throw new Error('Google returned a combined token. Revoke OpenFit access in your Google Account and try again.')
        }
        saveCredentials(purpose === 'google-fit'
          ? { ...credentials, googleFitToken: token, lastSyncAt: null }
          : { ...credentials, token, lastSyncAt: null })
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthPage(true, service.provider === 'google-health' ? 'Google Health is ready.' : 'Fitbit legacy is ready.'))
        mainWindow?.webContents.send('fitbit:auth-complete', { ok: true })
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthPage(false, error.message))
        mainWindow?.webContents.send('fitbit:auth-complete', { ok: false, error: error.message })
      } finally {
        closeOAuthServer()
      }
    })
    oauthServer.once('error', (error) => {
      closeOAuthServer()
      reject(error.code === 'EADDRINUSE' ? new Error(`Port ${redirect.port} is already in use.`) : error)
    })
    oauthServer.listen(Number(redirect.port), '127.0.0.1', resolve)
  })

  oauthTimeout = setTimeout(() => {
    mainWindow?.webContents.send('fitbit:auth-complete', { ok: false, error: 'The OAuth session expired.' })
    closeOAuthServer()
  }, 5 * 60_000)

  try {
    const authorizationUrl = purpose === 'google-fit'
      ? service.createGoogleFitAuthorizationUrl(credentials.config, state, pkce)
      : service.createAuthorizationUrl(credentials.config, state, pkce)
    await shell.openExternal(authorizationUrl)
  } catch (error) {
    closeOAuthServer()
    throw error
  }
  return { ok: true }
}

async function validAccessToken(credentials) {
  if (!credentials.token) throw new Error('Account not connected.')
  if (credentials.config?.provider === 'google-health'
    && String(credentials.token.scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/fitness.activity.read')) {
    throw new Error('Reauthorize Google Health to replace the legacy combined OAuth token.')
  }
  if (Number(credentials.token.expiresAt || 0) > Date.now() + 90_000 && credentials.token.access_token) {
    return credentials
  }
  const service = providerFor(credentials)
  const token = await service.refreshAccessToken(credentials.config, credentials.token)
  const updated = { ...credentials, token }
  saveCredentials(updated)
  return updated
}

async function validGoogleFitToken(credentials) {
  if (!credentials.googleFitToken) return credentials
  if (Number(credentials.googleFitToken.expiresAt || 0) > Date.now() + 90_000 && credentials.googleFitToken.access_token) return credentials
  const googleFitToken = await googleHealth.refreshAccessToken(credentials.config, credentials.googleFitToken)
  const updated = { ...credentials, googleFitToken }
  saveCredentials(updated)
  return updated
}

async function syncData(date) {
  const today = localIsoDate()
  const archive = readSecure(cacheFile, null)
  if (date < today) {
    const cached = healthCache.cachedDay(archive, date)
    if (cached) return { ...cached, cacheHit: true }
  }

  let credentials = getCredentials()
  credentials = await validAccessToken(credentials)
  const service = providerFor(credentials)
  let googleFitAccessToken = null
  if (service.provider === 'google-health' && credentials.googleFitToken) {
    try {
      credentials = await validGoogleFitToken(credentials)
      googleFitAccessToken = credentials.googleFitToken.access_token
    } catch (error) {
      console.warn('Google Fit token refresh failed; syncing Google Health without Fit steps.', error)
    }
  }
  const payload = await service.syncData(credentials.token.access_token, date, (progress) => {
    mainWindow?.webContents.send('fitbit:sync-progress', { ...progress, date })
  }, googleFitAccessToken)
  const total = Number(payload.requestStats?.total || 0)
  const succeeded = Number(payload.requestStats?.succeeded || 0)
  const successfulKeys = Array.isArray(payload.requestStats?.successfulKeys) ? payload.requestStats.successfulKeys : []
  const minimumUsefulResponses = Math.max(3, Math.ceil(total * 0.2))
  const measurementKeys = service.provider === 'google-health'
    ? ['stepsDaily', 'caloriesDaily', 'distanceDaily', 'activeMinutesDaily', 'zoneMinutesDaily', 'weightDaily', 'waterDaily', 'nutritionDaily', 'heartIntradayRaw', 'restingHeartRaw', 'hrvRaw', 'spo2Raw', 'breathingRaw', 'skinTemperatureRaw', 'cardioRaw', 'sleepRaw', 'activitiesRaw', 'ecgRaw', 'irnAlertsRaw', 'glucoseRaw']
    : ['activity', 'stepsIntraday', 'stepsTrend', 'caloriesTrend', 'heartIntraday', 'heartTrend', 'sleep', 'sleepTrend', 'bodyWeight', 'bodyFat', 'food', 'water', 'breathing', 'hrv', 'spo2', 'skinTemperature', 'coreTemperature', 'cardio', 'ecg', 'irregularRhythmAlerts', 'bloodGlucose', 'activities']
  const hasMeasurementResponse = successfulKeys.some((key) => measurementKeys.includes(key))
  if (!total || succeeded < minimumUsefulResponses || !hasMeasurementResponse) {
    throw new Error('The sync did not return enough valid sources. The previous cache was preserved.')
  }
  const previous = healthCache.cachedDay(archive, date)
  const changed = !healthCache.sameDayContent(previous, payload)
  if (changed) {
    writeSecure(cacheFile, healthCache.storeDay(archive, payload))
    mainWindow?.webContents.send('fitbit:data-updated', { date, generatedAt: payload.generatedAt, reason: 'manual' })
  }
  credentials.lastSyncAt = payload.generatedAt
  saveCredentials(credentials)
  return payload
}

const BACKFILL_MAX_DAYS = 365

function shiftIsoDate(date, days) {
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(year, month - 1, day + days, 12)
  return localIsoDate(parsed)
}

/**
 * Walks backwards from yesterday filling days the archive never stored.
 *
 * Newest first, because recent history is what the dashboard shows. Today is
 * skipped: it is still changing and the regular sync owns it. Days the provider
 * has nothing for are recorded so a second run does not spend the rate limit
 * asking again.
 */
async function backfillHistory(requestedDays, onProgress) {
  const days = Math.min(Math.max(Math.trunc(Number(requestedDays) || 0), 1), BACKFILL_MAX_DAYS)
  const today = localIsoDate()
  const archive = healthCache.normalizeArchive(readSecure(cacheFile, null))
  const attempted = new Set(archive.attempted)

  const pending = []
  for (let offset = 1; offset <= days; offset += 1) {
    const date = shiftIsoDate(today, -offset)
    if (!archive.days[date] && !attempted.has(date)) pending.push(date)
  }

  const result = { requested: pending.length, imported: 0, empty: 0, failed: 0, canceled: false }
  for (const [index, date] of pending.entries()) {
    if (backfillCanceled) {
      result.canceled = true
      break
    }
    onProgress({ date, completed: index, total: pending.length })
    try {
      await syncData(date)
      result.imported += 1
    } catch (error) {
      // A day with no data and a day that failed to load are different
      // outcomes: only the former is worth remembering as settled.
      const noData = error instanceof Error && error.message.includes('did not return enough valid sources')
      if (noData) {
        writeSecure(cacheFile, healthCache.markAttempted(readSecure(cacheFile, null), date))
        result.empty += 1
      } else {
        result.failed += 1
        console.warn(`Backfill of ${date} failed.`, error)
      }
    }
  }
  onProgress({ date: null, completed: pending.length, total: pending.length })
  return result
}

function developmentUrl() {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return null
  try {
    const parsed = new URL(process.env.VITE_DEV_SERVER_URL)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password) return null
    return parsed
  } catch {
    return null
  }
}

function isTrustedRendererUrl(value) {
  try {
    const parsed = new URL(value)
    const devUrl = developmentUrl()
    if (devUrl) return parsed.origin === devUrl.origin
    if (parsed.protocol !== 'file:') return false
    return path.resolve(fileURLToPath(parsed)) === path.resolve(__dirname, '..', 'dist', 'index.html')
  } catch {
    return false
  }
}

function assertTrustedSender(event) {
  const frame = event.senderFrame
  if (!mainWindow || event.sender !== mainWindow.webContents || !frame || frame !== event.sender.mainFrame || !isTrustedRendererUrl(frame.url)) {
    throw new Error('IPC request rejected: untrusted renderer origin.')
  }
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return handler(...args)
  })
}

function sendAssistantEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('assistant:event', event)
}

function assistantErrorMessage(error) {
  const message = error instanceof Error ? error.message : 'Codex is unavailable right now.'
  return String(message)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600) || 'Codex is unavailable right now.'
}

function validAssistantRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value)
}

function validSyncDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, 12))
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false
  return value <= localIsoDate()
}

function localIsoDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function createWindow() {
  nativeTheme.themeSource = 'dark'
  const devUrl = developmentUrl()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 930,
    minWidth: 960,
    minHeight: 680,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: '#101112',
    title: 'OpenFit',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  if (devUrl) {
    void mainWindow.loadURL(devUrl.toString())
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
    rejectAllPendingToolCalls('The window closed before the tool call finished.')
  })
}

const pendingToolCalls = new Map()
let toolCallSequence = 0

/**
 * Tools run in the renderer because that is where the normalised history and
 * scores already exist; main.cjs is CommonJS and cannot import the TypeScript
 * that builds them. Main stays the only holder of the key and the model stream.
 */
function executeToolInRenderer(name, args) {
  return new Promise((resolve, reject) => {
    if (!mainWindow) {
      reject(new Error('No window is available to execute the tool.'))
      return
    }
    toolCallSequence += 1
    const callId = `tool-${toolCallSequence}`
    // The dispatcher races this promise against its own timeout, so a silent
    // renderer never hangs the model's turn. But that race alone would leave
    // this entry (and its closures) in the map forever if the renderer never
    // answers, so this call carries its own timeout that settles and clears
    // the entry independently of whoever else is watching it.
    const timer = setTimeout(() => {
      pendingToolCalls.delete(callId)
      reject(new Error('The renderer did not answer the tool request in time.'))
    }, DEFAULT_TIMEOUT_MS)
    pendingToolCalls.set(callId, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    mainWindow.webContents.send('assistant:tool-request', { callId, name, args })
  })
}

function rejectAllPendingToolCalls(message) {
  for (const pending of pendingToolCalls.values()) pending.reject(new Error(message))
  pendingToolCalls.clear()
}

function registerIpc() {
  trustedHandle('fitbit:get-status', () => publicStatus())
  trustedHandle('fitbit:get-cached-data', () => healthCache.latestDay(readSecure(cacheFile, null)))
  trustedHandle('fitbit:get-cached-archive', () => healthCache.normalizeArchive(readSecure(cacheFile, null)))
  trustedHandle('fitbit:save-config', (input) => {
    if (syncInFlight) throw new Error('Wait for the sync to finish before changing the configuration.')
    const credentials = getCredentials()
    const config = validateConfig(input || {}, credentials.config)
    const oauthIdentityChanged = ['provider', 'clientId', 'clientSecret', 'redirectUri']
      .some((key) => String(credentials.config?.[key] || '') !== String(config[key] || ''))
    saveCredentials({ ...credentials, config, token: oauthIdentityChanged ? null : credentials.token, googleFitToken: oauthIdentityChanged ? null : credentials.googleFitToken, lastSyncAt: oauthIdentityChanged ? null : credentials.lastSyncAt })
    if (oauthIdentityChanged) deleteIfPresent(cacheFile)
    return publicStatus()
  })
  trustedHandle('fitbit:connect', () => {
    if (syncInFlight) throw new Error('Wait for the sync to finish before reconnecting the account.')
    return startOAuthFlow()
  })
  trustedHandle('fitbit:connect-google-fit', () => {
    if (syncInFlight) throw new Error('Wait for the sync to finish before connecting Google Fit.')
    return startOAuthFlow('google-fit')
  })
  trustedHandle('fitbit:disconnect', async () => {
    if (syncInFlight) throw new Error('Wait for the sync to finish before disconnecting the account.')
    const credentials = getCredentials()
    try {
      await providerFor(credentials).revokeToken(credentials.token, credentials.config)
    } catch (error) {
      console.warn('Remote revocation failed; local credentials will still be deleted.', error)
    }
    try {
      await googleHealth.revokeToken(credentials.googleFitToken, credentials.config)
    } catch (error) {
      console.warn('Google Fit token revocation failed; local credentials will still be deleted.', error)
    }
    try {
      saveCredentials({ ...credentials, token: null, googleFitToken: null, lastSyncAt: null })
    } catch {
      deleteIfPresent(credentialFile)
    }
    deleteIfPresent(cacheFile)
    closeOAuthServer()
    return publicStatus()
  })
  trustedHandle('fitbit:sync', async (date) => {
    if (!validSyncDate(String(date))) throw new Error('Invalid sync date.')
    if (syncInFlight) throw new Error('A sync is already in progress.')
    syncInFlight = syncData(String(date))
    try {
      return await syncInFlight
    } finally {
      syncInFlight = null
    }
  })
  trustedHandle('fitbit:backfill-history', async (days) => {
    if (syncInFlight) throw new Error('A sync is already in progress.')
    backfillCanceled = false
    const run = backfillHistory(days, (progress) => {
      mainWindow?.webContents.send('fitbit:backfill-progress', progress)
    })
    syncInFlight = run
    try {
      return await run
    } finally {
      syncInFlight = null
      backfillCanceled = false
    }
  })
  trustedHandle('fitbit:cancel-backfill', () => {
    backfillCanceled = true
    return { canceled: true }
  })
  trustedHandle('fitbit:export-data', async () => {
    const cached = healthCache.normalizeArchive(readSecure(cacheFile, null))
    if (!Object.keys(cached.days).length) throw new Error('There is no real data to export yet.')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export OpenFit archive',
      defaultPath: `openfit-archive-${cached.lastDate || 'health'}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    fs.writeFileSync(result.filePath, JSON.stringify(cached, null, 2), { mode: 0o600 })
    return { canceled: false, path: result.filePath }
  })
  trustedHandle('fitbit:open-external', (value) => {
    const url = new URL(String(value))
    if (url.protocol !== 'https:') throw new Error('Only HTTPS links are allowed.')
    return shell.openExternal(url.toString())
  })
  trustedHandle('assistant:get-status', () => {
    const assistant = activeAssistant()
    const status = assistant?.getStatus() || {}
    const available = status.available ?? Boolean(resolveCodexBinary())
    const unauthorized = /unauthorized|not logged|sign in|authentication/i.test(String(status.lastError || ''))
    return {
      available,
      connected: Boolean(status.connected),
      authenticated: Boolean(available && !unauthorized),
      version: null,
      ...(status.lastError ? { error: status.lastError } : {}),
    }
  })
  trustedHandle('assistant:start-turn', (input) => {
    const assistant = activeAssistant()
    if (!assistant) throw new Error('The assistant bridge is not ready.')
    if (!input || !validAssistantRequestId(input.requestId)) throw new Error('Invalid assistant request.')
    const requestId = input.requestId
    if (assistantRequestId && assistantRequestId !== requestId) throw new Error('Wait for the current assistant response to finish.')
    const message = String(input.message || '').trim()
    const healthContext = String(input.healthContext || '').trim()
    if (!message || message.length > 20_000) throw new Error('The assistant message is empty or too long.')
    if (!healthContext || healthContext.length > 500_000) throw new Error('The health context is empty or too large.')

    const toolNames = Array.isArray(input.toolNames) ? input.toolNames.map(String) : []
    const dispatcher = createDispatcher({ allowedNames: toolNames, execute: executeToolInRenderer })

    assistantRequestId = requestId
    assistantInFlight = assistant
    void assistant.startTurn({
      text: message,
      healthContext,
      tools: Array.isArray(input.tools) ? input.tools : [],
      onDelta: (delta) => {
        if (assistantRequestId === requestId) sendAssistantEvent({ requestId, type: 'delta', delta })
      },
      onToolCall: async (name, args) => {
        const outcome = await dispatcher.call(name, args)
        if (assistantRequestId === requestId) {
          sendAssistantEvent({ requestId, type: 'tool', name, ok: outcome.ok })
        }
        return outcome
      },
    }).then(async (result) => {
      if (assistantRequestId !== requestId) return
      // Only Codex asks for tools by directive; DeepSeek gets them natively
      // and will never emit an openfit:tool comment, so this is a no-op there.
      let text = result.text
      if (assistant === codexService) {
        text = await runCodexToolRounds(assistant, requestId, text, dispatcher, (delta) => {
          if (assistantRequestId === requestId) sendAssistantEvent({ requestId, type: 'delta', delta })
        })
      }
      if (assistantRequestId !== requestId) return
      assistantRequestId = null
      assistantInFlight = null
      sendAssistantEvent({ requestId, type: 'complete', text: stripToolDirective(text) })
    }).catch((error) => {
      if (assistantRequestId !== requestId) return
      assistantRequestId = null
      assistantInFlight = null
      if (error?.name === 'AbortError' || error?.code === 'CODEX_TURN_CANCELLED') {
        sendAssistantEvent({ requestId, type: 'cancelled' })
      } else {
        sendAssistantEvent({ requestId, type: 'error', message: assistantErrorMessage(error) })
      }
    })
    return { requestId }
  })
  trustedHandle('assistant:cancel', async (requestId) => {
    if (!validAssistantRequestId(requestId) || assistantRequestId !== requestId) return
    // Prefer the instance that is actually streaming the turn: a config save
    // in the meantime may have rebuilt activeAssistant() into a new instance.
    await (assistantInFlight ?? activeAssistant())?.cancelTurn()
  })
  trustedHandle('assistant:reset', async () => {
    const assistant = assistantInFlight ?? activeAssistant()
    assistantRequestId = null
    assistantInFlight = null
    await assistant?.reset()
  })
  trustedHandle('assistant:tool-response', (response) => {
    const callId = String(response?.callId || '')
    const pending = pendingToolCalls.get(callId)
    if (!pending) return
    pendingToolCalls.delete(callId)
    if (response.error) pending.reject(new Error(String(response.error)))
    else pending.resolve(response.result)
  })
  trustedHandle('assistant:get-config', () => publicAssistantConfig())
  trustedHandle('assistant:save-config', (input) => {
    if (assistantRequestId) throw new Error('Wait for the current assistant response to finish before changing the model.')
    const previous = getAssistantConfig()
    const next = assistantConfigLogic.resolveSaveConfig(input, previous)
    // writeSecure refuses to fall back to plaintext when safeStorage is unavailable.
    writeSecure(assistantConfigFile, next)
    assistantProvider = null
    return assistantConfigLogic.toPublicConfig(next)
  })
}

app.whenReady().then(() => {
  app.setName(APP_DISPLAY_NAME)
  if (process.platform === 'darwin') app.dock.setIcon(APP_ICON_PATH)
  const userData = process.env.OPENFIT_USER_DATA || path.join(app.getPath('appData'), LEGACY_USER_DATA_NAME)
  app.setPath('userData', userData)
  credentialFile = path.join(userData, 'credentials.secure.json')
  cacheFile = path.join(userData, 'health-cache.secure.json')
  assistantConfigFile = path.join(userData, 'assistant-config.secure.json')
  codexService = createCodexService({ cwd: userData, clientVersion: app.getVersion() })
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  if (!developmentUrl()) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://health.googleapis.com https://api.fitbit.com"],
        },
      })
    })
  }
  registerIpc()
  createWindow()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  closeOAuthServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeOAuthServer()
  void codexService?.dispose()
})
