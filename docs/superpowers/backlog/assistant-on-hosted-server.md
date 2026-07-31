# Backlog: assistant on the hosted server

Deferred from `docs/superpowers/plans/2026-07-31-assistant-tools-and-providers.md`
on 2026-07-31.

**Why it was deferred:** the hosted server has no assistant at all — no chat
endpoint, no bridge, no web chat UI. `grep -rn "codex\|assistant" server/` returns
nothing. The original task assumed parity work over an existing feature; there is
no feature to reach parity with, so it was building ahead of need.

**What it would actually take**, beyond the tool wiring the original task described:

- a chat endpoint under HTTP Basic auth, with streaming (the server already has an
  SSE pattern in `/api/events`)
- a web chat surface, or a decision that the hosted deployment is read-only
- `tsconfig.server.json` currently has `include: ["server/**/*.ts"]` and no `@/`
  path alias, so importing `src/lib/assistant-tools.ts` from `server/` does not
  compile as-is. Either add the alias and widen the include, or extract the tools
  to a location both targets already share.

The tool layer, dispatcher, and provider adapters from the parent plan are all
reusable when this is picked up.

---

## Original task text

## Task 13: Server parity

The hosted deployment runs the same loop without a renderer.

**Files:**
- Modify: `server/index.ts`

**Interfaces:**
- Consumes: `createDispatcher` (Task 6), `runTool`/`ASSISTANT_TOOLS`/`TOOL_NAMES` (Tasks 2–5).
- Produces: no new exports.

- [ ] **Step 1: Import the shared pieces**

`server/index.ts` is TypeScript, so it imports the tools directly rather than going through a renderer:

```ts
import { ASSISTANT_TOOLS, TOOL_NAMES, runTool } from '../src/lib/assistant-tools.js'
const { createDispatcher } = require(path.resolve('electron/assistant-dispatch.cjs'))
```

- [ ] **Step 2: Execute tools in-process**

Where the server starts an assistant turn, build the dispatcher with a direct executor:

```ts
const dispatcher = createDispatcher({
  allowedNames: TOOL_NAMES,
  // No renderer here: the server holds the same normalised data itself.
  execute: async (name: string, args: Record<string, unknown>) =>
    runTool(name, args, { data, history }),
})
```

- [ ] **Step 3: Verify the server build**

Run: `npm run build:server`
Expected: PASS.

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat(assistant): run the same tools on the hosted server"
```

---

