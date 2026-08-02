import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { failedGoogleFitConnection, publicGoogleFitStatus } = require('./google-fit-status.cjs')

const token = { scope: 'openid https://www.googleapis.com/auth/fitness.activity.read' }

describe('Google Fit connection status', () => {
  it('distinguishes a stored token from a working connection', () => {
    expect(publicGoogleFitStatus('google-health', { googleFitToken: token }).googleFitStatus).toBe('active')
    const failed = failedGoogleFitConnection(new Error('Token has been expired or revoked.'), '2026-08-02T12:00:00Z')
    expect(publicGoogleFitStatus('google-health', { googleFitToken: token, googleFitConnection: failed })).toEqual({
      googleFitAuthorized: true,
      googleFitStatus: 'reconnect-required',
      googleFitError: 'Google Fit authorization expired or was revoked.',
      googleFitCheckedAt: '2026-08-02T12:00:00Z',
    })
  })

  it('keeps transient refresh failures distinct from expired authorization', () => {
    expect(failedGoogleFitConnection(new Error('network timeout')).status).toBe('error')
    expect(failedGoogleFitConnection({ status: 401, message: 'Request failed' }).status).toBe('reconnect-required')
  })

  it('reports no connection when the separate Fitness scope is absent', () => {
    expect(publicGoogleFitStatus('google-health', { googleFitToken: null }).googleFitStatus).toBe('not-connected')
  })
})
