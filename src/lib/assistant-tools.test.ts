import { describe, expect, it } from 'vitest'
import { createDemoData, createDemoHistory } from '@/data/demo'
import { METRIC_KEYS, TOOL_NAMES, runTool, type ToolContext } from './assistant-tools'

const SELECTED = '2026-06-30'

function context(): ToolContext {
  return { data: createDemoData(SELECTED), history: createDemoHistory(SELECTED) }
}

describe('metric_window', () => {
  it('summarises a metric over a window', () => {
    const result = runTool('metric_window', {
      metric: 'steps',
      start: '2026-06-01',
      end: '2026-06-30',
    }, context()) as { n: number; median: number | null; min: number | null; max: number | null }

    expect(result.n).toBe(30)
    expect(result.median).not.toBeNull()
    expect(result.min as number).toBeLessThanOrEqual(result.max as number)
  })

  it('reports insufficient rather than zeros for an empty window', () => {
    const result = runTool('metric_window', {
      metric: 'steps',
      start: '2020-01-01',
      end: '2020-01-31',
    }, context()) as { insufficient: boolean; n: number }

    expect(result.insufficient).toBe(true)
    expect(result.n).toBe(0)
  })

  it('refuses a metric outside the enum', () => {
    const result = runTool('metric_window', {
      metric: 'bloodPressure',
      start: '2026-06-01',
      end: '2026-06-30',
    }, context()) as { error: string }

    expect(result.error).toContain('bloodPressure')
  })

  it('exposes a stable registry', () => {
    expect(TOOL_NAMES).toContain('metric_window')
    expect(METRIC_KEYS).toContain('steps')
    expect(METRIC_KEYS).toContain('restingHeartRate')
  })
})
