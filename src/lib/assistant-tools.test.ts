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

describe('coaching_snapshot', () => {
  it('returns ranked material changes without listing missing metrics', () => {
    const result = runTool('coaching_snapshot', { kind: 'weekly', end: SELECTED }, context()) as {
      changes: Array<{ metric: string; recentN: number; priorN: number; magnitude: number }>
      relationships: Array<{ rho: number; n: number }>
      stable: boolean
      missing?: string[]
    }

    expect(result.missing).toBeUndefined()
    expect(result.changes.length).toBeLessThanOrEqual(5)
    expect(result.changes.every((entry) => entry.recentN >= 3 && entry.priorN >= 3)).toBe(true)
    expect(result.changes.map((entry) => entry.magnitude)).toEqual([...result.changes.map((entry) => entry.magnitude)].sort((a, b) => b - a))
    expect(result.relationships.every((entry) => entry.n >= 10 && Math.abs(entry.rho) >= 0.35)).toBe(true)
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

describe('compare_periods', () => {
  it('reports both medians, the delta, and each n', () => {
    const result = runTool('compare_periods', {
      metric: 'steps',
      firstStart: '2026-06-01',
      firstEnd: '2026-06-15',
      secondStart: '2026-06-16',
      secondEnd: '2026-06-30',
    }, context()) as {
      first: { median: number | null; n: number }
      second: { median: number | null; n: number }
      delta: number | null
    }

    expect(result.first.n).toBe(15)
    expect(result.second.n).toBe(15)
    expect(result.delta).toBeCloseTo((result.second.median as number) - (result.first.median as number), 5)
  })

  it('reports insufficient when one period has no data', () => {
    const result = runTool('compare_periods', {
      metric: 'steps',
      firstStart: '2020-01-01',
      firstEnd: '2020-01-15',
      secondStart: '2026-06-16',
      secondEnd: '2026-06-30',
    }, context()) as { insufficient: boolean }

    expect(result.insufficient).toBe(true)
  })
})

describe('weekday_pattern', () => {
  it('returns a median per weekday with its count', () => {
    const result = runTool('weekday_pattern', {
      metric: 'steps',
      start: '2026-04-01',
      end: '2026-06-30',
    }, context()) as { weekdays: Array<{ weekday: number; median: number | null; n: number }> }

    expect(result.weekdays).toHaveLength(7)
    expect(result.weekdays.every((entry) => entry.n > 0)).toBe(true)
  })
})

describe('correlate', () => {
  it('pairs two metrics and reports rho with its count', () => {
    const result = runTool('correlate', {
      first: 'steps',
      second: 'activeMinutes',
      lagDays: 0,
      start: '2026-04-01',
      end: '2026-06-30',
    }, context()) as { rho: number | null; n: number; significant: boolean }

    expect(result.n).toBeGreaterThan(80)
    expect(result.rho).not.toBeNull()
  })

  it('offsets the second metric by the requested lag', () => {
    const sameDay = runTool('correlate', {
      first: 'steps', second: 'restingHeartRate', lagDays: 0,
      start: '2026-04-01', end: '2026-06-30',
    }, context()) as { n: number }
    const nextDay = runTool('correlate', {
      first: 'steps', second: 'restingHeartRate', lagDays: 1,
      start: '2026-04-01', end: '2026-06-30',
    }, context()) as { n: number }

    // A one-day lag drops the final pair, which has no following day.
    expect(nextDay.n).toBe(sameDay.n - 1)
  })

  it('still returns rho below the threshold, flagged as not significant', () => {
    const result = runTool('correlate', {
      first: 'steps', second: 'weight', lagDays: 0,
      start: '2026-06-20', end: '2026-06-30',
    }, context()) as { rho: number | null; n: number; significant: boolean }

    expect(result.n).toBeLessThan(30)
    expect(result.significant).toBe(false)
  })

  it('refuses a lag outside the supported range', () => {
    const result = runTool('correlate', {
      first: 'steps', second: 'weight', lagDays: 99,
      start: '2026-04-01', end: '2026-06-30',
    }, context()) as { error: string }

    expect(result.error).toContain('lagDays')
  })
})

describe('recall', () => {
  it('returns only user-approved memory relevant to a date range', () => {
    const value = context()
    value.memory = [
      { id: '1', kind: 'episode', text: 'Had flu', createdAt: '2026-03-10T00:00:00Z', startDate: '2026-03-10', endDate: '2026-03-17' },
      { id: '2', kind: 'episode', text: 'Travelled', createdAt: '2026-04-01T00:00:00Z', startDate: '2026-04-01', endDate: '2026-04-05' },
    ]
    const result = runTool('recall', { start: '2026-03-15', end: '2026-03-20' }, value) as { entries: Array<{ text: string }> }
    expect(result.entries.map((entry) => entry.text)).toEqual(['Had flu'])
  })
})
