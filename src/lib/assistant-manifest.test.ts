import { describe, expect, it } from 'vitest'
import { createDemoData, createDemoHistory } from '@/data/demo'
import { buildAssistantManifest } from './assistant-manifest'

const SELECTED = '2026-06-30'

describe('buildAssistantManifest', () => {
  it('is small enough to send every turn', () => {
    const manifest = buildAssistantManifest(createDemoData(SELECTED), createDemoHistory(SELECTED), 'today')

    // The archive dump it replaces was allowed up to 500 000 characters.
    expect(manifest.length).toBeLessThan(20_000)
  })

  it('states the range and which metrics exist without listing every day', () => {
    const manifest = JSON.parse(buildAssistantManifest(createDemoData(SELECTED), createDemoHistory(SELECTED), 'today'))

    expect(manifest.schema).toBe('openfit-assistant-manifest/v1')
    expect(manifest.archive.dayCount).toBeGreaterThan(300)
    expect(manifest.archive.metrics).toContain('steps')
    expect(manifest.archive.daily).toBeUndefined()
  })

  it('carries the selected day and its scores', () => {
    const manifest = JSON.parse(buildAssistantManifest(createDemoData(SELECTED), createDemoHistory(SELECTED), 'sleep'))

    expect(manifest.app.currentPage).toBe('sleep')
    expect(manifest.selectedDay.date).toBe(SELECTED)
    expect(manifest.scores.recovery.value).not.toBeNull()
  })

  it('omits metrics that have no data at all', () => {
    const history = createDemoHistory(SELECTED)
    const stripped = {
      ...history,
      days: history.days.map((day) => ({ ...day, trend: { ...day.trend, cardioScore: null } })),
    }
    const manifest = JSON.parse(buildAssistantManifest(createDemoData(SELECTED), stripped, 'today'))

    expect(manifest.archive.metrics).not.toContain('cardioScore')
  })

  it('never sends the display name, only the timezone', () => {
    const data = createDemoData(SELECTED)
    data.profile.displayName = 'Anton Bilyy'
    const manifest = buildAssistantManifest(data, createDemoHistory(SELECTED), 'today')

    expect(manifest).not.toContain('Anton Bilyy')
    const parsed = JSON.parse(manifest)
    expect(parsed.profile.displayName).toBeUndefined()
    expect(parsed.profile.timezone).toBe(data.profile.timezone)
  })

  it('reduces sync coverage to counts and error keys, never raw upstream error messages', () => {
    const data = createDemoData(SELECTED)
    data.sync = {
      endpointCount: 10,
      successCount: 8,
      errors: [{ key: 'ecgRaw', message: 'Upstream said: quota exceeded for project 12345' }],
      rateLimitRemaining: 42,
    }
    const manifest = buildAssistantManifest(data, createDemoHistory(SELECTED), 'today')

    expect(manifest).not.toContain('quota exceeded')
    const parsed = JSON.parse(manifest)
    expect(parsed.syncCoverage).toEqual({
      endpointCount: 10,
      successCount: 8,
      errorKeys: ['ecgRaw'],
      rateLimitRemaining: 42,
    })
  })
})
