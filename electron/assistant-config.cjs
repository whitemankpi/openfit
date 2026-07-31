'use strict'

// Pure assistant-provider-config logic, kept separate from main.cjs so it can be
// unit tested without booting Electron. main.cjs owns the file I/O (readSecure/
// writeSecure) and IPC wiring; everything here only ever sees plain objects.

/** Normalizes whatever was read back from the encrypted config file (or nothing yet). */
function normalizeConfig(stored) {
  return {
    provider: stored?.provider === 'deepseek' ? 'deepseek' : 'codex',
    apiKey: typeof stored?.apiKey === 'string' ? stored.apiKey : '',
  }
}

/** The shape that is safe to hand to the renderer: never the key itself. */
function toPublicConfig(config) {
  return { provider: config.provider, hasApiKey: Boolean(config.apiKey) }
}

/**
 * Decides what to persist for a save request. A blank/whitespace-only or
 * omitted apiKey keeps whatever was already stored. Throws if the result
 * would select DeepSeek with no key on file, so callers never end up with a
 * config that fails obscurely at turn time.
 */
function resolveSaveConfig(input, previous) {
  const provider = input?.provider === 'deepseek' ? 'deepseek' : 'codex'
  const trimmed = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  const apiKey = trimmed || previous.apiKey
  if (provider === 'deepseek' && !apiKey) throw new Error('DeepSeek requires an API key.')
  return { provider, apiKey }
}

module.exports = { normalizeConfig, toPublicConfig, resolveSaveConfig }
