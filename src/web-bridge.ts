import type { FitbitBridge, HealthAssistantBridge, HealthAssistantEvent } from './types'

const authListeners = new Set<Parameters<FitbitBridge['onAuthComplete']>[0]>()
const syncListeners = new Set<Parameters<FitbitBridge['onSyncProgress']>[0]>()
const dataListeners = new Set<Parameters<FitbitBridge['onDataUpdated']>[0]>()
const assistantListeners = new Set<(event: HealthAssistantEvent) => void>()
let dataEvents: EventSource | null = null

function ensureDataEvents(): void {
  if (dataEvents) return
  dataEvents = new EventSource('/api/events', { withCredentials: true })
  dataEvents.addEventListener('data-updated', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data)
      dataListeners.forEach((listener) => listener(payload))
    } catch { /* ignore malformed server events */ }
  })
  dataEvents.addEventListener('assistant', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data) as HealthAssistantEvent
      assistantListeners.forEach((listener) => listener(payload))
    } catch { /* ignore malformed server events */ }
  })
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || `Request failed (${response.status}).`)
  }
  return response.json() as Promise<T>
}

async function watchOAuth(sequence: number): Promise<void> {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const result = await request<{ sequence: number; ok: boolean; error?: string }>('/api/oauth/status')
    if (result.sequence > sequence) {
      authListeners.forEach((listener) => listener({ ok: result.ok, error: result.error }))
      return
    }
  }
  authListeners.forEach((listener) => listener({ ok: false, error: 'The OAuth session expired.' }))
}

const bridge: FitbitBridge = {
  getStatus: () => request('/api/status'),
  saveConfig: (config) => request('/api/config', { method: 'POST', body: JSON.stringify(config) }),
  connect: async () => {
    const result = await request<{ ok: boolean; url: string; sequence: number }>('/api/oauth/start', { method: 'POST' })
    const popup = window.open(result.url, 'openfit-oauth', 'popup,width=620,height=760')
    if (!popup) throw new Error('Allow pop-ups for OpenFit to connect Google Health.')
    void watchOAuth(result.sequence)
    return { ok: true }
  },
  connectGoogleFit: async () => {
    const result = await request<{ ok: boolean; url: string; sequence: number }>('/api/google-fit/oauth/start', { method: 'POST' })
    const popup = window.open(result.url, 'openfit-google-fit-oauth', 'popup,width=620,height=760')
    if (!popup) throw new Error('Allow pop-ups for OpenFit to connect Google Fit.')
    void watchOAuth(result.sequence)
    return { ok: true }
  },
  disconnect: () => request('/api/disconnect', { method: 'POST' }),
  sync: async (date) => {
    syncListeners.forEach((listener) => listener({ completed: 0, total: 0, key: '', date }))
    return request('/api/sync', { method: 'POST', body: JSON.stringify({ date }) })
  },
  getCachedData: () => request('/api/cache'),
  getCachedArchive: () => request('/api/archive'),
  backfillHistory: (days) => request('/api/backfill', { method: 'POST', body: JSON.stringify({ days }) }),
  // The hosted server runs the import to completion in one request, so there is
  // no window in which a cancellation could take effect.
  cancelBackfill: async () => ({ canceled: false }),
  exportData: async () => {
    const response = await fetch('/api/export')
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || 'Export failed.')
    }
    const blobUrl = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = blobUrl
    anchor.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'openfit-archive.json'
    anchor.click()
    URL.revokeObjectURL(blobUrl)
    return { canceled: false }
  },
  openExternal: async (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
  onAuthComplete: (callback) => {
    authListeners.add(callback)
    return () => authListeners.delete(callback)
  },
  onSyncProgress: (callback) => {
    syncListeners.add(callback)
    return () => syncListeners.delete(callback)
  },
  // Per-day progress is not streamed by the hosted server; the SSE
  // `data-updated` events already tell the client when a day lands.
  onBackfillProgress: () => () => undefined,
  onDataUpdated: (callback) => {
    dataListeners.add(callback)
    ensureDataEvents()
    return () => {
      dataListeners.delete(callback)
      if (!dataListeners.size && !assistantListeners.size && dataEvents) {
        dataEvents.close()
        dataEvents = null
      }
    }
  },
}

if (!window.fitbit) window.fitbit = bridge

const assistantBridge: HealthAssistantBridge = {
  getStatus: () => request('/api/assistant/status'),
  startTurn: async (input) => {
    let app: { currentPage?: string; selectedDate?: string } = {}
    try { app = JSON.parse(input.healthContext)?.app || {} } catch { /* server falls back to latest */ }
    return request('/api/assistant/turn', {
      method: 'POST',
      body: JSON.stringify({ requestId: input.requestId, message: input.message, page: app.currentPage, selectedDate: app.selectedDate }),
    })
  },
  cancel: (requestId) => request('/api/assistant/cancel', { method: 'POST', body: JSON.stringify({ requestId }) }),
  reset: () => request('/api/assistant/reset', { method: 'POST' }),
  getConfig: () => request('/api/assistant/config'),
  saveConfig: (input) => request('/api/assistant/config', { method: 'POST', body: JSON.stringify(input) }),
  onEvent: (callback) => {
    assistantListeners.add(callback)
    ensureDataEvents()
    return () => {
      assistantListeners.delete(callback)
      if (!dataListeners.size && !assistantListeners.size && dataEvents) {
        dataEvents.close()
        dataEvents = null
      }
    }
  },
  respondToTool: async () => undefined,
  onToolRequest: () => () => undefined,
  getMemory: () => request('/api/assistant/memory'),
  addMemory: (input) => request('/api/assistant/memory', { method: 'POST', body: JSON.stringify(input) }),
  deleteMemory: (id) => request(`/api/assistant/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getInsights: () => request('/api/assistant/insights'),
  runInsight: (kind) => request('/api/assistant/insights/run', { method: 'POST', body: JSON.stringify({ kind }) }),
}

if (!window.healthAssistant) window.healthAssistant = assistantBridge
