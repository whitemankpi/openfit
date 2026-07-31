'use strict'

const CACHE_VERSION = 2

function emptyArchive() {
  return { version: CACHE_VERSION, lastDate: null, days: {}, attempted: [] }
}

function attemptedDates(value) {
  return Array.isArray(value?.attempted) ? [...new Set(value.attempted.filter((date) => typeof date === 'string'))].sort() : []
}

function normalizeArchive(value) {
  if (value?.version === CACHE_VERSION && value.days && typeof value.days === 'object') {
    return {
      version: CACHE_VERSION,
      lastDate: typeof value.lastDate === 'string' ? value.lastDate : null,
      days: { ...value.days },
      attempted: attemptedDates(value),
    }
  }

  // Version 1 stored one raw payload directly in the encrypted cache file.
  if (value && typeof value === 'object' && typeof value.date === 'string') {
    return { version: CACHE_VERSION, lastDate: value.date, days: { [value.date]: value }, attempted: [] }
  }

  return emptyArchive()
}

function cachedDay(value, date) {
  return normalizeArchive(value).days[date] || null
}

function latestDay(value) {
  const archive = normalizeArchive(value)
  if (archive.lastDate && archive.days[archive.lastDate]) return archive.days[archive.lastDate]
  const dates = Object.keys(archive.days).sort()
  return dates.length ? archive.days[dates.at(-1)] : null
}

function storeDay(value, payload) {
  const archive = normalizeArchive(value)
  const lastDate = [archive.lastDate, payload.date].filter(Boolean).sort().at(-1) || null
  return {
    version: CACHE_VERSION,
    lastDate,
    days: { ...archive.days, [payload.date]: payload },
    // A day that finally arrived is no longer an unsuccessful attempt.
    attempted: archive.attempted.filter((date) => date !== payload.date),
  }
}

/**
 * Records a day the provider had nothing for, so a repeated backfill does not
 * spend the rate limit asking again for a day that will never arrive.
 */
function markAttempted(value, date) {
  const archive = normalizeArchive(value)
  if (archive.days[date] || archive.attempted.includes(date)) return archive
  return { ...archive, attempted: [...archive.attempted, date].sort() }
}

function comparableDay(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const { generatedAt: _generatedAt, cacheHit: _cacheHit, ...content } = payload
  if (Array.isArray(content.errors)) content.errors = [...content.errors].sort((left, right) => String(left?.key || '').localeCompare(String(right?.key || '')))
  if (Array.isArray(content.requestStats?.successfulKeys)) {
    content.requestStats = { ...content.requestStats, successfulKeys: [...content.requestStats.successfulKeys].sort() }
  }
  return content
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function sameDayContent(left, right) {
  return JSON.stringify(canonicalize(comparableDay(left))) === JSON.stringify(canonicalize(comparableDay(right)))
}

module.exports = { CACHE_VERSION, normalizeArchive, cachedDay, latestDay, storeDay, markAttempted, sameDayContent }
