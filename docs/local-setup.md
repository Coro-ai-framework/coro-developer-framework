# Local Development Setup

This guide walks through running Coro locally for development of the
runner, the dashboard, and (optionally) the cloud control plane.

> If you only want to **use** Coro, install the desktop app from
> [coro-release](https://github.com/Coro-ai-framework/coro-release/releases/latest)
> (see the [README quick start](../README.md#quick-start-desktop)). This document
> is for engineers hacking on Coro itself (browser + runner, cloud, packaging).

## Prerequisites

| Tool          | Why                                                             | Install                         |
| ------------- | --------------------------------------------------------------- | ------------------------------- |
| Node.js 20+   | Runtime for the runner, the dashboard build, and the CLI         | https://nodejs.org              |
| pnpm 9+       | Workspace package manager                                       | `corepack enable`               |
| Git           | Cloning target repos and (optionally) tenant overlays           | system                          |
| Docker        | Optional — only needed for the cloud control plane (Postgres)   | https://docker.com              |

Coro is a pnpm workspace. **Do not use `npm install`** — the runner
depends on `@coro/intelligence-base` via the `workspace:*` protocol and
npm crashes mid-install.

---

## Solo (local) mode

Solo mode runs the runner, the dashboard, and SQLite state on a single
laptop. Zero external dependencies.

### 1. Install and build

```bash
pnpm install
pnpm -r build      # builds @coro/intelligence-base, @coro/runner, @coro/dashboard
```

### 2. Boot the runner

```bash
node packages/runner/dist/cli/index.js start
```

This:

- starts the runner on `http://localhost:3000`
- serves the bundled dashboard at `http://localhost:3000/dashboard/`
- opens the dashboard in your browser (suppressed in headless / CI /
  SSH; pass `--open` to force, `--no-open` to suppress, or set
  `CORO_NO_OPEN=1`)

> Tip: install the runner globally with
> `pnpm --filter @coro/runner exec npm link` (or
> `npm i -g ./packages/runner` after build) and just run `coro start`.

### 3. Configure in the dashboard

On first launch the dashboard greets you with a **Welcome to Coro**
banner and points you to **Settings**. Provide:

- **Anthropic credentials** — API key, OAuth token, or sign in with
  Claude Code.
- **Git provider + access token** — for cloning repos and opening PRs
  (BitBucket, GitHub, or GitLab).
- **Working directory + intelligence directory** — sensible defaults
  are pre-filled (`~/.coro/work` and `~/.coro/intelligence`).

Hit **Save**. Settings are persisted to `~/.coro/config.json`. You can
edit them later from the same page or by hand. The schema lives in
[`packages/runner/src/config/local-config.ts`](../packages/runner/src/config/local-config.ts).

### 4. Submit a job

From the dashboard's **New Job** page, point Coro at a repository and
describe the change you want. Watch progress live; when the agent is
done, it opens a PR against your target repo.

You can also use the CLI:

```bash
coro job \
  --repo my-service \
  --description "Add rate limiting to /api/users" \
  --reviewers alice,bob \
  --workflow workflows/job/workflow.md
```

The CLI submits the job to the running runner at `localhost:3000` and
streams progress. You can close the terminal — the job continues
running. Check back with:

```bash
coro status <jobId>
coro logs <jobId> --follow
```

---

## Solo-mode storage

Everything Coro produces in solo mode is rooted under `~/.coro/`:

```
~/.coro/
├── config.json                     ← LocalConfig (your settings)
├── state.db                        ← SQLite (jobs, logs, proposals, …)
├── work/                           ← Per-job working dirs
│   └── <jobId>/
│       ├── _intelligence/          ← Materialised per-job intelligence overlay
│       └── <repoSlug>/             ← Cloned target repo
├── intelligence/                   ← Your tenant overlay (optional)
└── cache/
    └── tenant-overlays/            ← Cached `gitRemote` overlays
```

To inspect job state while a job is running:

```bash
ls ~/.coro/work/<jobId>/_intelligence/
cat ~/.coro/work/<jobId>/<repoSlug>/implementation-plan.md
```

To reset:

```bash
# Stop the runner, then:
rm ~/.coro/state.db          # wipe job state
rm -rf ~/.coro/work/         # wipe working dirs
rm -rf ~/.coro/cache/        # wipe overlay caches
```

---

## Tenant overlay (optional)

Solo deployments can pull a tenant-level intelligence overlay (your
team's customisations layered on top of the base). Add a
`tenant.overlay` block to `~/.coro/config.json`:

```jsonc
{
  "tenant": {
    "displayName": "My Team",
    "overlay": {
      "kind": "gitRemote",
      "url":  "git@github.com:my-team/coro-overlay.git",
      "ref":  "main"
    }
  }
}
```

Supported `kind`s:

- `localDir` — `{ "kind": "localDir", "path": "/abs/path" }`
- `gitRemote` — cloned and cached under `~/.coro/cache/tenant-overlays/`
- `cloudBlob` — `{ "kind": "cloudBlob", "key": "..." }`, served by the
  cloud control plane in team mode (a no-op in solo mode today)

The tenant overlay is merged on top of the base layer at job start;
see [architecture.md §4](architecture.md#4-layered-intelligence) for
the full merge semantics.

---

## Hybrid (team) mode

Hybrid mode runs each developer's runner locally but delegates state
to a shared cloud control plane. This is what teams use in production.

### Pair the runner with the cloud

```bash
coro login
```

This walks you through OAuth against the cloud control plane and
writes a `cloud` block to `~/.coro/config.json`:

```jsonc
{
  "cloud": {
    "url":   "https://cloud.example.com",
    "token": "<runner JWT>"
  }
}
```

On the next `coro start`, the runner detects the cloud config, opens
an authenticated WebSocket to the cloud, and runs in hybrid mode. The
dashboard at `localhost:3000/dashboard/` still works; it now reads
team-scoped state from the cloud.

### Webhooks (cloud side)

Webhooks are **not** registered against your laptop in hybrid mode.
Instead, the cloud's stable webhook URL receives BitBucket / GitHub
events; the cloud verifies the per-team HMAC and forwards events to
the right runner over WebSocket. Set webhook URLs per repo in your
git provider:

```
URL:    https://cloud.example.com/webhook/<provider>?team=<teamSlug>
Secret: <per-team webhook secret>
Events: PR Created, Updated, Approved, Merged, Comment created
```

### Cloud control plane (developing it)

If you're hacking on the cloud server itself
(`packages/runner/src/cloud/`), bring up Postgres and run the cloud
entrypoint:

```bash
docker compose -f packages/runner/docker-compose.cloud.yml up -d
pnpm --filter @coro/runner dev:cloud
```

Then point a runner at `http://localhost:8080` (the default cloud
port) using a JWT minted by the cloud's `/auth` flow.

---

## Developing the dashboard

The runner serves the **built** dashboard at `/dashboard/`. While
iterating, run Vite separately for HMR:

```bash
# Terminal 1
pnpm --filter @coro/runner dev          # runner on :3000

# Terminal 2
pnpm --filter @coro/dashboard dev       # Vite dev server, default :5173,
                                        # proxies API calls to localhost:3000
```

To override the production dashboard path the runner serves, set
`CORO_DASHBOARD_DIST=/abs/path/to/dist` before launching it.

---

## Useful root scripts

Defined in `package.json` at the workspace root:

| Command              | What it does                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `pnpm build`         | Build every package                                                   |
| `pnpm typecheck`     | Typecheck every package                                               |
| `pnpm test`          | Run every package's `test` script                                     |
| `pnpm start`         | Build-aware: launch the runner + dashboard (same as `coro start`)     |
| `pnpm dev`           | Run the runner from source via `tsx` (no build step) — auto-reload    |
| `pnpm dev:cloud`     | Start the cloud control plane (Postgres required)                     |
| `pnpm dev:dashboard` | Start the Vite dev server for the dashboard                           |
| `pnpm clean`         | Remove `dist/` and `node_modules/` everywhere                         |

---

## Troubleshooting

**Dashboard doesn't open automatically:**
- Coro suppresses auto-open in headless / CI / SSH environments. Pass
  `coro start --open` to force, or browse to
  `http://localhost:3000/dashboard/` yourself.

**`Cannot read properties of null (reading 'matches')` during install:**
- You used `npm install`. Coro is a pnpm workspace. Use `pnpm install`.

**Job stuck or lost:**
- Check job state: `coro status <jobId>` or open the job in the
  dashboard.
- Inspect the working dir: `ls ~/.coro/work/<jobId>/`
- Force-resume: `coro resume <jobId>`

**Runner can't pair with the cloud:**
- Verify the cloud URL is reachable from your machine.
- Re-run `coro login` to mint a fresh JWT.
- Check `~/.coro/config.json` contains the `cloud` block with both
  `url` and `token`.

**`tenant.overlay` not loading:**
- For `localDir`, the `path` must be absolute and exist.
- For `gitRemote`, the runner clones into
  `~/.coro/cache/tenant-overlays/<tenantId>/`. Delete that directory
  to force a fresh clone, or run with `LOG_LEVEL=debug` to see the
  loader's decisions.
