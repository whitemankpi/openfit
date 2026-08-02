'use strict'

/** Whole exchanges retained across turns. */
const MAX_HISTORY_EXCHANGES = 20
/** Serialised bytes of retained history. */
const MAX_HISTORY_BYTES = 16_384

/**
 * Reduces one completed turn to the part worth keeping.
 *
 * Tool calls and their results are needed inside a turn — the model must see
 * what it asked for and what came back — and redundant afterwards, because the
 * answer states the numbers it drew from them. On a stateless transport they
 * are also the bulkiest thing resent on every later request.
 */
function pruneExchange(turnMessages) {
  const messages = Array.isArray(turnMessages) ? turnMessages : []
  const user = messages.find((message) => message?.role === 'user')
  const answer = [...messages].reverse().find((message) => (
    message?.role === 'assistant'
    && !Array.isArray(message.tool_calls)
    && typeof message.content === 'string'
    && message.content.length > 0
  ))
  if (!user || !answer) return []
  return [
    { role: 'user', content: user.content },
    { role: 'assistant', content: answer.content },
  ]
}

function byteLength(history) {
  return Buffer.byteLength(JSON.stringify(history), 'utf8')
}

/**
 * Drops whole oldest exchanges until both limits hold. Eviction is right here,
 * unlike in memory: a conversation is transient and visible in the window,
 * while a memory entry is durable and invisible.
 */
function applyHistoryCap(history) {
  const source = Array.isArray(history) ? history : []
  // History is stored as consecutive user/assistant pairs, so an exchange is
  // always two entries.
  let exchanges = []
  for (let index = 0; index + 1 < source.length; index += 2) {
    exchanges.push([source[index], source[index + 1]])
  }
  const original = exchanges.length

  if (exchanges.length > MAX_HISTORY_EXCHANGES) {
    exchanges = exchanges.slice(-MAX_HISTORY_EXCHANGES)
  }
  while (exchanges.length > 1 && byteLength(exchanges.flat()) > MAX_HISTORY_BYTES) {
    exchanges.shift()
  }

  const flattened = exchanges.flat()
  return {
    history: flattened,
    trimmed: exchanges.length < original || byteLength(flattened) > MAX_HISTORY_BYTES,
  }
}

module.exports = { pruneExchange, applyHistoryCap, MAX_HISTORY_EXCHANGES, MAX_HISTORY_BYTES }
