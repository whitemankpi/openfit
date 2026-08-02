# Assistant context hygiene

Design for what each provider actually carries between turns. Small, focused,
and a prerequisite for the memory work specified in
`docs/superpowers/specs/2026-07-31-assistant-memory-design.md` — memory adds load
to this pipeline, so the leaks are worth closing first.

## Why

The assistant's per-turn context was reduced from a 500 000-character archive
dump to a ~1300-character manifest. That fixed what each turn sends. It did not
fix what accumulates, and both providers accumulate — in opposite directions.

**Codex keeps every manifest it was ever sent.** `_threadId` persists across
turns (`electron/assistant-codex.cjs:423-441`), and every user turn pushes a
fresh manifest into that thread (`:388`). After ten questions the thread holds
ten manifests and nine are stale. This is not only waste: an old manifest names
a different selected date, so the model can read one and answer about the wrong
day.

**DeepSeek keeps every tool result forever.** The retained history is
`messages.slice(2 + historySnapshot.length)` (`electron/assistant-deepseek.cjs:125`),
which includes the assistant messages carrying `tool_calls` and every `tool`
result. Because the transport is stateless, each HTTP request resends the whole
history — so a turn with three tool calls makes four requests, each carrying
everything before it. Several conversations in, every request ships raw
`correlate` output from weeks ago, whose conclusion is already stated in the
answer text that follows it.

The history is also unbounded, which was logged as an open follow-up when the
assistant branch merged.

One thing is already right and stays: the manifest is never retained in
DeepSeek's history. It is rebuilt from current data on every request, so a
background sync or a change of selected date is reflected immediately.

## Not a per-provider policy split

An earlier decision rejected differing *memory policy* per provider: the
assistant would then behave differently depending on the model, which is hard to
explain and doubles the tests. This is not that. The behaviour is identical —
the model sees a current manifest and the conversation so far. Only the
transport differs, and translating shared behaviour into a provider's own
mechanics is exactly what an adapter is for.

## Codex: send the manifest only when it changed

The adapter keeps a hash of the last manifest sent on the current thread. On a
new turn:

- hash matches — omit the context wrapper, send only the user's text; the thread
  already holds it.
- hash differs — send it and update the stored hash.
- thread resets (error, dispose, `reset()`) — clear the hash, so the first turn
  on a new thread always carries the manifest.

The mechanism already exists: `_beginTurn` has an `if (active.context)` gate,
added so a tool-directive follow-up sends no empty `<OPENFIT_HEALTH_CONTEXT>`
pair. This extends the same gate with a second reason to skip.

The decision belongs in the adapter, not in `main.cjs`. Only the adapter knows
whether the thread is still alive and what it was last told; main knowing that
would be main tracking Codex's internals.

## DeepSeek: retain text, drop tool traffic

When a turn completes, retain only the user message and the assistant's final
answer. Drop the assistant messages carrying `tool_calls` and the `tool` result
messages that answered them.

They are needed *within* the turn — the model must see what it asked for and
what came back — and redundant after it, because the answer states the numbers
it drew from them. They are also the bulkiest part of what gets resent.

### The history cap

20 exchanges or 16 384 bytes of retained history, whichever comes first, dropping
oldest exchanges first.

Eviction is appropriate here, unlike in memory. A conversation is transient by
nature and visible in the window; a memory entry is durable and invisible, which
is why that design refuses to evict and tells the user it is full instead.

But a trimmed history must be declared. Without it the model answers "as we
discussed earlier" with confidence about an exchange it can no longer see. The
user's own window still shows those turns, so the mismatch would otherwise be
invisible to everyone except the model.

Concretely: when anything has been dropped, the request inserts one extra
`{ role: 'system' }` message immediately after the manifest and before the
retained exchanges, reading that earlier turns in this conversation were omitted
to stay within the context limit. A system message rather than text prepended to
a user turn, so it cannot be mistaken for something the user said. It is
recomputed per request from the current retained history, never stored — the
history itself holds only real exchanges.

This applies to DeepSeek only. Codex's thread lives on the server and is not
trimmed by this design.

## Error handling

**A manifest that fails to hash** — treat as changed and send it. Failing toward
sending is the safe direction: a redundant manifest costs tokens, a missing one
costs correctness.

**A thread that resets mid-conversation** — the hash clears with it, so the next
turn re-sends. No special case needed beyond clearing in the same places
`_threadId` is cleared.

**History trimmed to nothing** by a single oversized exchange — keep the most
recent exchange regardless of the byte cap, and mark the history as trimmed. An
empty history with no marker would read as a fresh conversation.

## Testing

Both adapters already have test files with stub harnesses; neither test reaches
the network.

**Codex** (`electron/assistant-codex.test.ts`): a second turn with an unchanged
manifest sends `input` with one item, not two. A second turn with a changed
manifest sends two. After a thread reset, the next turn sends two again. The
existing assertion at `electron/assistant-codex.test.ts:188`, which pins the
two-item `input` for a first turn, must still pass unmodified — a first turn
always carries the manifest, since no hash is stored yet.

**DeepSeek** (`electron/assistant-deepseek.test.ts`): after a turn with two tool
calls, the next request's `messages` contains the user text and the final answer
and neither the `tool_calls` message nor the `tool` results. The cap drops the
oldest exchange and the request carries the trimmed marker. An exchange larger
than the cap on its own is still retained, still marked.

**Not reachable by tests:** whether the model actually behaves better with a
cleaner context. Manual check — hold a conversation of a dozen turns with several
tool calls on each provider and confirm answers stay anchored to the currently
selected date.

## Dependencies

Builds on the assistant work merged to `main` at `0dca971`. Independent of the
memory design, which should follow it.
