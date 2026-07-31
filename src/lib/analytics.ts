/** Pairs below this count cannot support a claimed relationship. */
export const CORRELATION_MIN_SAMPLES = 30
/** Below this magnitude the relationship is too weak to report as one. */
export const CORRELATION_MIN_RHO = 0.3

export interface CorrelationResult {
  rho: number | null
  n: number
  /** Whether the result clears both the sample floor and the strength floor. */
  significant: boolean
}

/**
 * Average ranks, so tied values share the mean of the ranks they span. Without
 * this, ties would silently bias the coefficient.
 */
function rank(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value)
  const ranks = new Array<number>(values.length)

  let position = 0
  while (position < order.length) {
    let end = position
    while (end + 1 < order.length && order[end + 1].value === order[position].value) end += 1
    const shared = (position + end) / 2 + 1
    for (let index = position; index <= end; index += 1) ranks[order[index].index] = shared
    position = end + 1
  }
  return ranks
}

/**
 * Spearman rather than Pearson: health relationships are monotonic far more
 * often than linear, and rank correlation is not thrown by the occasional
 * extreme day.
 */
export function spearman(pairs: Array<[number, number]>): CorrelationResult {
  const usable = pairs.filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right))
  const n = usable.length
  if (n < 3) return { rho: null, n, significant: false }

  const leftRanks = rank(usable.map(([left]) => left))
  const rightRanks = rank(usable.map(([, right]) => right))
  const meanRank = (n + 1) / 2

  let covariance = 0
  let leftVariance = 0
  let rightVariance = 0
  for (let index = 0; index < n; index += 1) {
    const left = leftRanks[index] - meanRank
    const right = rightRanks[index] - meanRank
    covariance += left * right
    leftVariance += left * left
    rightVariance += right * right
  }
  // A series with no variation has no ranks to correlate against.
  if (leftVariance === 0 || rightVariance === 0) return { rho: null, n, significant: false }

  const rho = covariance / Math.sqrt(leftVariance * rightVariance)
  return {
    rho: Math.round(rho * 1000) / 1000,
    n,
    significant: n >= CORRELATION_MIN_SAMPLES && Math.abs(rho) >= CORRELATION_MIN_RHO,
  }
}

export interface WeekdayStat {
  /** JavaScript weekday number: 0 is Sunday. */
  weekday: number
  median: number | null
  n: number
}

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Median per weekday, Monday first, because a weekly rhythm reads more
 * naturally starting from the working week.
 */
export function weekdayMedians(points: Array<{ date: string; value: number | null }>): WeekdayStat[] {
  const buckets = new Map<number, number[]>()
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) continue
    const weekday = new Date(`${point.date}T12:00:00Z`).getUTCDay()
    if (!Number.isFinite(weekday)) continue
    const bucket = buckets.get(weekday)
    if (bucket) bucket.push(point.value)
    else buckets.set(weekday, [point.value])
  }

  const mondayFirst = [1, 2, 3, 4, 5, 6, 0]
  return mondayFirst.map((weekday) => {
    const values = buckets.get(weekday) ?? []
    return { weekday, median: median(values), n: values.length }
  })
}
