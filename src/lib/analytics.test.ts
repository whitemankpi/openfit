import { describe, expect, it } from 'vitest'
import { CORRELATION_MIN_SAMPLES, spearman, weekdayMedians } from './analytics'

const pairsFrom = (xs: number[], ys: number[]): Array<[number, number]> =>
  xs.map((x, index) => [x, ys[index]] as [number, number])

describe('spearman', () => {
  it('reports a perfect monotonic rise as 1', () => {
    const xs = Array.from({ length: 40 }, (_, index) => index)
    const result = spearman(pairsFrom(xs, xs.map((x) => x * 3 + 1)))

    expect(result.rho).toBeCloseTo(1, 10)
    expect(result.n).toBe(40)
    expect(result.significant).toBe(true)
  })

  it('reports a perfect monotonic fall as -1', () => {
    const xs = Array.from({ length: 40 }, (_, index) => index)
    const result = spearman(pairsFrom(xs, xs.map((x) => -x)))

    expect(result.rho).toBeCloseTo(-1, 10)
  })

  it('ranks by order rather than by value, unlike Pearson', () => {
    // y rises monotonically but wildly non-linearly; Spearman still sees 1.
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const ys = [1, 2, 4, 8, 16, 32, 64, 128, 256, 100_000]

    expect(spearman(pairsFrom(xs, ys)).rho).toBeCloseTo(1, 10)
  })

  it('handles tied values with average ranks', () => {
    const result = spearman(pairsFrom([1, 2, 2, 3], [10, 20, 20, 30]))

    expect(result.rho).toBeCloseTo(1, 10)
  })

  it('has no coefficient for a series that never varies', () => {
    const result = spearman(pairsFrom([5, 5, 5, 5], [1, 2, 3, 4]))

    expect(result.rho).toBeNull()
    expect(result.significant).toBe(false)
  })

  it('reports too few pairs as not significant while still giving rho', () => {
    const xs = Array.from({ length: 10 }, (_, index) => index)
    const result = spearman(pairsFrom(xs, xs))

    expect(result.n).toBe(10)
    expect(result.rho).toBeCloseTo(1, 10)
    // Below the sample floor the relationship is not claimable.
    expect(result.significant).toBe(false)
    expect(CORRELATION_MIN_SAMPLES).toBe(30)
  })

  it('reports a weak relationship as not significant', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 40 }, (_, index) => [
      index,
      index % 2 ? index : 40 - index,
    ])
    const result = spearman(pairs)

    expect(Math.abs(result.rho as number)).toBeLessThan(0.3)
    expect(result.significant).toBe(false)
  })

  it('returns nothing for an empty input', () => {
    expect(spearman([])).toEqual({ rho: null, n: 0, significant: false })
  })
})

describe('weekdayMedians', () => {
  it('returns one entry per weekday, Monday first', () => {
    // 2026-06-01 is a Monday.
    const points = Array.from({ length: 28 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 5, 1 + index))
      return { date: date.toISOString().slice(0, 10), value: index }
    })
    const result = weekdayMedians(points)

    expect(result).toHaveLength(7)
    expect(result[0].weekday).toBe(1)
    expect(result[6].weekday).toBe(0)
    expect(result.every((entry) => entry.n === 4)).toBe(true)
  })

  it('takes the median, not the mean, so one outlier does not move it', () => {
    const points = [
      { date: '2026-06-01', value: 10 },
      { date: '2026-06-08', value: 12 },
      { date: '2026-06-15', value: 14 },
      { date: '2026-06-22', value: 10_000 },
    ]
    const monday = weekdayMedians(points).find((entry) => entry.weekday === 1)

    expect(monday?.median).toBe(13)
    expect(monday?.n).toBe(4)
  })

  it('reports a weekday with no data as null rather than zero', () => {
    const monday = { date: '2026-06-01', value: 5 }
    const result = weekdayMedians([monday])
    const tuesday = result.find((entry) => entry.weekday === 2)

    expect(tuesday?.median).toBeNull()
    expect(tuesday?.n).toBe(0)
  })

  it('skips gaps without counting them', () => {
    const points = [
      { date: '2026-06-01', value: 10 },
      { date: '2026-06-08', value: null },
      { date: '2026-06-15', value: 20 },
    ]
    const monday = weekdayMedians(points).find((entry) => entry.weekday === 1)

    expect(monday?.median).toBe(15)
    expect(monday?.n).toBe(2)
  })
})
