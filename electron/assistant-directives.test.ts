import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { TOOL_DIRECTIVE_CASES } from './tool-directive-cases'

const require = createRequire(import.meta.url)
const { parseToolDirective, stripToolDirective } = require('./assistant-directives.cjs') as {
  parseToolDirective: (text: string) => { name: string; args: Record<string, unknown> } | null
  stripToolDirective: (text: string) => string
}

// This is the CommonJS twin of parseAssistantToolRequest/stripAssistantToolRequest
// in src/lib/health-assistant.ts, extracted out of main.cjs (which has no
// exports and no test of its own) so it can be tested directly, the way
// assistant-dispatch.cjs and assistant-config.cjs already are. The "shared
// parser contract" block below asserts the exact same table of cases that
// src/lib/health-assistant.test.ts asserts against the TypeScript parser —
// see electron/tool-directive-cases.ts for why.
describe('parseToolDirective / stripToolDirective', () => {
  it('reads a well-formed tool request', () => {
    const text = 'Let me check.\n<!-- openfit:tool {"name":"metric_window","args":{"metric":"steps"}} -->'
    expect(parseToolDirective(text)).toEqual({ name: 'metric_window', args: { metric: 'steps' } })
  })

  it('defaults missing args to an empty object', () => {
    expect(parseToolDirective('<!-- openfit:tool {"name":"data_coverage"} -->')).toEqual({
      name: 'data_coverage',
      args: {},
    })
  })

  it('strips the directive from the visible text', () => {
    const text = 'Checking.\n<!-- openfit:tool {"name":"metric_window"} -->'
    expect(stripToolDirective(text)).toBe('Checking.')
  })

  it('leaves a navigation directive untouched by stripping', () => {
    const text = 'Opening.\n<!-- openfit:navigate {"page":"sleep"} -->'
    expect(stripToolDirective(text)).toBe(text)
  })
})

describe('shared parser contract (pinned against src/lib/health-assistant.test.ts)', () => {
  for (const testCase of TOOL_DIRECTIVE_CASES) {
    it(testCase.description, () => {
      expect(parseToolDirective(testCase.text)).toEqual(testCase.expected)
    })
  }
})
