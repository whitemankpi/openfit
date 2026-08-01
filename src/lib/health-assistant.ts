import type { PageId } from '@/types'

export interface AssistantNavigation {
  page?: PageId
  date?: string
}

const navigationPattern = /\s*<!--\s*openfit:navigate\s+(\{[\s\S]*?\})\s*-->\s*/g
const validPages = new Set<PageId>(['today', 'activity', 'health', 'sleep', 'body', 'devices'])

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, 12))
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function parseAssistantNavigation(text: string): AssistantNavigation | null {
  navigationPattern.lastIndex = 0
  const match = navigationPattern.exec(text)
  if (!match) return null
  try {
    const value = JSON.parse(match[1]) as AssistantNavigation
    const page = value.page && validPages.has(value.page) ? value.page : undefined
    const date = value.date && validIsoDate(value.date) ? value.date : undefined
    return page || date ? { page, date } : null
  } catch {
    return null
  }
}

export function stripAssistantNavigation(text: string) {
  navigationPattern.lastIndex = 0
  return text.replace(navigationPattern, '').trim()
}

export interface AssistantToolRequest {
  name: string
  args: Record<string, unknown>
}

const toolPattern = /\s*<!--\s*openfit:tool\s+(\{[\s\S]*?\})\s*-->\s*/g

/**
 * Codex cannot be handed tool definitions, so it requests one the same way it
 * requests navigation. Only the first directive of a turn is honoured: the
 * dispatcher's budget counts round trips, and a model emitting several at once
 * has misunderstood the protocol.
 */
export function parseAssistantToolRequest(text: string): AssistantToolRequest | null {
  toolPattern.lastIndex = 0
  const match = toolPattern.exec(text)
  if (!match) return null
  try {
    const value = JSON.parse(match[1]) as { name?: unknown; args?: unknown }
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name) return null
    if (value.args !== undefined && (typeof value.args !== 'object' || value.args === null || Array.isArray(value.args))) {
      return null
    }
    return { name, args: (value.args as Record<string, unknown>) ?? {} }
  } catch {
    return null
  }
}

export function stripAssistantToolRequest(text: string) {
  toolPattern.lastIndex = 0
  return text.replace(toolPattern, '').trim()
}

export function visibleAssistantText(text: string) {
  const marker = text.indexOf('<!--')
  return (marker >= 0 ? text.slice(0, marker) : text).trimEnd()
}
