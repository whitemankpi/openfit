import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const google = require('./google-health-service.cjs')
const legacy = require('./fitbit-legacy-service.cjs')

const config = {
  clientId: 'client-id',
  clientSecret: 'never-put-this-in-the-url',
  redirectUri: 'http://127.0.0.1:42813/oauth/callback',
}

describe.each([
  ['Google Health', google],
  ['Fitbit legacy', legacy],
])('%s OAuth', (_name, provider) => {
  it('uses PKCE and state without leaking the client secret', () => {
    const pkce = provider.createPkce()
    const url = new URL(provider.createAuthorizationUrl(config, 'csrf-state', pkce))

    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.challenge).not.toContain('=')
    expect(url.searchParams.get('state')).toBe('csrf-state')
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.toString()).not.toContain(config.clientSecret)
  })
})

describe('separate Google OAuth grants', () => {
  it('never combines Google Health and Google Fit scopes', () => {
    const pkce = google.createPkce()
    const health = new URL(google.createAuthorizationUrl(config, 'health-state', pkce))
    const fit = new URL(google.createGoogleFitAuthorizationUrl(config, 'fit-state', pkce))
    const healthScopes = health.searchParams.get('scope')?.split(' ') ?? []
    const fitScopes = fit.searchParams.get('scope')?.split(' ') ?? []

    expect(healthScopes.some((scope: string) => scope.includes('/auth/googlehealth.'))).toBe(true)
    expect(healthScopes).not.toContain('https://www.googleapis.com/auth/fitness.activity.read')
    expect(fitScopes).toEqual(['https://www.googleapis.com/auth/fitness.activity.read'])
    expect(health.searchParams.get('include_granted_scopes')).toBe('false')
    expect(fit.searchParams.get('include_granted_scopes')).toBe('false')
  })
})
