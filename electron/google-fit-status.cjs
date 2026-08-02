'use strict'

const FITNESS_SCOPE = 'https://www.googleapis.com/auth/fitness.activity.read'
const STATUSES = new Set(['active', 'reconnect-required', 'error'])

function hasGoogleFitScope(token) {
  return String(token?.scope || '').split(/\s+/).includes(FITNESS_SCOPE)
}

function activeGoogleFitConnection(checkedAt = new Date().toISOString()) {
  return { status: 'active', checkedAt, error: null }
}

function failedGoogleFitConnection(error, checkedAt = new Date().toISOString()) {
  const message = error instanceof Error ? error.message : String(error?.message || error || '')
  const status = Number(error?.status || 0)
  const reconnect = status === 401 || /invalid[_ -]?grant|expired|revoked|unauthori[sz]ed|401/i.test(message)
  return reconnect
    ? { status: 'reconnect-required', checkedAt, error: 'Google Fit authorization expired or was revoked.' }
    : { status: 'error', checkedAt, error: 'Google Fit could not refresh. OpenFit is continuing without Google Fit steps.' }
}

function publicGoogleFitStatus(provider, credentials) {
  const authorized = provider === 'google-health' && hasGoogleFitScope(credentials.googleFitToken)
  if (!authorized) {
    return { googleFitAuthorized: false, googleFitStatus: 'not-connected', googleFitError: null, googleFitCheckedAt: null }
  }
  const connection = credentials.googleFitConnection
  const status = STATUSES.has(connection?.status) ? connection.status : 'active'
  return {
    googleFitAuthorized: true,
    googleFitStatus: status,
    googleFitError: status === 'active' ? null : String(connection?.error || 'Google Fit is currently unavailable.'),
    googleFitCheckedAt: typeof connection?.checkedAt === 'string' ? connection.checkedAt : null,
  }
}

module.exports = {
  FITNESS_SCOPE,
  activeGoogleFitConnection,
  failedGoogleFitConnection,
  hasGoogleFitScope,
  publicGoogleFitStatus,
}
