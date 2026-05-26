# Local development setup

This guide is for **engineers working on the Coro monorepo** — runner,
dashboard, desktop shell, plugins, and (optionally) the commercial cloud
control plane.

> **Using Coro (not hacking on it)?** Install the desktop app from
> [Coro-ai-framework/coro-release](https://github.com/Coro-ai-framework/coro-release/releases/latest)
> and follow the [README quick start](../README.md#quick-start-desktop).
> No Node.js or `pnpm` required.

---

## Prerequisites

| Tool | Why | Install |
| ---- | --- | ------- |
| **Node.js 20+** | Runner, dashboard, desktop packaging | https://nodejs.org |
| **pnpm 9+** | Workspace package manager | `corepack enable && corepack prepare pnpm@9.15.0 --activate` |
| **Git** | Target repos and `gitRemote` tenant overlays | system |
| **Docker** | Optional — Postgres + Redis for **cloud** development | https://docker.com |

Coro is a **pnpm workspace**. Do not run `npm install` at the root — the
`workspace:*` protocol is required and npm fails mid-install.

For end-to-end job runs you also need (configured in the dashboard or
`~/.coro/config.json`):

- **Anthropic** credentials (executor plugin `anthropic`)
- **SCM** credentials — built-in **GitHub** or **Bitbucket**; **GitLab** via [`@coro-ai/plugin-gitlab`](../packages/plugin-gitlab/)

Optional: tune runner **guardrails** (PR description, diff size) in **Settings → Guardrails** or see [guardrails.md](./guardrails.md).

---

## Workspace bootstrap

From the repository root:

```bash
pnpm install
pnpm -r build          # intelligence-base, runner, dashboard, plugins, …
pnpm typecheck         # optional but recommended before a PR
pnpm test              # all packages; see Testing below
```

| Command | Purpose |
| ------- | ------- |
| `pnpm start` | Built runner + dashboard (`coro start`) |
| `pnpm dev` | Runner from source via `tsx` (fast iteration) |
| `pnpm dev:dashboard` | Vite HMR for dashboard (proxies API to `:3000`) |
| `pnpm dev:cloud` | Cloud control plane (needs Postgres + `.env.cloud`) |
| `pnpm --filter @coro-ai/desktop-electron dev` | Electron shell + bundled sidecar |
| `pnpm clean` | Remove `dist/` and `node_modules/` everywhere |

---

## Solo (local) mode

Solo mode runs the runner, dashboard, and **SQLite** state on one machine.
No Docker required.

### Start the runner

**From a build:**

```bash
pnpm start
# equivalent:
node packages/runner/dist/cli/index.js start
```

**From source (no prior build):**

```bash
pnpm dev
```

This:

- listens on **http://localhost:3000** (override with `coro start --port N`)
- serves the dashboard at **http://localhost:3000/dashboard/**
- opens the browser by default (skipped in headless/SSH/CI; use `--open`,
  `--no-open`, or `CORO_NO_OPEN=1`)

Optional: `pnpm --filter @coro-ai/runner exec npm link` then use `coro start`
anywhere.

### Configure

Use **Settings** in the dashboard (recommended) or edit `~/.coro/config.json`.

Typical fields:

- **`plugins.installed.anthropic`** — API key, OAuth, or Claude Code login
- **`plugins.installed.<scm>`** — GitHub / Bitbucket (see built-ins below)
- **`git`** — legacy-friendly block; merged into plugin config when needed
- **`paths.workingDir`** — job working tree (default under `~/.coro/work`)
- **`intelligence.dir`** — tenant overlay directory (optional)

Schema: [`packages/runner/src/config/local-config.ts`](../packages/runner/src/config/local-config.ts).

### Submit a job

**Dashboard:** **New Job** → pick repo → describe the change.

**CLI** (runner must already be running):

```bash
coro job \
  --repo my-service \
  --description "Add rate limiting to /api/users" \
  --reviewers alice,bob
```

Optional: `--git-provider github|bitbucket`, `--jira-ticket PROJ-123` (Jira-driven
job). The default implementation workflow is
`workflows/job/workflow.md` (resolved from intelligence layers).

```bash
coro jobs
coro status <jobId>
coro logs <jobId> --follow
coro resume <jobId>
```

---

## Plugins (SCM, tracker, LLM)

The runner loads **built-in** plugins from `packages/runner/src/plugins/builtin/`
and **drop-in** plugins from `~/.coro/plugins/<id>/` (with `coro-plugin.json`).

| Kind | Built-in IDs | Notes |
| ---- | ------------ | ----- |
| **SCM** | `github`, `bitbucket` | Configure via Settings → Git |
| **Tracker** | `jira`, `linear`, `github-issues` | Enable in `plugins.installed` |
| **Executor (LLM)** | `anthropic`, `openai` | Anthropic required for default workflows |

**GitLab (SCM):** install the reference package:

```bash
coro plugin install @coro-ai/plugin-gitlab
# configure plugins.installed.gitlab in Settings or config.json
```

**Authoring:** `coro plugin init <id>` scaffolds `~/.coro/plugins/<id>/`.
See [`packages/plugin-sdk/README.md`](../packages/plugin-sdk/README.md) and
[`packages/plugin-gitlab`](../packages/plugin-gitlab/).

```bash
coro plugin list    # built-in + drop-ins (runner must be up for full list)
```

---

## Solo-mode storage

```
~/.coro/
├── config.json                 ← LocalConfig
├── state.db                    ← SQLite (jobs, logs, proposals, …)
├── work/<jobId>/               ← Per-job dirs
│   ├── _intelligence/          ← Materialised overlay for the job
│   └── <repoSlug>/             ← Cloned target repo
├── intelligence/               ← Optional local tenant overlay
├── plugins/<id>/               ← Drop-in plugins
└── cache/tenant-overlays/      ← Cached gitRemote overlays
```

Inspect a running job:

```bash
ls ~/.coro/work/<jobId>/_intelligence/
```

Reset local state (stop the runner first):

```bash
rm ~/.coro/state.db
rm -rf ~/.coro/work/
rm -rf ~/.coro/cache/
```

---

## Tenant overlay (optional)

Add a `tenant.overlay` block to `~/.coro/config.json`:

```jsonc
{
  "tenant": {
    "displayName": "My Team",
    "overlay": {
      "kind": "gitRemote",
      "url": "git@github.com:my-team/coro-overlay.git",
      "ref": "main"
    }
  }
}
```

| `kind` | Behaviour |
| ------ | --------- |
| `localDir` | `{ "kind": "localDir", "path": "/abs/path" }` |
| `gitRemote` | Cloned under `~/.coro/cache/tenant-overlays/<tenantId>/` |
| `cloudBlob` | Served by Coro Cloud in team mode (stub / limited in solo today) |

Merge semantics: [architecture.md §4](architecture.md#4-layered-intelligence).

---

## Hybrid (team) mode

> **Pre-1.0.** Hybrid mode (local runner + shared cloud control plane) is under
> active development. Expect rough edges; production team deployments use the
> commercial surface in `packages/runner/src/cloud/` ([NOTICE.md](../NOTICE.md)).

Each developer runs a **local runner**; job state and team coordination go through
**Coro Cloud**.

### Pair with cloud

With cloud running locally (see below) or against a deployed URL:

```bash
coro login --cloud-url http://localhost:4000
```

This writes a `cloud` block to `~/.coro/config.json`:

```jsonc
{
  "cloud": {
    "url": "http://localhost:4000",
    "token": "<runner JWT>"
  }
}
```

Then `coro start` (or the desktop app) connects over WebSocket. The dashboard
on **localhost:3000** still works; state may be team-scoped via the cloud backend.

### Webhooks (cloud)

Webhooks hit the **cloud**, not your laptop. Preferred shape:

```text
POST https://<cloud-host>/webhook/<teamId>/<pluginId>
```

Example: `https://cloud.example.com/webhook/team-uuid/github`

Configure HMAC secrets per team/plugin in the cloud DB. Legacy provider-named
routes may still forward but are deprecated — see
[`packages/runner/src/cloud/routes/webhooks.ts`](../packages/runner/src/cloud/routes/webhooks.ts).

---

## Cloud control plane (developing)

Source: `packages/runner/src/cloud/` (**commercial license** — development and
transparency only; see [`cloud/LICENSE`](../packages/runner/src/cloud/LICENSE)).

### 1. Start Postgres and Redis

```bash
docker compose -f packages/runner/docker-compose.cloud.yml up -d
```

Defaults: Postgres `localhost:5432` (db/user/password `corocloud`), Redis
`localhost:6379`.

### 2. Environment

Create `packages/runner/.env.cloud` (gitignored):

```bash
DATABASE_URL=postgresql://corocloud:corocloud_dev@localhost:5432/corocloud
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me-to-at-least-32-random-characters
# optional:
# CLOUD_PORT=4000
# JWT_ISSUER=corolabs-cloud
# LOG_LEVEL=debug
```

Apply schema:

```bash
cd packages/runner
pnpm db:push          # or: pnpm db:migrate
```

### 3. Run the cloud API

From repo root:

```bash
pnpm dev:cloud
```

Default listen port: **4000** (`CLOUD_PORT`). Health check:
`http://localhost:4000/health` (if exposed).

### 4. Pair a runner

```bash
coro login --cloud-url http://localhost:4000
coro start
```

---

## Developing the dashboard

The runner serves the **built** dashboard at `/dashboard/`. For HMR:

```bash
# Terminal 1
pnpm dev                 # runner on :3000

# Terminal 2
pnpm dev:dashboard       # Vite on :5173, proxies API to :3000
```

Override the bundle the runner serves:

```bash
export CORO_DASHBOARD_DIST=/abs/path/to/packages/dashboard/dist
pnpm start
```

**Coro plan mode** (New Run chat) hits `POST /intake/stream` on the runner.
It requires a configured LLM executor and uses the executor's `chat()` path
when available (`@coro-ai/llm-anthropic`, `@coro-ai/llm-openai`). User-facing
documentation lives in the docs site: [Coro plan mode](https://docs.coro.build/guides/coro-plan-mode/).

---

## Developing the desktop app

The shipping app is `@coro-ai/desktop-electron` — Electron wraps the runner sidecar
and dashboard ([desktop-packaging.md](desktop-packaging.md)).

```bash
pnpm install && pnpm -r build
pnpm --filter @coro-ai/desktop-electron dev
```

Packages a local run (macOS arm64 / Windows x64) via
`pnpm --filter @coro-ai/desktop-electron dist:mac` or `dist:win`. Releases publish to
[Coro-ai-framework/coro-release](https://github.com/Coro-ai-framework/coro-release).

---

## Testing

```bash
pnpm test                              # all workspace packages
pnpm --filter @coro-ai/runner test        # runner unit + MCP + integration
pnpm --filter @coro-ai/runner test -- tests/unit/foo.test.ts
```

---

## Troubleshooting

**Dashboard does not open**

- Browse to http://localhost:3000/dashboard/ manually, or `coro start --open`.
- Headless/SSH/CI suppresses auto-open; set `CORO_NO_OPEN=1` to keep it off.

**`npm install` crashes**

- Use `pnpm install` at the repo root.

**Job stuck or lost**

- `coro status <jobId>` or open the job in the dashboard.
- `ls ~/.coro/work/<jobId>/`
- `coro resume <jobId>`

**Runner cannot pair with cloud**

- Cloud reachable at `cloud.url` in config (default dev: `http://localhost:4000`).
- Re-run `coro login`.
- Confirm `cloud.token` is present in `~/.coro/config.json`.

**Plugin not loading**

- Drop-ins: `~/.coro/plugins/<id>/coro-plugin.json` and restart the runner.
- Built-ins: check `plugins.installed.<id>.enabled` and config in Settings.
- `coro plugin list` with runner online.

**`tenant.overlay` not applied**

- `localDir` path must exist and be absolute.
- For `gitRemote`, delete `~/.coro/cache/tenant-overlays/<tenantId>/` to force
  re-clone; use `LOG_LEVEL=debug` on the runner for loader logs.

---

## Related docs

| Document | Content |
| -------- | ------- |
| [architecture-overview.md](architecture-overview.md) | Plain-English system tour |
| [architecture.md](architecture.md) | Full architecture + layered intelligence |
| [agent-host-spec.md](agent-host-spec.md) | Runner HTTP API, MCP tools, job lifecycle |
| [desktop-packaging.md](desktop-packaging.md) | Desktop release and updater |
| [workflow-extension-contract.md](workflow-extension-contract.md) | Workflow/plugin extension points |
| [../README.md](../README.md) | Product overview and downloads |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | PR process, CLA, help wanted |
