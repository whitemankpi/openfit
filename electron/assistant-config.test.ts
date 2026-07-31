import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { normalizeConfig, resolveSaveConfig, toPublicConfig } = require('./assistant-config.cjs') as {
  normalizeConfig: (stored: unknown) => { provider: string; apiKey: string }
  toPublicConfig: (config: { provider: string; apiKey: string }) => { provider: string; hasApiKey: boolean }
  resolveSaveConfig: (input: unknown, previous: { provider: string; apiKey: string }) => { provider: string; apiKey: string }
}

const FAKE_KEY = 'sk-test-key'

describe('assistant-config', () => {
  describe('normalizeConfig', () => {
    it('defaults to codex with an empty key when nothing is stored', () => {
      expect(normalizeConfig(null)).toEqual({ provider: 'codex', apiKey: '' })
    })

    it('falls back to codex for an unrecognised provider value instead of using it as a lookup', () => {
      expect(normalizeConfig({ provider: 'anthropic', apiKey: FAKE_KEY })).toEqual({ provider: 'codex', apiKey: FAKE_KEY })
    })

    it('keeps a stored deepseek provider and key', () => {
      expect(normalizeConfig({ provider: 'deepseek', apiKey: FAKE_KEY })).toEqual({ provider: 'deepseek', apiKey: FAKE_KEY })
    })
  })

  describe('toPublicConfig', () => {
    it('reports hasApiKey without ever including the key itself', () => {
      const withKey = toPublicConfig({ provider: 'deepseek', apiKey: FAKE_KEY })
      expect(withKey).toEqual({ provider: 'deepseek', hasApiKey: true })
      expect(JSON.stringify(withKey)).not.toContain(FAKE_KEY)
    })

    it('reports hasApiKey: false when no key is stored', () => {
      expect(toPublicConfig({ provider: 'codex', apiKey: '' })).toEqual({ provider: 'codex', hasApiKey: false })
    })
  })

  describe('resolveSaveConfig', () => {
    const previousWithKey = { provider: 'codex', apiKey: FAKE_KEY }
    const previousNoKey = { provider: 'codex', apiKey: '' }

    it('preserves the previously stored key when apiKey is omitted', () => {
      expect(resolveSaveConfig({ provider: 'deepseek' }, previousWithKey)).toEqual({ provider: 'deepseek', apiKey: FAKE_KEY })
    })

    it('preserves the previously stored key when apiKey is blank or whitespace-only', () => {
      expect(resolveSaveConfig({ provider: 'deepseek', apiKey: '' }, previousWithKey)).toEqual({ provider: 'deepseek', apiKey: FAKE_KEY })
      expect(resolveSaveConfig({ provider: 'deepseek', apiKey: '   ' }, previousWithKey)).toEqual({ provider: 'deepseek', apiKey: FAKE_KEY })
    })

    it('falls back to codex for an unrecognised provider value', () => {
      expect(resolveSaveConfig({ provider: 'anthropic', apiKey: FAKE_KEY }, previousNoKey)).toEqual({ provider: 'codex', apiKey: FAKE_KEY })
    })

    it('adopts a trimmed new key over the previous one', () => {
      expect(resolveSaveConfig({ provider: 'deepseek', apiKey: `  ${FAKE_KEY}  ` }, previousNoKey)).toEqual({ provider: 'deepseek', apiKey: FAKE_KEY })
    })

    it('refuses to select deepseek with no stored key', () => {
      expect(() => resolveSaveConfig({ provider: 'deepseek' }, previousNoKey)).toThrow('DeepSeek requires an API key.')
      expect(() => resolveSaveConfig({ provider: 'deepseek', apiKey: '   ' }, previousNoKey)).toThrow('DeepSeek requires an API key.')
    })
  })
})
