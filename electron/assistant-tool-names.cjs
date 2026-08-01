'use strict'

// The closed allowlist main.cjs uses to validate a tool name and a tool
// catalog entry, independent of anything the renderer claims.
//
// The renderer sends its own `toolNames`/`tools` alongside a turn (see
// assistant:start-turn in main.cjs), but the renderer is not the adversary
// here — the model is, since it reads context containing user-supplied
// text. Trusting renderer-supplied input.toolNames as the allowlist would
// mean the allowlist is only as closed as whatever the renderer happened to
// send, which defeats the point of an allowlist checked in main. This list
// is main's own knowledge of the six tools that exist, kept independent of
// the renderer's message.
//
// This is the CommonJS twin of TOOL_NAMES in src/lib/assistant-tools.ts,
// which main.cjs cannot import (CommonJS cannot import that TypeScript
// module). The two are pinned to each other by
// electron/assistant-tool-names.test.ts, which asserts this exact array
// equals TOOL_NAMES — a change to one without the other fails that test.
const KNOWN_TOOL_NAMES = [
  'metric_window',
  'explain_score',
  'data_coverage',
  'compare_periods',
  'weekday_pattern',
  'correlate',
]

module.exports = { KNOWN_TOOL_NAMES }
