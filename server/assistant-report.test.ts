import { describe, expect, it } from 'vitest'
import { parseInsightContent } from './assistant-report.js'

describe('parseInsightContent', () => {
  it('turns the model JSON into a structured report', () => {
    const report = parseInsightContent(JSON.stringify({
      headline: 'Recovery looks steadier',
      summary: 'Sleep improved while resting heart rate stayed near baseline.',
      signals: [{ label: 'Sleep', finding: 'Median duration rose.', evidence: '7h 31m vs 6h 58m · 7/7 days', tone: 'positive' }],
      action: { title: 'Keep tonight simple', detail: 'Repeat the same bedtime window.' },
      question: 'Did anything change in your evening routine?',
    }))
    expect(report.headline).toBe('Recovery looks steadier')
    expect(report.signals).toHaveLength(1)
    expect(report.body).toContain('7h 31m')
  })

  it('keeps a readable fallback when the model violates the schema', () => {
    expect(parseInsightContent('Plain useful response').body).toBe('Plain useful response')
  })
})
