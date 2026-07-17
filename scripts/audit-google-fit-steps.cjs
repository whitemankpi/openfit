'use strict'

const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const googleHealth = require('../electron/google-health-service.cjs')

app.setName('pulseboard-fitbit-desktop')

function localIsoToday() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function readSecure(file) {
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (envelope.encrypted !== true || !safeStorage.isEncryptionAvailable()) throw new Error('Secure OpenFit credentials are unavailable.')
  return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, 'base64')))
}

app.whenReady().then(async () => {
  try {
    const date = process.argv.find((argument) => /^\d{4}-\d{2}-\d{2}$/.test(argument)) || localIsoToday()
    if (process.env.OPENFIT_AUDIT_URL) {
      const base = new URL(process.env.OPENFIT_AUDIT_URL)
      const localHttp = base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)
      if (base.protocol !== 'https:' && !localHttp) throw new Error('OPENFIT_AUDIT_URL must use HTTPS, except on localhost.')
      const username = process.env.OPENFIT_USERNAME || ''
      const password = process.env.OPENFIT_PASSWORD || ''
      if (!username || !password) throw new Error('OPENFIT_USERNAME and OPENFIT_PASSWORD are required for a hosted audit.')
      const response = await fetch(new URL('/api/google-fit/audit', base), {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ date }),
      })
      const report = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(report.error || `Hosted audit failed (${response.status}).`)
      console.log(JSON.stringify(report, null, 2))
      app.quit()
      return
    }
    const credentialsPath = path.join(app.getPath('appData'), 'pulseboard-fitbit-desktop', 'credentials.secure.json')
    const credentials = readSecure(credentialsPath)
    if (credentials.config?.provider !== 'google-health' || !credentials.token) throw new Error('Connect Google Health in OpenFit first.')
    if (!credentials.googleFitToken) throw new Error('Authorize Google Fit steps in OpenFit first.')
    let healthToken = credentials.token
    let fitToken = credentials.googleFitToken
    if (!healthToken.access_token || Number(healthToken.expiresAt || 0) < Date.now() + 90_000) {
      healthToken = await googleHealth.refreshAccessToken(credentials.config, healthToken)
    }
    if (!fitToken.access_token || Number(fitToken.expiresAt || 0) < Date.now() + 90_000) {
      fitToken = await googleHealth.refreshAccessToken(credentials.config, fitToken)
    }
    const report = await googleHealth.auditGoogleFitSteps(healthToken.access_token, fitToken.access_token, date)
    console.log(JSON.stringify(report, null, 2))
    app.quit()
  } catch (error) {
    console.error(error.stack || error.message)
    app.exit(1)
  }
})
