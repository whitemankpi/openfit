import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { validToolCatalog, MAX_TOOL_CATALOG_SIZE, MAX_TOOL_DESCRIPTION_CHARS } = require('./assistant-tool-catalog.cjs') as {
  validToolCatalog: (tools: unknown) => Array<{ name: string; description: string; schema: unknown }>
  MAX_TOOL_CATALOG_SIZE: number
  MAX_TOOL_DESCRIPTION_CHARS: number
}

describe('validToolCatalog', () => {
  it('passes through a well-formed entry for a known tool', () => {
    const result = validToolCatalog([
      { name: 'metric_window', description: 'x', schema: { type: 'object', properties: {}, required: [] } },
    ])
    expect(result).toEqual([
      { name: 'metric_window', description: 'x', schema: { type: 'object', properties: {}, required: [] } },
    ])
  })

  it('drops entries whose name is not one of the six real tools', () => {
    const result = validToolCatalog([{ name: 'delete_everything', description: 'x', schema: {} }])
    expect(result).toEqual([])
  })

  it('is not fooled by a non-array or non-object input', () => {
    expect(validToolCatalog('metric_window')).toEqual([])
    expect(validToolCatalog(null)).toEqual([])
    expect(validToolCatalog([null, 'x', 42, ['metric_window']])).toEqual([])
  })

  it('caps the number of entries', () => {
    const many = Array.from({ length: MAX_TOOL_CATALOG_SIZE + 10 }, () => ({ name: 'metric_window' }))
    expect(validToolCatalog(many)).toHaveLength(MAX_TOOL_CATALOG_SIZE)
  })

  it('caps the description length rather than forwarding an arbitrarily long string into Codex instructions', () => {
    const result = validToolCatalog([{ name: 'metric_window', description: 'x'.repeat(10_000) }])
    expect(result[0]!.description).toHaveLength(MAX_TOOL_DESCRIPTION_CHARS)
  })

  it('falls back to an empty object shape when schema is missing or malformed', () => {
    const result = validToolCatalog([
      { name: 'metric_window', description: 'x', schema: 'not an object' },
      { name: 'explain_score', description: 'y' },
    ])
    expect(result[0]!.schema).toEqual({ type: 'object', properties: {}, required: [] })
    expect(result[1]!.schema).toEqual({ type: 'object', properties: {}, required: [] })
  })
})
