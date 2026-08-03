import type { AssistantInsightReport } from '../src/types.js'

type InsightContent = Pick<AssistantInsightReport, 'headline' | 'summary' | 'signals' | 'action' | 'question' | 'body'>

function short(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

export function parseInsightContent(text: string): InsightContent {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  try {
    if (start < 0 || end <= start) throw new Error('No JSON object')
    const value = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const headline = short(value.headline, 120)
    const summary = short(value.summary, 420)
    const signals = Array.isArray(value.signals) ? value.signals.slice(0, 3).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const item = raw as Record<string, unknown>
      const label = short(item.label, 60)
      const finding = short(item.finding, 240)
      const evidence = short(item.evidence, 180)
      const tone = ['positive', 'watch', 'neutral'].includes(String(item.tone)) ? item.tone as 'positive' | 'watch' | 'neutral' : 'neutral'
      return label && finding && evidence ? [{ label, finding, evidence, tone }] : []
    }) : []
    const rawAction = value.action && typeof value.action === 'object' ? value.action as Record<string, unknown> : {}
    const action = { title: short(rawAction.title, 80), detail: short(rawAction.detail, 280) }
    const question = short(value.question, 220) || null
    if (!headline || !summary || !signals.length || !action.title || !action.detail) throw new Error('Incomplete insight')
    const body = [headline, summary, ...signals.map((signal) => `${signal.label}: ${signal.finding} (${signal.evidence})`), `${action.title}: ${action.detail}`, question || ''].filter(Boolean).join('\n\n')
    return { headline, summary, signals, action, question, body }
  } catch {
    return { body: cleaned.slice(0, 2400) }
  }
}
