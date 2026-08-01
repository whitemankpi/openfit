# Assistant memory

Design for durable context the health assistant carries between conversations.

## Why

The assistant can now compute anything the data supports: correlations, personal
baselines, scores broken into their factors. What it cannot do is know why a
number moved. An HRV crash in the second week of March is a mystery to
statistics and obvious to the person who was ill that week. A rising load curve
is an anomaly to the model and a marathon plan to its owner. Broken sleep reads
as a disorder unless someone mentions the newborn.

Today none of that survives. `assistant-deepseek.cjs` clears
`conversationHistory` on `reset()`, and the Codex thread is started with
`ephemeral: true`. Close the app and the assistant has never met you.

This is also the first place in OpenFit where a model writes something durable
about the user. Until now it has only read. That is the reason for most of the
constraints below.

## What this is not

Not a transcript archive. Not semantic retrieval — entries are selected by date
and metric, which cannot miss the way a similarity search can. Not autonomous:
nothing is stored without an explicit click.

## Architecture

Memory is the third directive alongside two that already work. `openfit:navigate`
has a tested parser with a strict validator; `openfit:tool` was added with the
same shape and is pinned against its CommonJS twin by a shared fixture table in
`electron/tool-directive-cases.ts`. `openfit:remember` joins them and inherits
all of it.

**`src/lib/assistant-memory.ts`** — pure TypeScript. Entry shape, validation,
age, formatting for the manifest, limits, deduplication. No storage, no IPC.

**`electron/assistant-memory.cjs`** — the CommonJS twin of validation, because
`main.cjs` cannot import TypeScript. The same duplication the directive parser
already carries, with the same answer: one shared fixture table read by both
test suites.

**Storage in main** — `assistant-memory.secure.json`, encrypted with
`safeStorage`, separate from `assistant-config.secure.json` and from the health
archive. Changing a model choice must not disturb memory, and vice versa.

### The entry

```ts
interface MemoryEntry {
  id: string
  kind: 'fact' | 'episode' | 'preference' | 'conclusion'
  text: string
  createdAt: string
  startDate?: string                        // episode
  endDate?: string | null                   // episode; null means ongoing
  window?: { start: string; end: string }   // conclusion
  sampleSize?: number                       // conclusion
}
```

Four kinds because they age differently:

- **fact** does not age — asthma, vegetarian, a chronic condition.
- **episode** is bounded — ill 10–17 March, marathon training January to October.
- **preference** holds until withdrawn — do not advise on weight, answer briefly.
- **conclusion** carries the window and sample size it rested on, so the model
  can see not just the finding but its footing, and can re-derive it with
  `correlate` instead of repeating a six-month-old coefficient.

Each entry reaches the model with its age and kind. The model judges relevance
itself. There is no automatic expiry: a rule that quietly drops an entry would
eventually drop the one thing explaining last winter. An episode's `endDate` is
data the model reads — it says the marathon is behind you — not an instruction
to delete the entry, which stays until the user removes it.

## Components and flow

**Proposal.** The model appends a directive. The renderer does not print it —
it renders a row beneath the answer showing the entry verbatim, its kind, and
two actions: remember, or dismiss. Nothing is stored until the click. The entry
is shown word for word rather than paraphrased, because the only real defence
against remembering something false is that the user read it first.

**Reading — a core in the manifest, the rest on request.**

The first draft of this design sent everything every turn, on the reasoning that
a retrieval system will eventually withhold the one entry that explains an
anomaly. That objection holds against *semantic* retrieval, which guesses at
relevance. It does not hold here, because these entries are not retrieved by
meaning:

- **Preferences and facts** are few and shape every answer. They ride in the
  manifest, always.
- **Episodes** are bounded by dates by definition. "Ill 10–17 March" is needed
  exactly when the conversation touches March.
- **Conclusions** are bound to metrics. One about sleep and load is needed when
  sleep or load is under discussion.

So the selection is by date and metric — deterministic, not a guess. A seventh
tool, `recall(dateRange?, metric?)`, returns the episodes overlapping the range
and the conclusions touching the metric. Asked about March, it cannot fail to
return March.

The manifest carries the **count** of episodes and conclusions and the date span
they cover. This is the part that makes it safe, and it follows the rule
`data_coverage` already establishes: a model that knows what it does not know
asks; a model that does not, invents.

The cost is asymmetric between providers. DeepSeek calls `recall` inside one
turn; Codex has no native tools and spends a whole turn on the directive round
trip. That asymmetry is accepted rather than papered over with per-provider
behaviour: one policy is easier to explain, and half the tests.

**Limits, not eviction.** 50 entries or 4096 bytes of serialised memory,
whichever comes first, and 280 characters per entry. At the limit the proposal
says memory is full and links to management. Silently dropping the oldest is not
acceptable; the oldest may be the only thing that explains a gap.

Two mechanical details, fixed here so they are not decided twice:

- **`id`** is `crypto.randomUUID()`, generated in the main process when the
  entry is stored, never supplied by the model. An id from the model could
  collide with or overwrite an existing entry.
- **Deduplication** compares text lowercased, with runs of whitespace collapsed
  to one space and leading and trailing punctuation stripped. Two entries whose
  normalised text matches are the same entry; the existing one is kept, so
  `createdAt` reflects when the fact was first learned rather than last
  repeated.

**Management** — a list: text, kind, date, delete. Alongside it, a statement of
what actually leaves the machine, which the split makes more precise than "all
of it": preferences and facts go to the remote model in every conversation;
episodes and conclusions go only when the assistant asks for them, and their
count and date span go every time. That sentence belongs where the user approves
an entry, not at the bottom of settings.

## Error handling

**Malformed directive** — ignored silently, as `openfit:navigate` and
`openfit:tool` already are. A proposal is not a data request; making the model
retry would spend a turn on something the conversation does not need.

**Entry too long or empty** — no proposal shown. The 280-character per-entry cap
is separate from the 4096-byte total, so one entry cannot consume the whole
budget.

**`safeStorage` unavailable** — memory is disabled entirely: no parsing, no
proposals, and management says why. Consistent with credentials, which fail
loudly rather than falling back to plaintext.

**Memory full** — the proposal appears but leads to management instead of
storing. The user chooses what to remove.

**An entry fails to load** (corrupted file, format change) — that entry is
skipped and the rest load. One bad line must not cost the whole memory. Skipped
entries are counted and surfaced in management, so the loss is never silent.

**A duplicate proposal** — deduplicated on normalised text. Otherwise a third
conversation about the marathon leaves three identical entries, all of them
shipped in every turn.

**Deliberately not handled:** the case where the model proposes something false.
That is not solvable in code — only by the user reading the exact text before
clicking.

## Testing

Colocated and fixture-driven, following the existing suites.

**The pure module** carries most of the coverage: entry validation, age, manifest
formatting, limits, deduplication. The property easiest to lose: an unknown
`kind` is rejected rather than accepted with a default.

**The directive** joins `electron/tool-directive-cases.ts`, the shared table that
already pins `openfit:tool` across both parser implementations — including the
`expectedStripped` column added after the final review found strip unpinned. A
third directive type uses that mechanism rather than starting its own.

**Storage** follows `assistant-config.cjs`: pure logic separate, file I/O in
main. Tests for merge-on-save, refusal when `safeStorage` is unavailable, and
skipping a corrupted entry while keeping the rest.

**The manifest** gets two tests: preferences and facts reach it, and 50 entries
do not push it past the context cap (now 50 000 characters, tightened from
500 000). A third pins the part that keeps the split honest — the manifest
states how many episodes and conclusions exist and over what dates, even when it
carries none of their text.

**`recall`** is tested like the other six tools, against the same rules: a range
with no episodes returns `insufficient` rather than an empty object; a metric
outside the enum is refused rather than guessed; the result respects the 4096-byte
cap. Plus the property the whole split rests on — an episode overlapping the
requested range is always returned, including when it only partly overlaps at
either edge.

**Privacy gets its own test:** an entry the user never approved appears in no
outgoing text. That is the load-bearing property of this design, and it needs a
test that fails when it breaks.

**Not reachable by tests:** whether the model proposes sensible things. Manual
checklist — state a fact about your life and confirm the proposal appears and is
worded accurately; dismiss it and confirm it is absent next conversation;
approve one and confirm it is present.

## Dependencies

Builds on work merged to `main` at `0dca971`: the directive infrastructure and
its shared fixture table, the manifest, and the `safeStorage` pattern
established by `assistant-config.cjs`.
