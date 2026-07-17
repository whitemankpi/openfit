# OpenFit Operations Runbook

This is the canonical context for agents working on deployment, server access, Docker, OAuth, and production synchronization. Read it before rediscovering infrastructure.

## Repository

- Local workspace: the repository containing this file.
- Primary branch: `main`.
- Deployment remote: `origin` (`whitemankpi/openfit`).
- Upstream project: `upstream` (`FlavioAdamo/openfit`); do not push production work there.
- Production deploys are fast-forward pulls from `origin/main`.
- `docs/PRD_AMAZFIT_INTEGRATION.md` is user-owned work and may be untracked. Do not stage, edit, or delete it unless explicitly requested.

Before committing, run:

```bash
npm run check
git diff --check
git status --short
```

Stage files explicitly so unrelated work is excluded.

## Production VPS

- SSH user and host: `ubuntu@192.168.6.1`.
- Repository: `/home/ubuntu/openfit`.
- Compose file: `/home/ubuntu/openfit/compose.yaml`.
- Compose project/container: `openfit` / `openfit-openfit-1`.
- Application container port: `3000`.
- Host port: `42813`.
- Persistent encrypted data: Docker volume `openfit-data`, mounted at `/data`.
- Server timezone: `Europe/Kyiv` via `TZ` in `.env`.

The SSH private-key path is machine-local and belongs in `.agents/OPERATIONS.local.md`, never in Git. Use a task-specific variable rather than repurposing system variables:

```bash
OPENFIT_SSH_KEY=/path/to/private-key
ssh -i "$OPENFIT_SSH_KEY" ubuntu@192.168.6.1
```

Never print, copy, or commit `/home/ubuntu/openfit/.env`. It contains Basic-auth credentials and the encryption key.

## Network layout

Production intentionally exposes the same container port on two host addresses:

```yaml
ports:
  - "127.0.0.1:${OPENFIT_PORT:-3000}:3000"
  - "192.168.6.1:${OPENFIT_PORT:-3000}:3000"
```

- `127.0.0.1:42813` is required for the SSH OAuth tunnel.
- `192.168.6.1:42813` is required for direct access from another laptop on the private network.
- The tracked `compose.yaml` contains only the loopback mapping. Production currently has an intentional local modification adding the private-network mapping. Preserve it during deploys and confirm both mappings afterward.
- Do not replace the dual mapping with loopback-only: that breaks laptop access.
- Do not replace it with LAN-only: that breaks the existing OAuth tunnel.

Expected production `APP_BASE_URL` and Google OAuth callback:

```text
APP_BASE_URL=http://127.0.0.1:42813
http://127.0.0.1:42813/oauth/callback
```

Open the local tunnel before OAuth:

```bash
ssh -i "$OPENFIT_SSH_KEY" -L 42813:127.0.0.1:42813 ubuntu@192.168.6.1
```

Access paths:

- Through the tunnel: `http://127.0.0.1:42813`.
- From the private-network laptop: `http://192.168.6.1:42813`.

## Safe deployment

Commit and push locally first. Then:

```bash
ssh -i "$OPENFIT_SSH_KEY" ubuntu@192.168.6.1
cd /home/ubuntu/openfit
git status --short
git pull --ff-only
docker compose up -d --build
docker compose ps
docker logs --since 10m --tail 200 openfit-openfit-1
```

Expected port output includes both:

```text
127.0.0.1:42813->3000/tcp
192.168.6.1:42813->3000/tcp
```

Health checks:

```bash
curl -fsS http://127.0.0.1:42813/healthz
curl -fsS http://192.168.6.1:42813/healthz
```

Expected response: `{"ok":true}`.

Do not run `docker compose down -v`, delete `openfit-data`, replace the encryption key, or remove `/data`; doing so can make health history or credentials unrecoverable.

## OAuth architecture

Google Health and Google Fit use the same configured OAuth client but separate consent flows and separate encrypted tokens:

- Google Health token: only `googlehealth.*`, `openid`, and `profile` scopes.
- Google Fit token: only `https://www.googleapis.com/auth/fitness.activity.read`.
- Both flows set `include_granted_scopes=false`.

Google Health rejects a token containing the Fitness scope with `403 Request contains disallowed OAuth scope(s)`. Never recombine the scopes.

Authorization order:

1. Connect or reauthorize Google Health.
2. Open Settings and select **Authorize Google Fit steps**.
3. Synchronize and verify that Data shows `Google Fit` as the movement source.

Google Fit API must be enabled in the same Cloud project and the full Fitness scope must be present on the OAuth consent screen. Existing callback registration must exactly match the loopback URL above.

## Data provenance

KsFit appears in Google Fit as:

```text
raw:com.google.step_count.delta:com.kingsmith.xiaojin:health_platform
```

OpenFit reads Google's deduplicated `estimated_steps` aggregate. It does not add raw KsFit, Fitbit Mobile, Samsung Health, or other source totals. Google Fit steps take priority when available; Google Health steps are the fallback.

Read-only hosted audit endpoint:

```text
POST /api/google-fit/audit
{"date":"YYYY-MM-DD"}
```

It is protected by the same HTTP Basic authentication. Avoid placing credentials directly in shell history or tool output; execute diagnostics inside the container using its environment when practical.

## Automatic synchronization

Commit `3195308` introduced production background synchronization:

- Full Google Health and Google Fit refresh every five minutes.
- Initial background cycle 15 seconds after server start.
- One forced refresh of yesterday after each date rollover or restart.
- Finalization state persisted in encrypted `sync-scheduler.json`.
- Idempotent cache writes: volatile timestamps and response ordering do not trigger false updates.
- Authenticated SSE endpoint: `GET /api/events`.
- Open web clients reload the selected cached date after a `data-updated` event.
- SSE heartbeat every 25 seconds.

The scheduler skips when disconnected or when another sync is in progress. A Google Fit refresh failure falls back to Google Health rather than blocking the entire sync.

After deploying frontend changes, hard-refresh the browser once (`Ctrl+Shift+R`).

## Fast diagnostics

Container and ports:

```bash
docker ps --filter name=openfit --format '{{.Names}} {{.Status}} {{.Ports}}'
```

Recent application errors:

```bash
docker logs --since 30m --tail 200 openfit-openfit-1
```

Listening sockets:

```bash
ss -ltnp 'sport = :42813'
```

If an OAuth callback shows `ERR_CONNECTION_RESET`, verify all three links before changing Google Cloud settings:

1. local tunnel listens on `127.0.0.1:42813`;
2. tunnel targets VPS `127.0.0.1:42813`;
3. Docker publishes VPS `127.0.0.1:42813` to container port `3000`.

If direct laptop access fails, verify the separate `192.168.6.1:42813` mapping.
