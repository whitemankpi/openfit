import { describe, expect, it } from 'vitest'
import { addMemory, memoryManifest, relevantMemory, validateMemoryEntry, type MemoryEntry } from './assistant-memory'

const entry = (overrides: Partial<MemoryEntry>): MemoryEntry => ({
  id: crypto.randomUUID(), kind: 'fact', text: 'Vegetarian', createdAt: '2026-08-02T00:00:00.000Z', ...overrides,
})

describe('assistant memory', () => {
  it('validates dated episodes', () => {
    expect(validateMemoryEntry({ kind: 'episode', text: 'Had flu', startDate: '2026-03-10', endDate: '2026-03-17' })).toMatchObject({ kind: 'episode' })
    expect(() => validateMemoryEntry({ kind: 'episode', text: 'Bad', startDate: 'later' })).toThrow()
  })

  it('deduplicates normalized text', () => {
    expect(addMemory([entry({ text: 'Vegetarian.' })], entry({ text: ' vegetarian ' }))).toHaveLength(1)
  })

  it('selects core and overlapping dated memory', () => {
    const values = [entry({}), entry({ kind: 'episode', text: 'Flu', startDate: '2026-03-10', endDate: '2026-03-17' }), entry({ kind: 'episode', text: 'Trip', startDate: '2026-04-01', endDate: '2026-04-03' })]
    expect(relevantMemory(values, { start: '2026-03-15', end: '2026-03-20' }).map((item) => item.text)).toEqual(['Vegetarian', 'Flu'])
    expect(memoryManifest(values)).toMatchObject({ recallableCount: 2, recallableFirstDate: '2026-03-10' })
  })
})
