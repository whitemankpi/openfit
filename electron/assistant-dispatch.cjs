'use strict'

const DEFAULT_MAX_CALLS = 8
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RESULT_BYTES = 4096

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sits between a model and the tool implementations.
 *
 * The tool name arrives from a model that has read context containing
 * user-supplied text, so it is checked against a closed allowlist rather than
 * looked up dynamically. The result is checked on the way back so a bug in a
 * tool cannot hand the model an arbitrary object.
 */
function createDispatcher({
  allowedNames,
  execute,
  maxCalls = DEFAULT_MAX_CALLS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
}) {
  const allowed = new Set(allowedNames)
  let callCount = 0

  async function call(name, args) {
    if (callCount >= maxCalls) {
      return { ok: false, error: `Tool call limit of ${maxCalls} reached for this turn. Answer with what you already have.` }
    }
    callCount += 1
    if (!allowed.has(name)) {
      return { ok: false, error: `Unknown tool "${String(name)}". Available: ${[...allowed].join(', ')}.` }
    }
    if (!isPlainObject(args)) {
      return { ok: false, error: 'Tool arguments must be a JSON object.' }
    }
    let timer = null
    try {
      const result = await Promise.race([
        Promise.resolve(execute(name, args)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        }),
      ])
      if (!isPlainObject(result)) {
        return { ok: false, error: 'The tool returned an unexpected shape; expected a JSON object.' }
      }
      const serialised = JSON.stringify(result)
      if (Buffer.byteLength(serialised, 'utf8') > maxResultBytes) {
        return { ok: false, error: `The tool result is too large (limit ${maxResultBytes} bytes). Narrow the range.` }
      }
      return { ok: true, result }
    } catch (error) {
      if (error instanceof Error && error.message === 'timeout') {
        return { ok: false, error: `The tool timed out after ${timeoutMs} ms.` }
      }
      return { ok: false, error: 'The tool could not be executed.' }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    call,
    reset() { callCount = 0 },
    get callCount() { return callCount },
  }
}

module.exports = { createDispatcher, DEFAULT_MAX_CALLS, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESULT_BYTES }
