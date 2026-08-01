'use strict'

// CommonJS twin of parseAssistantToolRequest/stripAssistantToolRequest in
// src/lib/health-assistant.ts. main.cjs cannot import that TypeScript module
// (the alternative was duplicating the whole normalisation stack instead of
// just this directive), so the regex and rejection rules are hand-kept in
// step with the source of truth. This module exists, rather than living
// inline in main.cjs, precisely so it can carry its own test file the way
// assistant-dispatch.cjs and assistant-config.cjs do — main.cjs itself has no
// exports and no tests, so anything left inline there is untestable.
//
// The two copies are pinned to each other by a shared table of inputs and
// expected outputs, asserted from both sides: see the "shared parser
// contract" describe block in this file's test, and the matching block in
// src/lib/health-assistant.test.ts. A change to one regex without the other
// fails both suites the next time either runs.
const TOOL_DIRECTIVE_PATTERN = /\s*<!--\s*openfit:tool\s+(\{[\s\S]*?\})\s*-->\s*/g

function parseToolDirective(text) {
  TOOL_DIRECTIVE_PATTERN.lastIndex = 0
  const match = TOOL_DIRECTIVE_PATTERN.exec(String(text || ''))
  if (!match) return null
  try {
    const value = JSON.parse(match[1])
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name) return null
    if (value.args !== undefined && (typeof value.args !== 'object' || value.args === null || Array.isArray(value.args))) {
      return null
    }
    return { name, args: value.args || {} }
  } catch {
    return null
  }
}

function stripToolDirective(text) {
  TOOL_DIRECTIVE_PATTERN.lastIndex = 0
  return String(text || '').replace(TOOL_DIRECTIVE_PATTERN, '').trim()
}

module.exports = { parseToolDirective, stripToolDirective }
