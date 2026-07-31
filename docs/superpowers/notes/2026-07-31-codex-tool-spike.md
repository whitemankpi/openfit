# Spike: can the Codex app-server be given custom tools?

Date: 2026-07-31. Tested against `codex-cli 0.146.0` (Homebrew, macOS arm64).

## Answer

**No — not through any published protocol surface.** OpenFit cannot declare its
own tools to Codex. Codex will use text directives; DeepSeek will use native
`tools`.

## What the protocol actually offers

The binary can emit its own schema, which settles the question without guessing:

```bash
codex app-server generate-json-schema --out <dir>
```

The bundle contains `DynamicToolCallParams` / `DynamicToolCallResponse`, matching
the `item/tool/call` server request `electron/assistant-codex.cjs` already
answers:

```
DynamicToolCallParams: { callId, threadId, turnId, tool, arguments, namespace? }
DynamicToolCallResponse: { contentItems: [{ type: 'inputText', text }], success }
```

So the *inbound* half — Codex asking the client to run a tool — is fully
specified, and answering it properly is worth doing.

The *outbound* half is not reachable. `DynamicToolSpec` exists as a definition
(a `function` variant with `name` / `description` / `inputSchema`, and a
`namespace` variant), but:

- `ThreadStartParams` properties are exactly: `approvalPolicy`,
  `approvalsReviewer`, `baseInstructions`, `config`, `cwd`,
  `developerInstructions`, `ephemeral`, `model`, `modelProvider`,
  `personality`, `sandbox`, `serviceName`, `serviceTier`,
  `sessionStartSource`, `threadSource`. No tools field.
- `TurnStartParams` likewise has no tools field.
- Nothing in the schema `$ref`s `DynamicToolSpec`. It is a dangling definition,
  exported by the type generator but not wired into any request.
- None of the 90 client methods in `ClientRequest.json` carries a
  `DynamicToolSpec` payload. The only tool-related client method is
  `mcpServer/tool/call`, which is the MCP path, not arbitrary client tools.
- `config.tools` is `ToolsV2`, whose sole property is `web_search`.

The one untried avenue is registering an MCP server, which would mean running a
second local process and re-implementing the tool layer behind the MCP protocol.
That is disproportionate to the benefit and is not pursued.

## Consequences for the plan

- **Task 12 stands, reduced in ambition.** Answering `item/tool/call` through
  the dispatcher is still correct and still worth doing: if a future Codex
  version starts offering tools, or if an MCP server is ever added, the client
  side is already right. Do not add a tool declaration to `thread/start` — there
  is no such parameter.
- **Codex reaches the tools by text directive.** Extend the proven
  `openfit:navigate` pattern in `src/lib/health-assistant.ts` with an
  `openfit:tool` directive: the model emits a request, the main process runs it
  through the same dispatcher, and the result is fed back as the next turn's
  input. Same allowlist, same validation, same 4 KB cap — only the transport
  differs.
- **DeepSeek is unaffected** and uses native `tools`.
- **The dispatcher, tool layer, and manifest are unaffected.** They were
  designed to be transport-agnostic, which is what makes this finding cheap.

Because Codex needs a directive round-trip per tool call, its per-tool latency
is higher than DeepSeek's. The eight-call budget matters more there.
