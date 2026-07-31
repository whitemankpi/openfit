import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import { analyzeHome, compareWithPersonalBaseline, periodDelta, robustBaseline, robustZScore } from './home-analysis'

describe('home analysis', () => {
  it('compares the day against goals and personal baselines', () => {
    const data = createDemoData('2026-06-22')
    const analysis = analyzeHome(data)

    expect(analysis.stepsGoalProgress).toBeCloseTo((data.activity.steps ?? 0) / (data.activity.stepsGoal ?? 1))
    expect(analysis.restingHeartRate.sampleCount).toBe(7)
    expect(analysis.hrv.sampleCount).toBe(7)
    expect(analysis.headline.title.length).toBeGreaterThan(0)
  })

  it('excludes the selected day from a personal baseline', () => {
    const data = createDemoData('2026-06-22')
    const comparison = compareWithPersonalBaseline(data, data.health.hrvMs, (point) => point.hrvMs)
    const expected = data.trends.slice(-8, -1).reduce((sum, point) => sum + (point.hrvMs ?? 0), 0) / 7

    expect(comparison.baseline).toBeCloseTo(expected)
  })

  it('requires enough observations for a period comparison', () => {
    expect(periodDelta([1, null, 2, 3])).toBeNull()
    expect(periodDelta([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).not.toBeNull()
  })
})

describe('robust baseline', () => {
  it('ignores gaps and reports how much it had to work with', () => {
    expect(robustBaseline([10, null, 12, undefined, 14])).toMatchObject({ center: 12, sampleCount: 3 })
    expect(robustBaseline([null, undefined])).toEqual({ center: null, spread: null, sampleCount: 0 })
  })

  it('is not moved by a single extreme reading', () => {
    const steady = [40, 42, 44, 46, 48]
    const withOutlier = [...steady, 400]

    // A mean would jump by roughly sixty; the median moves by two.
    expect(robustBaseline(steady).center).toBe(44)
    expect(robustBaseline(withOutlier).center).toBe(45)
  })

  it('reports no spread for a series that never varies', () => {
    const flat = robustBaseline([50, 50, 50, 50])

    expect(flat.spread).toBeNull()
    // Without spread there is no scale to express a deviation in.
    expect(robustZScore(70, flat)).toBeNull()
  })

  it('measures deviation in spread units and clamps the extremes', () => {
    const baseline = robustBaseline([40, 42, 44, 46, 48])

    expect(robustZScore(44, baseline)).toBe(0)
    expect(robustZScore(48, baseline)).toBeCloseTo(4 / (2 * 1.4826), 5)
    expect(robustZScore(4000, baseline)).toBe(3)
    expect(robustZScore(-4000, baseline)).toBe(-3)
    expect(robustZScore(null, baseline)).toBeNull()
  })
})
