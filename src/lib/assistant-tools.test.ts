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

  it('refuses inherited object keys rather than crashing on them', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const result = runTool('metric_window', {
        metric: name,
        start: '2026-06-01',
        end: '2026-06-30',
      }, context()) as { error?: string }

      expect(result.error).toContain(name)
    }
  })
})

describe('explain_score', () => {
  it('returns the same breakdown the interface shows', () => {
    const result = runTool('explain_score', { score: 'recovery' }, context()) as {
      value: number | null
      confidence: string
      contributions: Array<{ key: string; points: number }>
    }

    expect(result.confidence).toBe('ready')
    const total = result.contributions.reduce((sum, item) => sum + item.points, 0)
    expect(total).toBe(result.value)
  })

  it('refuses an unknown score name', () => {
    const result = runTool('explain_score', { score: 'readiness' }, context()) as { error: string }
    expect(result.error).toContain('readiness')
  })
})

describe('data_coverage', () => {
  it('reports which metrics have data and how many days', () => {
    const result = runTool('data_coverage', {
      start: '2026-06-01',
      end: '2026-06-30',
    }, context()) as { totalDays: number; metrics: Array<{ metric: string; n: number }> }

    expect(result.totalDays).toBe(30)
    const steps = result.metrics.find((entry) => entry.metric === 'steps')
    expect(steps?.n).toBe(30)
  })

  it('names metrics that are entirely absent', () => {
    const bare = context()
    bare.history = {
      maxHeartRate: null,
      days: bare.history.days.map((day) => ({ ...day, trend: { ...day.trend, hrvMs: null } })),
    }

    const result = runTool('data_coverage', {
      start: '2026-06-01',
      end: '2026-06-30',
    }, bare) as { missing: string[] }

    expect(result.missing).toContain('hrvMs')
  })
})
