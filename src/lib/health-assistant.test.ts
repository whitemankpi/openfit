import { describe, expect, it } from 'vitest'
import { TOOL_DIRECTIVE_CASES } from '../../electron/tool-directive-cases'
import {
  parseAssistantNavigation,
  parseAssistantToolRequest,
  stripAssistantNavigation,
  stripAssistantToolRequest,
  visibleAssistantText,
} from './health-assistant'

describe('assistant navigation directives', () => {
  it('parses and removes a valid directive', () => {
    const text = 'Apro il sonno di ieri.\n<!-- openfit:navigate {"page":"sleep","date":"2026-06-22"} -->'
    expect(parseAssistantNavigation(text)).toEqual({ page: 'sleep', date: '2026-06-22' })
    expect(stripAssistantNavigation(text)).toBe('Apro il sonno di ieri.')
    expect(visibleAssistantText(text)).toBe('Apro il sonno di ieri.')
    expect(visibleAssistantText('Apro il sonno.\n<!-- pulse')).toBe('Apro il sonno.')
  })

  it('ignores invalid pages and malformed JSON', () => {
    expect(parseAssistantNavigation('<!-- openfit:navigate {"page":"admin"} -->')).toBeNull()
    expect(parseAssistantNavigation('<!-- openfit:navigate {"date":"2026-02-31"} -->')).toBeNull()
    expect(parseAssistantNavigation('<!-- openfit:navigate nope -->')).toBeNull()
  })
})

describe('assistant tool directives', () => {
  it('reads a well-formed tool request', () => {
    const text = 'Let me check.\n<!-- openfit:tool {"name":"metric_window","args":{"metric":"steps"}} -->'

    expect(parseAssistantToolRequest(text)).toEqual({
      name: 'metric_window',
      args: { metric: 'steps' },
    })
  })

  it('ignores a directive with no name', () => {
    expect(parseAssistantToolRequest('<!-- openfit:tool {"args":{}} -->')).toBeNull()
  })

  it('ignores malformed JSON rather than throwing', () => {
    expect(parseAssistantToolRequest('<!-- openfit:tool {not json} -->')).toBeNull()
  })

  it('defaults missing args to an empty object', () => {
    expect(parseAssistantToolRequest('<!-- openfit:tool {"name":"data_coverage"} -->'))
      .toEqual({ name: 'data_coverage', args: {} })
  })

  it('refuses args that are not an object, so the dispatcher is not handed a string', () => {
    expect(parseAssistantToolRequest('<!-- openfit:tool {"name":"x","args":"steps"} -->')).toBeNull()
  })

  it('takes only the first directive when the model emits several', () => {
    const text = '<!-- openfit:tool {"name":"a"} --><!-- openfit:tool {"name":"b"} -->'

    expect(parseAssistantToolRequest(text)?.name).toBe('a')
  })

  it('strips the directive from the visible text', () => {
    const text = 'Checking.\n<!-- openfit:tool {"name":"metric_window"} -->'

    expect(stripAssistantToolRequest(text)).toBe('Checking.')
  })

  it('leaves a navigation directive alone', () => {
    const text = 'Opening.\n<!-- openfit:navigate {"page":"sleep"} -->'

    expect(parseAssistantToolRequest(text)).toBeNull()
    expect(stripAssistantToolRequest(text)).toBe(text)
  })
})

// Pinned against electron/assistant-directives.test.ts, which asserts this
// exact same table (see electron/tool-directive-cases.ts) against
// parseToolDirective, the CommonJS twin main.cjs actually runs. A change to
// either parser's rejection rules that isn't mirrored in the other shows up
// as one of these two suites failing.
describe('shared parser contract (pinned against electron/assistant-directives.test.ts)', () => {
  for (const testCase of TOOL_DIRECTIVE_CASES) {
    it(testCase.description, () => {
      expect(parseAssistantToolRequest(testCase.text)).toEqual(testCase.expected)
      expect(stripAssistantToolRequest(testCase.text)).toBe(testCase.expectedStripped)
    })
  }
})
