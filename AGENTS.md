# OpenFit agent instructions

## Preserve unrelated work / secrets

- Do not stage, modify, or delete `docs/PRD_AMAZFIT_INTEGRATION.md` or the untracked `amazfit/` scaffold (empty Zepp OS work-in-progress) unless the user explicitly requests it.
- Never print or commit `.env` values, OAuth tokens, encryption keys, passwords, or private-key contents.

## Before deployment/ops work

Before deployment, server access, Docker, OAuth, synchronization, or production-diagnostics tasks, read:

1. `docs/OPERATIONS.md`
2. `.agents/OPERATIONS.local.md`, if present (git-ignored, holds machine-local SSH/tunnel access)

## Commands

```bash
npm run dev            # Vite + Electron together, hot reload
npm run build           # tsc -b + vite build (renderer only)
npm run build:server    # tsc -p tsconfig.server.json -> dist-server/ (Docker/web-server target)
npm run typecheck       # tsc -b --pretty false
npm run check:electron  # node --check on each electron/*.cjs (syntax only, not type-checked by tsc)
npm test                # vitest run (all *.test.ts)
npm run test:watch      # vitest watch mode
npm run check           # typecheck + check:electron + test + build:web -- run before considering work done
npm run capture:ui      # Electron visual QA screenshots (desktop + mobile)
npm run dist            # electron-builder packaging
```

- Run a single test file: `npx vitest run src/lib/format.test.ts`. Tests live next to their source (`foo.ts` / `foo.test.ts`), across `src/`, `electron/`, and `server/`.
- `npm run check` is the full gate; CI (`.github/workflows/ci.yml`) runs exactly `npm run check` on Node 22.
- Requires Node >=22, npm >=10.
- `electron/*.cjs` files are plain CommonJS and are never compiled by `tsc` — `check:electron` only catches syntax errors, not type errors, in that directory.

## Architecture

OpenFit is an Electron desktop app (also deployable as a single-user Docker web server) that displays Fitbit/Google Health data. There is no public BLE interface for desktop apps: Fitbit Air syncs over BLE to the Fitbit/Google Health mobile app, which syncs to the cloud, and OpenFit only ever talks to Google's cloud APIs (or the legacy Fitbit Web API), never the device directly.

**Process boundaries (Electron):**
- `electron/main.cjs` — owns the OAuth loopback server, Client Secret, access/refresh tokens, and all calls to `health.googleapis.com`/`api.fitbit.com`. Only process that reads/writes cache and credentials.
- `electron/preload.cjs` — exposes a narrow `contextBridge` allowlist. No Node, no filesystem, no raw `ipcRenderer`, no tokens ever reach the renderer.
- `src/` (renderer) — `nodeIntegration: false`, `contextIsolation: true`, sandboxed. Receives credential-free normalized payloads only.
- `electron/assistant-codex.cjs` (renamed from `codex-service.cjs`) — bridges to a local `codex app-server` (JSONL over stdio) for the health assistant chat. Read-only sandbox, approvals disabled for its own shell/patch tools. `electron/assistant-deepseek.cjs` is the alternative provider, calling the fixed DeepSeek endpoint over HTTPS. Both are remote: health data leaves the machine during a conversation, and neither is contacted until the user sends a message. `electron/assistant-dispatch.cjs` guards every assistant tool call with a closed allowlist, an 8-call-per-turn limit, a 5000 ms timeout, and a 4096-byte result cap. The assistant opens each conversation with a compact manifest (`src/lib/assistant-manifest.ts`, about 1300 characters against the demo dataset) instead of the archive, and pulls specific numbers only through the tools in `src/lib/assistant-tools.ts` as the conversation needs them.

**Provider adapters** (`electron/google-health-service.cjs`, `electron/fitbit-legacy-service.cjs`) each implement the same contract — `createPkce`, `createAuthorizationUrl`, `exchangeAuthorizationCode`, `refreshAccessToken`, `revokeToken`, `syncData` — and both produce the same `RawFitbitPayload` shape. Google Health API v4 is primary; the legacy Fitbit Web API is an isolated fallback slated for deprecation. Google Health and Google Fit (steps) use separate OAuth tokens because Google Health rejects tokens carrying Fitness scopes — both are refreshed independently.

**Normalization:** `src/data/normalize.ts` converts any adapter's `RawFitbitPayload` into the single `DashboardData` shape consumed by views, so UI code never branches on provider. `src/types.ts` defines the shared renderer/preload contracts. `@/*` resolves to `src/` (see `vite.config.ts` / `tsconfig.app.json`).

**Resilience conventions baked into the adapters/cache:** per-metric reads are independent (a 403/404 on ECG doesn't cancel steps/sleep); Google Health calls are rate-limited (<5 req/s) with backoff on 429; cache writes are temp-file-plus-rename; a partially-failed sync never overwrites the last good cache; concurrent syncs are serialized.

**Dual deployment targets:**
- Desktop (Electron): credentials encrypted via `safeStorage` (Keychain/Credential Manager/Linux secret store). If `safeStorage` is unavailable, saving fails explicitly rather than falling back to plaintext.
- Docker/web (`server/`, `Dockerfile`, `compose.yaml`): single-user web server with HTTP Basic auth; credentials and health cache encrypted in a persistent volume; refreshes the current day every 5 minutes and force-refreshes the previous day once after a date rollover. `TZ` in `.env` must match the connected health account's timezone to keep current-day validation aligned around midnight.

**UI conventions:** one primary metric per screen; hide empty/unavailable sections rather than showing empty cards; one accent color for status/progress/actions; intraday samples are aggregated for chart rendering without altering min/max/latest values.

## Other docs

- `docs/ARCHITECTURE.md` — security boundaries and design decisions; read before touching OAuth or the provider contract.
- `docs/DATA_COVERAGE.md` — which metrics come from which API, and hard limits (no BLE stream, no proprietary scores like Readiness/Stress, GPS not map-rendered yet).
- `docs/GOOGLE_HEALTH_SETUP.md` — full OAuth/Cloud console setup walkthrough.
- `docs/RELEASE.md` — signing, notarization, release checklist.
- `docs/OPERATIONS.md` — deployment/ops (read before any ops task, per above).
- `docs/HOME_DASHBOARD_MODEL.md` — home dashboard data model.

## Fable

When operating as Claude Fable, use the `/efficient-fable` skill always.
