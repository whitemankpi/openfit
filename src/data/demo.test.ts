import { describe, expect, it } from 'vitest'
import { createDemoData, createDemoHistory } from './demo'

describe('createDemoData', () => {
  it('creates a complete deterministic dashboard for the selected date', () => {
    const first = createDemoData('2026-06-22')
    const second = createDemoData('2026-06-22')

    expect(first.selectedDate).toBe('2026-06-22')
    expect(first.activity.steps).toBe(second.activity.steps)
    expect(first.trends).toHaveLength(365)
    expect(first.trends.at(-1)?.date).toBe('2026-06-22')
    expect(first.health.heartRateIntraday).toHaveLength(48)
    expect(first.sleep.stages.reduce((sum, stage) => sum + stage.minutes, 0)).toBeGreaterThan(0)
  })

  it('produces mutually consistent heart-rate fields on every trend day', () => {
    const { trends } = createDemoData('2026-06-22')

    for (const point of trends) {
      expect(point.heartRateMin).not.toBeNull()
      expect(point.sleepingHeartRate).not.toBeNull()
      expect(point.heartRateAvg).not.toBeNull()
      expect(point.heartRateMax).not.toBeNull()
      expect(point.heartRateMin!).toBeLessThanOrEqual(point.sleepingHeartRate!)
      expect(point.sleepingHeartRate!).toBeLessThanOrEqual(point.heartRateAvg!)
      expect(point.heartRateAvg!).toBeLessThanOrEqual(point.heartRateMax!)
    }
  })

  it('is deterministic across repeated calls with the same date', () => {
    // generatedAt/device.lastSyncTime are wall-clock timestamps by design, so
    // compare everything else rather than the whole object.
    const { generatedAt: _first, device: firstDevice, ...first } = createDemoData('2026-06-22')
    const { generatedAt: _second, device: secondDevice, ...second } = createDemoData('2026-06-22')
    expect(first).toEqual(second)
    expect({ ...firstDevice, lastSyncTime: null }).toEqual({ ...secondDevice, lastSyncTime: null })
  })
})

describe('createDemoHistory', () => {
  it('returns one history day per trend day, oldest first', () => {
    const data = createDemoData('2026-06-22')
    const history = createDemoHistory('2026-06-22')

    expect(history.days).toHaveLength(data.trends.length)
    expect(history.days.map((day) => day.date)).toEqual(data.trends.map((point) => point.date))
    history.days.forEach((day, index) => {
      expect(day.trend).toEqual(data.trends[index])
    })
  })

  it('only carries intraday for the most recent 30 days', () => {
    const history = createDemoHistory('2026-06-22')
    const total = history.days.length

    history.days.forEach((day, index) => {
      const isRecent = index >= total - 30
      if (isRecent) {
        expect(day.heartIntraday).not.toBeNull()
        expect(day.heartIntraday!.length).toBeGreaterThan(0)
        expect(day.heartZoneMinutes).not.toBeNull()
      } else {
        expect(day.heartIntraday).toBeNull()
        expect(day.heartZoneMinutes).toBeNull()
      }
    })
  })

  it('reports the maximum heart rate across the generated days', () => {
    const history = createDemoHistory('2026-06-22')
    const expectedMax = Math.max(...history.days.map((day) => day.trend.heartRateMax ?? -Infinity))
    expect(history.maxHeartRate).toBe(expectedMax)
  })

  it('is deterministic across repeated calls with the same date', () => {
    const first = createDemoHistory('2026-06-22')
    const second = createDemoHistory('2026-06-22')
    expect(first).toEqual(second)
  })
})
