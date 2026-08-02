export type MemoryKind = 'fact' | 'episode' | 'preference' | 'conclusion'

export interface MemoryEntry {
  id: string
  kind: MemoryKind
  text: string
  createdAt: string
  startDate?: string
  endDate?: string | null
  window?: { start: string; end: string }
  metrics?: string[]
  sampleSize?: number
}

export const MAX_MEMORY_ENTRIES = 50
export const MAX_MEMORY_BYTES = 4096
export const MAX_MEMORY_TEXT = 280

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const KINDS: MemoryKind[] = ['fact', 'episode', 'preference', 'conclusion']

export function validateMemoryEntry(value: unknown): Omit<MemoryEntry, 'id' | 'createdAt'> {
  if (!value || typeof value !== 'object') throw new Error('Memory must be an object.')
  const input = value as Record<string, unknown>
  const kind = String(input.kind || '') as MemoryKind
  const text = String(input.text || '').replace(/\s+/g, ' ').trim()
  if (!KINDS.includes(kind)) throw new Error('Unknown memory kind.')
  if (!text || text.length > MAX_MEMORY_TEXT) throw new Error(`Memory text must be 1-${MAX_MEMORY_TEXT} characters.`)
  const result: Omit<MemoryEntry, 'id' | 'createdAt'> = { kind, text }
  if (kind === 'episode') {
    const startDate = String(input.startDate || '')
    const endDate = input.endDate == null ? null : String(input.endDate)
    if (!ISO_DATE.test(startDate) || (endDate !== null && (!ISO_DATE.test(endDate) || endDate < startDate))) throw new Error('Episode dates are invalid.')
    result.startDate = startDate
    result.endDate = endDate
  }
  if (kind === 'conclusion') {
    const window = input.window as Record<string, unknown> | undefined
    const start = String(window?.start || '')
    const end = String(window?.end || '')
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || end < start) throw new Error('Conclusion window is invalid.')
    const sampleSize = Number(input.sampleSize)
    result.window = { start, end }
    if (Number.isInteger(sampleSize) && sampleSize >= 0) result.sampleSize = sampleSize
    if (Array.isArray(input.metrics)) result.metrics = [...new Set(input.metrics.map(String).filter(Boolean))].slice(0, 8)
  }
  return result
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').trim()
}

export function addMemory(entries: MemoryEntry[], entry: MemoryEntry): MemoryEntry[] {
  if (entries.some((candidate) => normalizedText(candidate.text) === normalizedText(entry.text))) return entries
  const next = [...entries, entry]
  if (next.length > MAX_MEMORY_ENTRIES || new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_MEMORY_BYTES) throw new Error('Assistant memory is full. Remove an entry before adding another.')
  return next
}

export function relevantMemory(entries: MemoryEntry[], options: { start?: string; end?: string; metrics?: string[] } = {}): MemoryEntry[] {
  const metrics = new Set(options.metrics || [])
  return entries.filter((entry) => {
    if (entry.kind === 'fact' || entry.kind === 'preference') return true
    if (entry.kind === 'episode') {
      if (!options.start || !options.end || !entry.startDate) return false
      return entry.startDate <= options.end && (entry.endDate === null || String(entry.endDate || entry.startDate) >= options.start)
    }
    return Boolean(entry.metrics?.some((metric) => metrics.has(metric)))
  })
}

export function memoryManifest(entries: MemoryEntry[]): object {
  const core = entries.filter((entry) => entry.kind === 'fact' || entry.kind === 'preference')
  const ranged = entries.filter((entry) => entry.kind === 'episode' || entry.kind === 'conclusion')
  const dates = ranged.flatMap((entry) => entry.kind === 'episode'
    ? [entry.startDate, entry.endDate]
    : [entry.window?.start, entry.window?.end]).filter((value): value is string => Boolean(value)).sort()
  return {
    core: core.map(({ kind, text }) => ({ kind, text })),
    recallableCount: ranged.length,
    recallableFirstDate: dates[0] ?? null,
    recallableLastDate: dates.at(-1) ?? null,
  }
}
