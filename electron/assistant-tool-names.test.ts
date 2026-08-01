import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { TOOL_NAMES } from '../src/lib/assistant-tools'

const require = createRequire(import.meta.url)
const { KNOWN_TOOL_NAMES } = require('./assistant-tool-names.cjs') as { KNOWN_TOOL_NAMES: string[] }

// Pins main.cjs's own tool allowlist (electron/assistant-tool-names.cjs)
// against the actual tool catalog (src/lib/assistant-tools.ts). If a tool is
// ever added, renamed, or removed on one side without the other, this test
// fails instead of main quietly rejecting (or silently trusting) a name it
// does not recognise.
describe('main.cjs tool allowlist stays pinned to the real tool catalog', () => {
  it('matches TOOL_NAMES exactly', () => {
    expect(KNOWN_TOOL_NAMES).toEqual(TOOL_NAMES)
  })
})
