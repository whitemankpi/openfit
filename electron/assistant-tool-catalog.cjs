'use strict'

const { isPlainObject } = require('./assistant-dispatch.cjs')
const { KNOWN_TOOL_NAMES } = require('./assistant-tool-names.cjs')

// Extracted out of main.cjs (which has no exports and no test of its own) so
// it can be tested directly, the way assistant-dispatch.cjs and
// assistant-config.cjs already are.
//
// input.tools is the renderer's tool catalog, forwarded into Codex's prose
// tool instructions (assistant-codex.cjs's toolDirectiveInstructions) — the
// one place a model treats OpenFit's own message as instructions rather than
// data. Unlike healthContext, which main caps at MAX_HEALTH_CONTEXT_CHARS,
// this list previously went out unbounded and unchecked. This module gives
// it the same treatment: a hard cap on entry count, a name checked against
// KNOWN_TOOL_NAMES (never trusted from the entry itself), a capped
// description, and a schema that falls back to an empty object shape rather
// than forwarding whatever the renderer sent.
const MAX_TOOL_CATALOG_SIZE = 16
const MAX_TOOL_DESCRIPTION_CHARS = 500

function validToolName(name) {
  return KNOWN_TOOL_NAMES.includes(String(name || ''))
}

function validToolCatalog(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool) => isPlainObject(tool) && validToolName(tool.name))
    .slice(0, MAX_TOOL_CATALOG_SIZE)
    .map((tool) => ({
      name: String(tool.name),
      description: String(tool.description || '').slice(0, MAX_TOOL_DESCRIPTION_CHARS),
      schema: isPlainObject(tool.schema) ? tool.schema : { type: 'object', properties: {}, required: [] },
    }))
}

module.exports = { validToolCatalog, validToolName, MAX_TOOL_CATALOG_SIZE, MAX_TOOL_DESCRIPTION_CHARS }
