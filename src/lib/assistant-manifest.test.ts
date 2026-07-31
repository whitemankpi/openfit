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
})
