import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createDispatcher } = require('./assistant-dispatch.cjs') as {
  createDispatcher: (options: {
    allowedNames: string[]
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
    maxCalls?: number
    timeoutMs?: number
    maxResultBytes?: number
  }) => { call: (name: string, args: unknown) => Promise<any>; reset: () => void; callCount: number }
}

const dispatcher = (overrides = {}) => createDispatcher({
  allowedNames: ['metric_window'],
  execute: async () => ({ n: 30 }),
  ...overrides,
})

describe('assistant dispatcher', () => {
  it('passes an allowed call through to the executor', async () => {
    const execute = vi.fn(async () => ({ n: 30 }))
    const result = await dispatcher({ execute }).call('metric_window', { metric: 'steps' })

    expect(result).toEqual({ ok: true, result: { n: 30 } })
    expect(execute).toHaveBeenCalledWith('metric_window', { metric: 'steps' })
  })

  it('refuses a name outside the allowlist without calling the executor', async () => {
    const execute = vi.fn(async () => ({}))
    const result = await dispatcher({ execute }).call('rm_rf', {})

    expect(result.ok).toBe(false)
    expect(result.error).toContain('rm_rf')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects arguments that are not a plain object', async () => {
    const result = await dispatcher().call('metric_window', 'steps')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('object')
  })

  it('stops accepting calls once the budget is spent', async () => {
    const instance = dispatcher({ maxCalls: 2 })
    await instance.call('metric_window', {})
    await instance.call('metric_window', {})
    const third = await instance.call('metric_window', {})

    expect(third.ok).toBe(false)
    expect(third.error).toContain('limit')
    expect(instance.callCount).toBe(2)
  })

  it('gives up on an executor that never settles', async () => {
    const result = await dispatcher({
      execute: () => new Promise(() => undefined),
      timeoutMs: 20,
    }).call('metric_window', {})

    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out')
  })

  it('refuses a result that is not serialisable to an object', async () => {
    const result = await dispatcher({ execute: async () => 'just a string' }).call('metric_window', {})

    expect(result.ok).toBe(false)
    expect(result.error).toContain('shape')
  })

  it('refuses an oversized result rather than sending it on', async () => {
    const result = await dispatcher({
      execute: async () => ({ blob: 'x'.repeat(9000) }),
      maxResultBytes: 4096,
    }).call('metric_window', {})

    expect(result.ok).toBe(false)
    expect(result.error).toContain('too large')
  })

  it('turns an executor failure into an error rather than a rejection', async () => {
    const result = await dispatcher({
      execute: async () => { throw new Error('renderer exploded') },
    }).call('metric_window', {})

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('restores the budget on reset', async () => {
    const instance = dispatcher({ maxCalls: 1 })
    await instance.call('metric_window', {})
    instance.reset()
    const second = await instance.call('metric_window', {})

    expect(second.ok).toBe(true)
    expect(instance.callCount).toBe(1)
  })
})
