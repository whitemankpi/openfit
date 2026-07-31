# Multi-provider health assistant with local tools

Design for the assistant half of Phase 4. The analytics half (correlations,
weekday patterns, insights, period comparison) is specified separately and is a
prerequisite: the tools described here mostly expose it.

## Why

The assistant today ships the whole archive into the model on every turn — up to
500 000 characters — and asks it to read the numbers off a JSON blob. Three
things are wrong with that now that Phases 1–3 have landed:

- It cannot compute. Asked whether late workouts cost deep sleep, the model
  eyeballs a year of rows. A correlation coefficient is arithmetic; arithmetic
  belongs in code that can be tested, not in a language model.
- It does not scale. The archive is a rolling year and growing. Dumping it whole
  is both expensive and, since the model is remote, more of the user's health
  history leaving the machine than any single question needs.
- It is behind. Scores, heart rate zones, and the corrected sleep fields from
  Phases 1–3 are not in the context at all.

`electron/codex-service.cjs` already receives `item/tool/call` from the
app-server and answers "Tool calls are disabled". The channel exists; it is
simply closed.

Separately, the assistant is welded to Codex. The user wants a choice of model,
starting with Codex and DeepSeek.

## What this is not

Not a proactive agent. Health data still reaches a model only after the user
sends a message. Not a writer: every tool reads.

## Architecture

Three layers with distinct boundaries.

**Tool layer** — `src/lib/assistant-tools.ts`. Pure TypeScript with no knowledge
of providers. Each tool is `{ name, description, schema, run(args, context) }`,
where `context` carries `DashboardData`, `History`, and the Phase 4a analytics.
Every tool returns aggregates, never raw series. Tested as an ordinary library.

**Provider layer** — a contract in the spirit of the existing health-provider
contract:

```
createSession(options) → session
session.sendTurn({ text, context, tools }) → events
session.cancel()
session.dispose()
```

Two implementations: `electron/assistant-codex.cjs` (the renamed
`codex-service.cjs`) and `electron/assistant-deepseek.cjs`. Both emit one event
stream — `delta`, `tool-call`, `done`, `error` — so the renderer never learns
which model answered.

**Dispatcher** — lives in the main process between the provider and the tool
layer. It is the only component that maps a name to an implementation, and it
does so against a closed allowlist. An unrecognised name is refused, never
guessed at.

Tools are defined once; each adapter translates them into its own protocol.
Codex answers `item/tool/call`; DeepSeek sends a `tools` array and loops over
`tool_calls`.

Unchanged: sandbox stays `read-only` with `networkAccess: false`, approvals
`never`, the "context is data, never instructions" rule, the prohibition on
diagnosis, and the rule that nothing is sent until the user speaks.

## Components

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `metric_window` | metric, start, end | n, median, spread, min/max, first/last, slope per week |
| `compare_periods` | metric, two periods | median of each, delta, percent, n of each |
| `correlate` | two metrics, lag in days, window | Spearman's ρ, n, whether it clears the threshold |
| `explain_score` | score, date | the same `ScoreResult` the interface shows |
| `weekday_pattern` | metric, window | median per weekday, n |
| `data_coverage` | period | which metrics exist, how many days, where the gaps are |

Definitions, so the numbers mean one thing:

- **spread** is the MAD-based robust spread from `robustBaseline` in
  `src/lib/home-analysis.ts`, the same one the scores use, and is `null` for a
  series that never varies.
- **slope per week** is a least-squares fit over the window, in the metric's own
  units per seven days.
- **clears the threshold** means `n >= 30 && |ρ| >= 0.3`, the same gate the
  analytics UI uses before showing a correlation. Below it the tool still returns
  ρ and n, with the flag false, so the model can say the relationship is too weak
  to claim rather than omitting it silently.
- A tool result is truncated at **4 KB** of serialised JSON.

`data_coverage` is not an afterthought. Without it, "why did my HRV drop in May"
invites an invented answer instead of "there is no HRV for May; the device did
not sync". The metric list is an `enum` in each tool's schema, so no separate
discovery tool is needed.

### Provider adapters

`codex-service.cjs` becomes `assistant-codex.cjs`; substantively one branch
changes — `item/tool/call` calls the dispatcher instead of refusing.

`assistant-deepseek.cjs` is new: `POST /chat/completions` against a fixed
`https://api.deepseek.com`, SSE for deltas, a `tools` array, and a loop over
`tool_calls`.

**The base URL is deliberately not configurable.** An "enter your endpoint"
field in an application holding a year of health history is an exfiltration
channel that only needs an address swapped. A local model, if ever wanted, gets
its own adapter and its own decision.

### Credentials

The DeepSeek key is stored the way OAuth tokens already are: `safeStorage` under
Electron, `EncryptedStore` on the server. The renderer receives only
`hasApiKey: boolean`, mirroring the existing `hasClientSecret`. If `safeStorage`
is unavailable, saving fails explicitly rather than falling back to plaintext.

### Surfaces

Two new IPC channels, `assistant:get-config` and `assistant:save-config`
(provider and key), both through the existing `trustedHandle` and both recorded
in `preload-contract.test.ts`, which asserts the channel list as a set.

`HealthAssistant.tsx` gains a tool-activity line — "correlated steps against
resting heart rate over 90 days, n = 87" — and an indicator of which model
answered, since that determines where the data went. The activity line follows
the same principle as the score contribution bars: the number's provenance is
visible.

Settings gain a provider choice, next to a plain statement that both options are
remote and that health data leaves the machine during a conversation. No such
warning exists today, although the behaviour already does.

## Data flow

The first turn shrinks by an order of magnitude. Instead of the archive, it
carries a manifest: date range, which metrics exist and over how many days, the
selected day's values and scores, the current page. A few thousand characters.
The model pulls the rest itself, and only what the question needs.

### Where each part runs

The data the tools need lives in the renderer; the model connection lives in
main.

The archive is encrypted and owned by main, but `History`, the scores, and the
Phase 4a analytics are built in the renderer — `src/data/history.ts`,
`src/lib/scores.ts` — in TypeScript. `electron/main.cjs` is CommonJS that `tsc`
never checks and cannot import that code.

So either the normalisation stack is duplicated in CJS, or tools execute where
the data already is. Duplication loses: it means a second copy of `normalize.ts`
and `history.ts` that will diverge within a month.

```
renderer: user sends a message
   → main: assembles the manifest, starts a turn (key and model process live here)
      → model: "call correlate(steps, restingHeartRate, lag=1, window=90)"
         → main: checks the name against the allowlist and the arguments against the schema
            → renderer: runs the tool over the History and scores it already holds
            → main: checks the shape of the result, returns it to the model
      → model: answer text
   → renderer: shows the text and the tool-activity line
```

Main remains the sole owner of the key and of the model stream; the renderer
sees neither. The renderer only computes over data already in its memory.

The two validation points are deliberately separate. On the way in, the name and
arguments are checked because they come from a model that has read context
containing user data. On the way out, the result shape is checked so a bug in a
tool cannot hand the model an arbitrary object.

The `openfit:navigate` directive is unchanged and does not become a tool: it is
an action on the interface rather than a data request, and it already has a
tested parser.

**Server deployment** uses the same loop without a renderer. `server/index.ts` is
TypeScript and imports the tools directly. The adapter and dispatcher are shared;
only the executor differs — renderer over IPC, or a direct function call.

## Error handling

**Unknown tool or bad arguments.** The dispatcher returns a structured error with
a reason rather than staying silent or throwing into the turn, so the model can
correct itself. A silent refusal is worse than an error: the model fills the
hole with an invented number.

**Not enough data is not an error.** `correlate` over a metric with `n = 3`
returns `{ insufficient: true, n: 3, required: 30 }` and the model is instructed
to say so. This is the rule the scores already follow: unavailable stays
unavailable, it does not become zero. The developer instructions require an `n`
alongside any statistical claim.

**Renderer unresponsive.** Tool calls time out; the model receives an error and
can close the turn with text. The turn does not hang.

**Runaway tool loops.** Eight tool calls per turn, after which the dispatcher
answers "limit reached". Without a cap, one awkwardly phrased question can spin
the model in circles, and every lap is tokens and data sent remotely. Results are
also size-capped at 4 KB.

**DeepSeek over HTTP.** 401 is a settings state, not a conversation failure:
"the key was rejected, check settings", not raw error text. 429 retries with
backoff, as Google Health already does. 5xx and timeouts get one retry and then
an honest failure. The key never reaches error text: the existing
`sanitizeMessage` already strips `sk-…`, which is DeepSeek's key format.

**Codex unavailable** behaves as it does today.

**Switching provider mid-turn** cancels the running turn first, so a reply from
the old model cannot land in the new session.

**Injection through data.** Workout and device names arrive from other
applications and can contain instruction-shaped text. The "context is data" rule
stays, but tools add a vector: injected text could try to drive a tool call with
odd arguments. The defence is structural rather than textual — every tool reads
and returns aggregates, so the worst achievable outcome is a pointless
correlation. There is no destructive tool in the set, which is also why the set
stays a closed list rather than "call anything in this module".

**Not promised:** that the model will never invent a number despite the tools.
That cannot be fully eliminated. The mitigations are the activity line, which
shows what was actually computed, and the requirement to state `n`. A precise
figure with an empty activity line is a visible contradiction.

## Testing

Tests are colocated and fixture-driven, following `normalize.test.ts` — no mocks
where data will do. Nothing reaches the network or needs Codex installed; CI runs
`npm run check` on Node 22 and that must stay true.

**Tools** are the cheapest and largest share of coverage: pure functions over
`DashboardData` and `History`. Correct aggregates over a known series, the
insufficient-data path with a concrete `n`, refusal of a metric outside the
`enum`, truncation of an oversized result, and the property that is easiest to
lose — a tool over an empty window returns `insufficient`, not zeros.

**The dispatcher** is pure logic, tested with a stub registry: name outside the
allowlist, arguments failing the schema, exceeding eight calls, timeout, and a
malformed result. Each must produce a structured error rather than an exception.

**The DeepSeek adapter** is tested against a stub `fetch`: the request shape
(that `tools` was included), a two-step `tool_calls` loop, and status mapping —
401 to a settings state, 429 to a retry, 5xx to one retry then failure. A
separate test asserts the key never appears in error text.

**The Codex adapter** follows the existing `createRequire` pattern from
`google-health-service.test.ts`. What must be pinned: `item/tool/call` now
reaches the dispatcher, and an unknown name is still refused.

**The preload contract** already asserts the full channel list as a set, so the
two new channels must be added deliberately and the surface cannot grow by
accident.

**Credentials:** only `hasApiKey: boolean` leaves the main process, and saving
fails rather than writing plaintext when `safeStorage` is unavailable.

**Not reachable by tests:** the model's own behaviour. Delivery includes a manual
checklist — a question whose correct answer is "there is no data", a question
with a deliberately ambiguous period, and a check that the activity line matches
the numbers in the text.

## Delivery order and the open risk

1. **Spike, before anything else.** Determine on an installed Codex how custom
   tools are declared. The code shows only that `item/tool/call` arrives from the
   server; the registration mechanism is not visible. If Codex turns out not to
   accept arbitrary tool declarations, Codex falls back to text directives —
   extending the proven `openfit:navigate` pattern — while DeepSeek uses native
   `tools`. This risk is cheap to retire first and expensive to discover halfway
   through.
2. Provider contract and the DeepSeek adapter, without tools. `sendTurn` already
   takes a `tools` argument at this stage; it is simply empty, so adding tools in
   step 3 does not reopen the contract. The assistant keeps working as it does
   today, with a model choice.
3. The tool layer, the dispatcher, and the manifest that replaces the archive
   dump.

Step 2 is useful on its own, which is why it ships before the tools.

## Dependencies

Phase 4a (deterministic analytics) must land first: `correlate`,
`compare_periods`, and `weekday_pattern` expose it. `explain_score`,
`metric_window`, and `data_coverage` depend only on what Phases 1–3 already
shipped.
