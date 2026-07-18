export const historySyncIntervalMs = 60 * 60_000

export type SyncSchedulerState = {
  lastFinalizedDate?: string
  lastHistorySyncAt?: string
}

export function historySyncDue(state: SyncSchedulerState, now = Date.now()): boolean {
  const lastSyncAt = Date.parse(String(state.lastHistorySyncAt || ''))
  return !Number.isFinite(lastSyncAt) || now - lastSyncAt >= historySyncIntervalMs
}
