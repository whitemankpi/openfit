import type { FitbitBridge } from './types'

const authListeners = new Set<Parameters<FitbitBridge['onAuthComplete']>[0]>()
const syncListeners = new Set<Parameters<FitbitBridge['onSyncProgress']>[0]>()

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
  disconnect: () => request('/api/disconnect', { method: 'POST' }),
  sync: async (date) => {
    syncListeners.forEach((listener) => listener({ completed: 0, total: 0, key: '', date }))
    return request('/api/sync', { method: 'POST', body: JSON.stringify({ date }) })
  },
  getCachedData: () => request('/api/cache'),
  getCachedArchive: () => request('/api/archive'),
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
}

if (!window.fitbit) window.fitbit = bridge
