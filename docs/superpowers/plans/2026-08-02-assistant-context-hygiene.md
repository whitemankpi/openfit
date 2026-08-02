# Assistant context hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop both assistant providers from accumulating dead context — stale manifests in Codex's thread, spent tool traffic in DeepSeek's resent history.

**Architecture:** Two independent adapter-local changes. Codex gains a per-thread hash of the last manifest it sent and skips the context wrapper when it has not changed. DeepSeek retains only user and answer text after a turn, capped, and declares the trim when one happened. Nothing above the adapters changes; `main.cjs` keeps passing the manifest on every turn and each adapter decides what to do with it.

**Tech Stack:** Electron 38 (CommonJS in `electron/`), Node 22, Vitest 4.

Spec: `docs/superpowers/specs/2026-08-02-assistant-context-hygiene-design.md`.

## Global Constraints

- Node >= 22, npm >= 10. CI runs exactly `npm run check` (typecheck + check:electron + test + build:web).
- `electron/*.cjs` is plain CommonJS, never compiled by `tsc`. `check:electron` runs `node --check` over every `.cjs` file — syntax only, so no type error will be caught for you.
- No test may reach the network. Both adapters already have stub harnesses; use them.
- `electron/assistant-codex.cjs` is 877 lines implementing a JSONL protocol. A careless edit there breaks the whole assistant.
- DeepSeek's base URL stays the fixed literal `https://api.deepseek.com`.
- Nothing is sent to a model until the user sends a message.
- History cap: **20 exchanges or 16384 bytes**, whichever comes first, dropping oldest first.
- Never stage, modify, or delete `docs/PRD_AMAZFIT_INTEGRATION.md` (untracked, user-owned).
- Commit with `git add <explicit paths>` — never `git add -A`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `electron/assistant-codex.cjs` | Codex adapter. Gains a `_lastContextHash` cleared wherever `_threadId` is. | Modify |
| `electron/assistant-codex.test.ts` | Codex adapter tests. | Modify |
| `electron/assistant-history.cjs` | New. Pure functions: prune a completed turn to text, apply the cap, report whether a trim happened. No I/O, no provider knowledge. | Create |
| `electron/assistant-history.test.ts` | Tests for the above. | Create |
| `electron/assistant-deepseek.cjs` | DeepSeek adapter. Uses the pruning module; inserts the trim notice. | Modify |
| `electron/assistant-deepseek.test.ts` | DeepSeek adapter tests. | Modify |

The pruning logic goes in its own module rather than inline in the adapter, following `assistant-config.cjs`, `assistant-dispatch.cjs`, and `assistant-directives.cjs` — every piece of business logic in `electron/` that is worth testing lives in a module that exports pure functions, because `main.cjs` and the adapters are awkward to test directly.

---

## Task 1: Codex sends the manifest only when it changed

**Files:**
- Modify: `electron/assistant-codex.cjs` — `_beginTurn` around line 388, plus the four sites that clear `_threadId` (lines 246, 342, 363, 822)
- Modify: `electron/assistant-codex.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no new exports. Externally observable change only: `turn/start`'s `input` array omits the context item when the manifest matches the one already sent on this thread.

- [ ] **Step 1: Write the failing tests**

Append to `electron/assistant-codex.test.ts`, inside the existing top-level `describe`. Use the same stub harness the neighbouring tests use — read one of them first to match how a service is constructed and driven.

```ts
it('omits the manifest on a second turn when it has not changed', async () => {
  const { service, sent, completeTurn } = createStubbedService({})

  const first = service.startTurn({ text: 'How did I sleep?', healthContext: '{"a":1}' })
  await vi.waitFor(() => expect(sent.find((m) => m.method === 'turn/start')).toBeTruthy())
  await completeTurn()
  await first

  sent.length = 0
  const second = service.startTurn({ text: 'And the week before?', healthContext: '{"a":1}' })
  const turn = await vi.waitFor(() => {
    const found = sent.find((m) => m.method === 'turn/start')
    expect(found).toBeTruthy()
    return found
  })

  expect(turn.params.input).toEqual([
    { type: 'text', text: 'And the week before?', text_elements: [] },
  ])
  await completeTurn()
  await second
})

it('sends the manifest again when it changed', async () => {
  const { service, sent, completeTurn } = createStubbedService({})

  const first = service.startTurn({ text: 'x', healthContext: '{"a":1}' })
  await vi.waitFor(() => expect(sent.find((m) => m.method === 'turn/start')).toBeTruthy())
  await completeTurn()
  await first

  sent.length = 0
  const second = service.startTurn({ text: 'y', healthContext: '{"a":2}' })
  const turn = await vi.waitFor(() => {
    const found = sent.find((m) => m.method === 'turn/start')
    expect(found).toBeTruthy()
    return found
  })

  expect(turn.params.input).toHaveLength(2)
  expect(turn.params.input[0].text).toContain('{"a":2}')
  await completeTurn()
  await second
})

it('sends the manifest again on the first turn after a reset', async () => {
  const { service, sent, completeTurn } = createStubbedService({})

  const first = service.startTurn({ text: 'x', healthContext: '{"a":1}' })
  await vi.waitFor(() => expect(sent.find((m) => m.method === 'turn/start')).toBeTruthy())
  await completeTurn()
  await first

  await service.reset()
  sent.length = 0

  const second = service.startTurn({ text: 'y', healthContext: '{"a":1}' })
  const turn = await vi.waitFor(() => {
    const found = sent.find((m) => m.method === 'turn/start')
    expect(found).toBeTruthy()
    return found
  })

  // The thread is gone, so the new one has never seen this manifest.
  expect(turn.params.input).toHaveLength(2)
  await completeTurn()
  await second
})
```

The harness is already suitable, verified before this plan was written: `createStubbedService` (`electron/assistant-codex.test.ts:76`) returns `sent` as the fake child's mutable `messages` array — so `sent.length = 0` between turns works — and `completeTurn()` answers with a fixed `turn-tools` id that the stubbed `turn/start` hands out for every turn, so it completes the second turn as readily as the first. `reset()` clears `_threadId` at `electron/assistant-codex.cjs:342`, which is what makes the third test meaningful.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/assistant-codex.test.ts`
Expected: the first test FAILS — `input` still has two items, because every turn currently sends the manifest.

- [ ] **Step 3: Add the hash and the skip**

In `electron/assistant-codex.cjs`, add near the top with the other module-level helpers:

```js
const crypto = require('node:crypto')

/**
 * The Codex thread is server-side and keeps everything it was ever sent, so a
 * manifest pushed on every turn accumulates: ten questions leave nine stale
 * copies naming other selected dates, and the model can read the wrong one.
 * Send it only when it actually changed.
 */
function contextFingerprint(context) {
  if (!context) return null
  try {
    return crypto.createHash('sha256').update(context).digest('hex')
  } catch {
    // Failing toward sending is the safe direction: a redundant manifest costs
    // tokens, a missing one costs correctness.
    return null
  }
}
```

In the constructor, beside `this._threadId = null` (line 246):

```js
    this._lastContextHash = null
```

Clear it at each of the other three sites that clear `_threadId` — lines 342, 363, and 822 — by adding immediately after each `this._threadId = null`:

```js
      this._lastContextHash = null
```

Then in `_beginTurn`, replace the existing context gate:

```js
      const input = []
      const fingerprint = contextFingerprint(active.context)
      const alreadySent = fingerprint !== null && fingerprint === this._lastContextHash
      if (active.context && !alreadySent) {
        input.push({
          type: 'text',
          text: `<OPENFIT_HEALTH_CONTEXT>\n${active.context}\n</OPENFIT_HEALTH_CONTEXT>`,
          text_elements: [],
        })
        this._lastContextHash = fingerprint
      }
      input.push({ type: 'text', text: active.text, text_elements: [] })
```

Keep the existing comment above the block explaining why a follow-up directive turn carries no context; this adds a second reason to skip, it does not replace the first.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/assistant-codex.test.ts`
Expected: PASS, including the pre-existing assertion at line 188 that a first turn sends two items — no hash is stored yet on a fresh thread.

- [ ] **Step 5: Verify CommonJS syntax**

Run: `npm run check:electron`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/assistant-codex.cjs electron/assistant-codex.test.ts
git commit -m "perf(assistant): send Codex a manifest only when it changed"
```

---

## Task 2: History pruning as a pure module

**Files:**
- Create: `electron/assistant-history.cjs`
- Create: `electron/assistant-history.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```js
pruneExchange(turnMessages)   // → [{role:'user',content}, {role:'assistant',content}]
applyHistoryCap(history)      // → { history, trimmed: boolean }
MAX_HISTORY_EXCHANGES         // 20
MAX_HISTORY_BYTES             // 16384
```

`pruneExchange` takes the messages a single completed turn produced — the user message, any assistant message carrying `tool_calls`, any `tool` result messages, and the final answer — and returns just the user message and the final answer. `applyHistoryCap` takes a flat array of already-pruned messages and drops whole oldest exchanges until both limits are met.

- [ ] **Step 1: Write the failing test**

Create `electron/assistant-history.test.ts`:

```ts
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { pruneExchange, applyHistoryCap, MAX_HISTORY_EXCHANGES, MAX_HISTORY_BYTES } = require('./assistant-history.cjs') as {
  pruneExchange: (messages: any[]) => any[]
  applyHistoryCap: (history: any[]) => { history: any[]; trimmed: boolean }
  MAX_HISTORY_EXCHANGES: number
  MAX_HISTORY_BYTES: number
}

const exchange = (n: number, size = 10) => ([
  { role: 'user', content: `q${n}`.padEnd(size, 'x') },
  { role: 'assistant', content: `a${n}`.padEnd(size, 'y') },
])

describe('pruneExchange', () => {
  it('keeps the question and the answer', () => {
    const result = pruneExchange([
      { role: 'user', content: 'how did I sleep?' },
      { role: 'assistant', content: 'You slept 7h20m.' },
    ])

    expect(result).toEqual([
      { role: 'user', content: 'how did I sleep?' },
      { role: 'assistant', content: 'You slept 7h20m.' },
    ])
  })

  it('drops the tool call and its result, which the answer already reports', () => {
    const result = pruneExchange([
      { role: 'user', content: 'steps last month?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'metric_window', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"median":8000,"n":30}' },
      { role: 'assistant', content: 'You averaged 8 000 steps over 30 days.' },
    ])

    expect(result).toEqual([
      { role: 'user', content: 'steps last month?' },
      { role: 'assistant', content: 'You averaged 8 000 steps over 30 days.' },
    ])
  })

  it('drops several rounds of tool traffic', () => {
    const result = pruneExchange([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c2', content: '{}' },
      { role: 'assistant', content: 'answer' },
    ])

    expect(result).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'answer' },
    ])
  })

  it('returns nothing usable when the turn produced no answer', () => {
    const result = pruneExchange([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ])

    expect(result).toEqual([])
  })
})

describe('applyHistoryCap', () => {
  it('leaves a short history alone', () => {
    const history = [...exchange(1), ...exchange(2)]
    const result = applyHistoryCap(history)

    expect(result.history).toEqual(history)
    expect(result.trimmed).toBe(false)
  })

  it('drops the oldest exchanges past the count limit', () => {
    const history = Array.from({ length: MAX_HISTORY_EXCHANGES + 3 }, (_, index) => exchange(index)).flat()
    const result = applyHistoryCap(history)

    expect(result.history).toHaveLength(MAX_HISTORY_EXCHANGES * 2)
    expect(result.trimmed).toBe(true)
    // The newest survives, the oldest does not.
    expect(result.history.at(-2).content).toContain(`q${MAX_HISTORY_EXCHANGES + 2}`)
    expect(result.history[0].content).not.toContain('q0x')
  })

  it('drops the oldest exchanges past the byte limit', () => {
    const big = Math.ceil(MAX_HISTORY_BYTES / 4)
    const history = [...exchange(1, big), ...exchange(2, big), ...exchange(3, big)]
    const result = applyHistoryCap(history)

    expect(result.trimmed).toBe(true)
    expect(result.history.length).toBeLessThan(history.length)
    expect(JSON.stringify(result.history).length).toBeLessThanOrEqual(MAX_HISTORY_BYTES)
  })

  it('keeps the most recent exchange even when it alone exceeds the byte limit', () => {
    const huge = MAX_HISTORY_BYTES * 2
    const result = applyHistoryCap([...exchange(1), ...exchange(2, huge)])

    // An empty history with no marker would read as a fresh conversation.
    expect(result.history).toHaveLength(2)
    expect(result.history[0].content).toContain('q2')
    expect(result.trimmed).toBe(true)
  })

  it('reports the agreed limits', () => {
    expect(MAX_HISTORY_EXCHANGES).toBe(20)
    expect(MAX_HISTORY_BYTES).toBe(16384)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/assistant-history.test.ts`
Expected: FAIL — cannot find `./assistant-history.cjs`.

- [ ] **Step 3: Write the implementation**

Create `electron/assistant-history.cjs`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/assistant-history.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Verify CommonJS syntax**

Run: `npm run check:electron`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/assistant-history.cjs electron/assistant-history.test.ts
git commit -m "feat(assistant): add history pruning and cap helpers"
```

---

## Task 3: DeepSeek retains text only, capped, and says when it trimmed

**Files:**
- Modify: `electron/assistant-deepseek.cjs` — the `messages` assembly around line 99 and the retention at line 125
- Modify: `electron/assistant-deepseek.test.ts`

**Interfaces:**
- Consumes: `pruneExchange`, `applyHistoryCap` from `electron/assistant-history.cjs` (Task 2).
- Produces: no new exports. Observable change: retained history holds text only; a trimmed history adds one `system` message after the manifest.

- [ ] **Step 1: Write the failing tests**

Append to `electron/assistant-deepseek.test.ts`, following the stub-`fetch` pattern the existing tests use:

```ts
it('keeps only the question and the answer, not the tool traffic', async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(toolReply('metric_window', { metric: 'steps' }))
    .mockResolvedValueOnce(reply('You averaged 8 000 steps.'))
    .mockResolvedValueOnce(reply('Second answer.'))
  const onToolCall = vi.fn(async () => ({ ok: true, result: { median: 8000, n: 30 } }))
  const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

  await service.startTurn({ text: 'steps?', healthContext: '{}', tools: [], onToolCall })
  await service.startTurn({ text: 'and sleep?', healthContext: '{}', tools: [], onToolCall })

  const body = JSON.parse((fetchImpl.mock.calls[2] as any)[1].body)
  const roles = body.messages.map((message: any) => message.role)

  expect(roles).not.toContain('tool')
  expect(body.messages.some((m: any) => Array.isArray(m.tool_calls))).toBe(false)
  expect(body.messages.map((m: any) => m.content)).toEqual(
    expect.arrayContaining(['steps?', 'You averaged 8 000 steps.', 'and sleep?']),
  )
})

it('declares a trimmed history with a system notice after the manifest', async () => {
  const fetchImpl = vi.fn(async () => reply('ok'))
  const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

  // Enough turns to pass the 20-exchange cap.
  for (let turn = 0; turn < 22; turn += 1) {
    await service.startTurn({ text: `question ${turn}`, healthContext: '{}', tools: [] })
  }

  const body = JSON.parse((fetchImpl.mock.calls.at(-1) as any)[1].body)
  const notice = body.messages[2]

  expect(body.messages[0].role).toBe('system')
  expect(body.messages[1].content).toContain('OPENFIT_HEALTH_CONTEXT')
  expect(notice.role).toBe('system')
  expect(notice.content).toMatch(/earlier turns/i)
  expect(body.messages.filter((m: any) => m.role === 'user')).toHaveLength(21)
})

it('adds no notice while the history is short', async () => {
  const fetchImpl = vi.fn(async () => reply('ok'))
  const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

  await service.startTurn({ text: 'one', healthContext: '{}', tools: [] })
  await service.startTurn({ text: 'two', healthContext: '{}', tools: [] })

  const body = JSON.parse((fetchImpl.mock.calls.at(-1) as any)[1].body)
  expect(body.messages.filter((m: any) => m.role === 'system')).toHaveLength(1)
})
```

The last assertion of the trim test counts 21 users because the cap keeps 20 retained exchanges plus the current turn's own message, which is not yet history.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/assistant-deepseek.test.ts`
Expected: the first test FAILS — `tool` messages are still retained.

- [ ] **Step 3: Wire in the pruning**

In `electron/assistant-deepseek.cjs`, require the module beside the existing requires:

```js
const { pruneExchange, applyHistoryCap } = require('./assistant-history.cjs')
```

Replace the `messages` assembly in `startTurn` so the notice can be inserted:

```js
    const historySnapshot = conversationHistory
    const capped = applyHistoryCap(historySnapshot)
    const userMessage = { role: 'user', content: text }
    const messages = [
      { role: 'system', content: DEVELOPER_INSTRUCTIONS },
      { role: 'user', content: `<OPENFIT_HEALTH_CONTEXT>\n${healthContext}\n</OPENFIT_HEALTH_CONTEXT>` },
      // Recomputed per request, never stored: the history itself holds only
      // real exchanges. A system role rather than text glued to a user turn,
      // so it cannot be mistaken for something the user said.
      ...(capped.trimmed
        ? [{ role: 'system', content: 'Earlier turns in this conversation were omitted to stay within the context limit.' }]
        : []),
      ...capped.history,
      userMessage,
    ]
```

Then replace the retention at the end of the turn:

```js
          const turnExchange = messages.slice(messages.indexOf(userMessage))
          conversationHistory = [
            ...capped.history,
            ...pruneExchange([...turnExchange, { role: 'assistant', content: answer }]),
          ]
```

Note the retention now starts from `capped.history`, not `historySnapshot` — a history already dropped by the cap must not come back on the next turn.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/assistant-deepseek.test.ts`
Expected: PASS. The existing conversation-memory tests must still pass unmodified — a second turn still carries the first exchange, and `reset()` still clears it.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/assistant-deepseek.cjs electron/assistant-deepseek.test.ts
git commit -m "perf(assistant): retain only text in DeepSeek history, capped"
```

---

## Task 4: Record the behaviour in the architecture doc

**Files:**
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Read what the doc currently claims**

`docs/ARCHITECTURE.md` describes the assistant's context as the manifest replacing the archive dump. It says nothing about what persists between turns, which is now a deliberate design rather than an accident.

- [ ] **Step 2: Add the paragraph**

In the assistant section, after the manifest description, state: the Codex thread is server-side and receives the manifest only when it changed, tracked by a per-thread hash cleared with the thread; DeepSeek is stateless, so its retained history holds question and answer text only, capped at 20 exchanges or 16384 bytes, and a request whose history was trimmed carries a system notice saying so. Keep the existing voice — plain declarative English, no marketing register.

- [ ] **Step 3: Run the gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(assistant): describe per-provider context retention"
```

---

## Manual verification

Tests cover the mechanics; they cannot show whether conversations feel better. After Task 4, on each provider in turn:

- [ ] Hold a dozen-turn conversation with several tool calls, changing the selected date partway through. Confirm answers track the current date rather than an earlier one — this is the failure the Codex fix targets.
- [ ] On DeepSeek, confirm a long conversation still answers coherently after passing 20 exchanges, and that it does not claim to remember something from before the trim.
