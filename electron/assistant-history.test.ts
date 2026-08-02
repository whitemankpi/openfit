import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { pruneExchange, applyHistoryCap, MAX_HISTORY_EXCHANGES, MAX_HISTORY_BYTES } = require('./assistant-history.cjs') as {
  pruneExchange: (messages: any[]) => any[]
  applyHistoryCap: (history: any[]) => { history: any[]; trimmed: boolean }
  MAX_HISTORY_EXCHANGES: number
  MAX_HISTORY_BYTES: number
}

const exchange = (n: number, size = 10) => ([
  { role: 'user', content: `q${n}`.padEnd(size, 'x') },
  { role: 'assistant', content: `a${n}`.padEnd(size, 'y') },
])

describe('pruneExchange', () => {
  it('keeps the question and the answer', () => {
    const result = pruneExchange([
      { role: 'user', content: 'how did I sleep?' },
      { role: 'assistant', content: 'You slept 7h20m.' },
    ])

    expect(result).toEqual([
      { role: 'user', content: 'how did I sleep?' },
      { role: 'assistant', content: 'You slept 7h20m.' },
    ])
  })

  it('drops the tool call and its result, which the answer already reports', () => {
    const result = pruneExchange([
      { role: 'user', content: 'steps last month?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'metric_window', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"median":8000,"n":30}' },
      { role: 'assistant', content: 'You averaged 8 000 steps over 30 days.' },
    ])

    expect(result).toEqual([
      { role: 'user', content: 'steps last month?' },
      { role: 'assistant', content: 'You averaged 8 000 steps over 30 days.' },
    ])
  })

  it('drops several rounds of tool traffic', () => {
    const result = pruneExchange([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c2', content: '{}' },
      { role: 'assistant', content: 'answer' },
    ])

    expect(result).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'answer' },
    ])
  })

  it('returns nothing usable when the turn produced no answer', () => {
    const result = pruneExchange([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ])

    expect(result).toEqual([])
  })
})

describe('applyHistoryCap', () => {
  it('leaves a short history alone', () => {
    const history = [...exchange(1), ...exchange(2)]
    const result = applyHistoryCap(history)

    expect(result.history).toEqual(history)
    expect(result.trimmed).toBe(false)
  })

  it('drops the oldest exchanges past the count limit', () => {
    const history = Array.from({ length: MAX_HISTORY_EXCHANGES + 3 }, (_, index) => exchange(index)).flat()
    const result = applyHistoryCap(history)

    expect(result.history).toHaveLength(MAX_HISTORY_EXCHANGES * 2)
    expect(result.trimmed).toBe(true)
    // The newest survives, the oldest does not.
    expect(result.history.at(-2).content).toContain(`q${MAX_HISTORY_EXCHANGES + 2}`)
    expect(result.history[0].content).not.toContain('q0x')
  })

  it('drops the oldest exchanges past the byte limit', () => {
    const big = Math.ceil(MAX_HISTORY_BYTES / 4)
    const history = [...exchange(1, big), ...exchange(2, big), ...exchange(3, big)]
    const result = applyHistoryCap(history)

    expect(result.trimmed).toBe(true)
    expect(result.history.length).toBeLessThan(history.length)
    expect(JSON.stringify(result.history).length).toBeLessThanOrEqual(MAX_HISTORY_BYTES)
  })

  it('keeps the most recent exchange even when it alone exceeds the byte limit', () => {
    const huge = MAX_HISTORY_BYTES * 2
    const result = applyHistoryCap([...exchange(1), ...exchange(2, huge)])

    // An empty history with no marker would read as a fresh conversation.
    expect(result.history).toHaveLength(2)
    expect(result.history[0].content).toContain('q2')
    expect(result.trimmed).toBe(true)
  })

  it('reports the agreed limits', () => {
    expect(MAX_HISTORY_EXCHANGES).toBe(20)
    expect(MAX_HISTORY_BYTES).toBe(16384)
  })
})
