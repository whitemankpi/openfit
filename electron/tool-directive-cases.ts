/**
 * Shared input/output table for the openfit:tool directive parser and
 * stripper, asserted from both sides of the CJS/TS split:
 * `electron/assistant-directives.test.ts` exercises `parseToolDirective` and
 * `stripToolDirective` (the CommonJS copies `main.cjs` actually runs), and
 * `src/lib/health-assistant.test.ts` exercises `parseAssistantToolRequest`
 * and `stripAssistantToolRequest` (the TypeScript copies the renderer runs)
 * against this exact same table.
 *
 * `expectedStripped` matters as much as `expected`: a missed strip leaks a
 * raw `<!-- openfit:tool ... -->` HTML comment straight into the answer the
 * user sees, so divergence there is user-visible in a way a parse mismatch
 * alone is not.
 *
 * Whoever edits one parser's rejection rules must edit this file too, or one
 * of the two suites starts asserting a case this file no longer describes —
 * that mismatch is the drift alarm. Do not duplicate this table inline in
 * either test file.
 */
export interface ToolDirectiveCase {
  description: string
  text: string
  expected: { name: string; args: Record<string, unknown> } | null
  expectedStripped: string
}

export const TOOL_DIRECTIVE_CASES: ToolDirectiveCase[] = [
  {
    description: 'malformed JSON is ignored rather than throwing',
    text: '<!-- openfit:tool {not json} -->',
    expected: null,
    expectedStripped: '',
  },
  {
    description: 'a directive with no name is refused',
    text: '<!-- openfit:tool {"args":{}} -->',
    expected: null,
    expectedStripped: '',
  },
  {
    description: 'args as a string is refused, so the dispatcher is never handed a string',
    text: '<!-- openfit:tool {"name":"x","args":"steps"} -->',
    expected: null,
    expectedStripped: '',
  },
  {
    description: 'args as an array is refused',
    text: '<!-- openfit:tool {"name":"x","args":["steps"]} -->',
    expected: null,
    expectedStripped: '',
  },
  {
    description: 'two directives in one message — only the first is honoured, but both are stripped',
    text: '<!-- openfit:tool {"name":"a"} --><!-- openfit:tool {"name":"b"} -->',
    expected: { name: 'a', args: {} },
    expectedStripped: '',
  },
  {
    description: 'surrounding and internal whitespace is tolerated',
    text: '  \n<!--   openfit:tool   {"name":"metric_window","args":{"metric":"steps"}}   -->\n  ',
    expected: { name: 'metric_window', args: { metric: 'steps' } },
    expectedStripped: '',
  },
  {
    description: 'an unrelated openfit:navigate directive is not mistaken for a tool request, nor stripped by it',
    text: 'Opening.\n<!-- openfit:navigate {"page":"sleep"} -->',
    expected: null,
    expectedStripped: 'Opening.\n<!-- openfit:navigate {"page":"sleep"} -->',
  },
]
