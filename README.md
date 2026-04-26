# Coro

> **Multi-tenant, plug-and-play AI agent platform** for software teams.
> One product, two deployment shapes: **solo** (everything on your laptop) and
> **team** (shared SaaS control plane + per-developer runner).

Coro turns plain markdown into specialised AI engineers — planners, coders,
testers, reviewers — that work together on real PRs against your real
repositories. Customise their behaviour by dropping markdown into a folder;
extend them with MCP tools when you need new capabilities.

> **Status: pre-1.0.** The repository is mid-rebrand from `a5` → `coro`
> and mid-restructure into a pnpm workspace. Solo mode runs end-to-end;
> team mode and the desktop shell are tracked under [Roadmap](#roadmap).

> ⚠️ **Use `pnpm`, not `npm`.** This is a pnpm workspace and the
> `workspace:`* protocol used to link packages will crash `npm install`
> with `Cannot read properties of null (reading 'matches')`. See
> [Quick start → Prerequisites](#prerequisites) for the one-line install.

---

## Table of contents

- [Quick start](#quick-start)
- [What you get](#what-you-get)
- [Repository layout](#repository-layout)
- [The intelligence layers](#the-intelligence-layers)
- [Working on the codebase](#working-on-the-codebase)
  - [Runner (`@coro/runner`)](#runner-coro-runner)
  - [Dashboard (`@coro/dashboard`)](#dashboard-coro-dashboard)
  - [Base intelligence (`@coro/intelligence-base`)](#base-intelligence-coro-intelligence-base)
- [CLI reference (advanced)](#cli-reference-advanced)
- [Configuration](#configuration)
- [Testing](#testing)
- [Roadmap](#roadmap)

---

## Quick start

> **Coro is a desktop-style product:** the **dashboard** is the primary way
> you configure and use it. The CLI exists for scripting, CI, and power
> users — you should not need it for normal use.

You'll bring up the runner with one command, finish setup in the dashboard
that opens automatically, and drive Coro from the UI from there on.

### Prerequisites

| Tool                   | Version                     | Why                                          |
| ---------------------- | --------------------------- | -------------------------------------------- |
| **Node.js**            | `>=20`                      | Runtime for runner + dashboard build         |
| **pnpm**               | `>=9`                       | Workspace package manager (this repo)        |
| **git**                | any recent                  | Cloning target repos + intelligence overlays |
| **Anthropic credentials** | API key, OAuth token, or Claude Code login | Collected in the dashboard, not the CLI |
| **Git provider token** | BitBucket / GitHub / GitLab | Collected in the dashboard, not the CLI |

> **Why pnpm?** This repo is a pnpm workspace (`pnpm-workspace.yaml`) and
> the runner depends on `@coro/intelligence-base` via `workspace:*`. npm
> doesn't understand that protocol and crashes mid-install. Easiest install:
>
> ```bash
> # Recommended — uses corepack (ships with Node 20+) to install the exact
> # pnpm version pinned in package.json (no global install pollution).
> corepack enable                  # may need sudo on Homebrew Node
> corepack prepare pnpm@9.15.0 --activate
>
> # Or, if you prefer a global install:
> npm install -g pnpm@9
> ```

### 1. Install once

```bash
pnpm install
pnpm -r build      # builds @coro/intelligence-base, @coro/runner, @coro/dashboard
```

### 2. Start Coro

```bash
node packages/runner/dist/cli/index.js start
```

This boots the runner, serves the dashboard at
**http://localhost:3000/dashboard/**, and **opens it in your browser
automatically**. (Skipped in headless / CI / SSH environments — pass
`--open` to force, or `--no-open` to suppress.)

### 3. Finish setup in the dashboard

On first run the dashboard greets you with a **Welcome to Coro** banner
and a one-click path into **Settings**, where you'll provide:

- **Anthropic credentials** — API key, OAuth token, or Claude Code login
- **Git provider + access token** — for cloning repos and opening PRs
- **Working directory + intelligence directory** (sensible defaults pre-filled)

Hit **Save** and you're configured. Settings are persisted to
`~/.coro/config.json`; you can edit them later from the same page or by
hand. The full schema lives in
[`packages/runner/src/config/local-config.ts`](packages/runner/src/config/local-config.ts).

### 4. Submit your first job

From the dashboard's **New Job** page, point Coro at a repository and
describe the change you want. Watch progress live; when the agent is done,
it opens a PR against your target repo.

> **Tip — short `coro` command:** install the runner globally with
> `pnpm --filter @coro/runner exec npm link` (or `npm i -g ./packages/runner`
> after build) so you can drop the `node packages/runner/dist/cli/index.js`
> prefix and just type `coro start`.

---

## What you get

- **Multi-agent orchestration** — a planner decomposes the spec, coders
implement, testers verify, a reviewer critiques. All agents are plain
markdown in `agents/` (or your overlay).
- **Workflow phases** — the runner advances through user-defined phases
(`workflows/job/phase-*.md`); each phase can spawn subagents and re-resolve
intelligence.
- **Layered intelligence** — base (shipped), tenant (your team), repo
(per-codebase). See [The intelligence layers](#the-intelligence-layers).
- **Local HTTP API + dashboard** — the runner exposes a REST API and serves
a built React dashboard at `/dashboard/`.
- **Persistent state** — SQLite in solo mode, Postgres + Redis in team mode.
- **Self-improvement loop** — agents can call `propose_change` to suggest
improvements to their own intelligence; in solo mode these land as files
in your intelligence dir for review.

---

## Repository layout

```
a5-ai/
├── packages/
│   ├── runner/                  ← @coro/runner — the runtime + CLI + REST server
│   │   ├── src/                 ← runtime: jobs, intelligence resolver, MCP tools, state
│   │   ├── cli/                 ← `coro …` CLI commands (init, runner, job, logs, …)
│   │   └── tests/               ← vitest suites (unit, integration, mcp, runner)
│   ├── dashboard/               ← @coro/dashboard — React + Vite + Tailwind UI
│   │   └── src/
│   └── intelligence-base/       ← @coro/intelligence-base — base layer markdown + thin TS API
│       ├── layer/               ← THE base intelligence
│       │   ├── .claude/{CLAUDE.md, skills/}
│       │   ├── agents/
│       │   ├── workflows/
│       │   └── memory/
│       └── src/index.ts         ← getBaseLayerRoot(), pathInBaseLayer(), …
│
├── docs/                        ← Architecture deep dives
├── pnpm-workspace.yaml          ← workspace globs
├── pnpm-lock.yaml
├── package.json                 ← root scripts (build, typecheck, test, dev:*)
├── tsconfig.base.json           ← shared TS compiler options
├── README.md                    ← you are here
└── CLAUDE.md                    ← engineering reference for the monorepo
```

### Where does the base intelligence live?

**One place:** `packages/intelligence-base/layer/`. The runner resolves it
at startup via `getBaseLayerRoot()` and stacks tenant + repo overlays on
top per job. There is no shadow copy at the repo root.

> *History:* before Phase 2 we kept a working copy of the base layer at
> the repo root (`./agents/`, `./memory/`, `./workflows/`, `./.claude/`).
> That mirror has been removed now that the runner reads exclusively from
> `@coro/intelligence-base`.

The repo's top-level `**CLAUDE.md`** is unrelated to the agent runtime —
it's the engineering doc for humans working on this monorepo, and Claude
Code picks it up automatically when you run `claude` inside the repo.

---

## The intelligence layers

Coro composes agent behaviour from three layers, materialised per-job into
`<workingDir>/<jobId>/_intelligence/`:

```
┌─────────────────────────────────────────────────────────────┐
│ Repo overlay        <repoCheckout>/.coro/                   │
├─────────────────────────────────────────────────────────────┤
│ Tenant overlay      localDir | gitRemote | cloudBlob        │
├─────────────────────────────────────────────────────────────┤
│ Base intelligence   @coro/intelligence-base/layer/          │
└─────────────────────────────────────────────────────────────┘
```


| Layer      | Source                           | Who owns it        | When it loads                                                                       |
| ---------- | -------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| **Base**   | `@coro/intelligence-base/layer/` | Coro maintainers   | At runner start                                                                     |
| **Tenant** | `tenant.overlay` in your config  | Your team          | At job start                                                                        |
| **Repo**   | `<targetRepo>/.coro/`            | The repo's authors | At each phase boundary (opportunistic — the agent clones the repo, then it appears) |


Merge rules:


| Path                                                            | Mode                               |
| --------------------------------------------------------------- | ---------------------------------- |
| `.claude/CLAUDE.md`                                             | **append** with provenance banners |
| `memory/**/*.md`                                                | **append** with provenance banners |
| Everything else (`agents/`, `workflows/`, `.claude/skills/`, …) | **last-wins** replace              |


The target repo's own `.claude/` is **not** touched by Coro — Claude Code's
native walk-up handles it directly when the SDK is rooted in the cloned
repo. This is the "hybrid Claude-native" model.

Full reference: see `[CLAUDE.md](CLAUDE.md)` under "Layered intelligence".

---

## Working on the codebase

### Bootstrap once

```bash
pnpm install        # links workspace packages
pnpm -r build       # builds all packages
pnpm -r typecheck   # verifies types across the workspace
```

Useful root scripts (defined in `[package.json](package.json)`):


| Command              | What it does                                      |
| -------------------- | ------------------------------------------------- |
| `pnpm build`         | Build every package                               |
| `pnpm typecheck`     | Typecheck every package                           |
| `pnpm test`          | Run every package's `test` script                 |
| `pnpm dev:runner`    | Start the runner via tsx (no build step)          |
| `pnpm dev:cloud`     | Start the cloud control plane (Postgres required) |
| `pnpm dev:dashboard` | Start Vite dev server for the dashboard           |
| `pnpm clean`         | Remove `dist/` and `node_modules/` everywhere     |


### Runner (`@coro/runner`)

The local agent runtime, REST server, and `coro` CLI.

```bash
# Build / typecheck
pnpm --filter @coro/runner build
pnpm --filter @coro/runner typecheck

# Develop with auto-reload (no build)
pnpm --filter @coro/runner dev:runner    # local-mode runner from CLI
pnpm --filter @coro/runner dev:cloud     # cloud control plane

# Tests
pnpm --filter @coro/runner test
pnpm --filter @coro/runner test -- tests/unit/intelligence-resolver.test.ts
pnpm --filter @coro/runner test:watch
pnpm --filter @coro/runner test:coverage
```

Key directories:

- `src/runner/` — local & hybrid bootstraps, REST server, OAuth helpers
- `src/jobs/` — job lifecycle, phase loop, intelligence resolution per phase
- `src/intelligence/` — resolver, layer-merge primitives, tenant/repo loaders
- `src/tools/` — MCP tool implementations (`coro__*`)
- `src/state/` — SQLite (solo) and Redis (legacy/hybrid) state backends
- `cli/` — `coro` commands

### Dashboard (`@coro/dashboard`)

React + Vite + Tailwind. The runner serves its built `dist/` at
`/dashboard/` in production; in development you run Vite separately and
point it at the runner's API.

```bash
# Build static assets (what the runner serves)
pnpm --filter @coro/dashboard build

# Vite dev server with HMR (default port 5173)
pnpm --filter @coro/dashboard dev

# Typecheck
pnpm --filter @coro/dashboard typecheck
```

> **Heads-up:** `pnpm dev:dashboard` proxies API calls to
> `http://localhost:3000` (the runner). Start the runner first.

> **Override the production dashboard path** by setting
> `CORO_DASHBOARD_DIST=/abs/path/to/dist` before launching the runner. Useful
> when packaging the runner separately from the dashboard.

### Base intelligence (`@coro/intelligence-base`)

The shipped, company-agnostic agents/workflows/skills/memory templates,
plus a thin TypeScript API for resolving paths into the layer.

```bash
pnpm --filter @coro/intelligence-base build
pnpm --filter @coro/intelligence-base test
```

To add a new generic capability everyone benefits from, edit the markdown
under `packages/intelligence-base/layer/`. Anything company-specific
belongs in a *tenant overlay*, not here. See the package's own
[README](packages/intelligence-base/README.md) for the layering contract.

---

## CLI reference (advanced)

> Most users only need `coro start` and the dashboard. The commands below
> exist for scripting, CI, headless setups, and power users — they are
> **not** required for normal use.

After `pnpm -r build`, the binary lives at
`packages/runner/dist/cli/index.js`. Run any command with `--help` for
flags.

**Primary**

| Command                              | Purpose                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `coro start [--no-open] [--port N]`  | Start the runner + dashboard and (by default) open the dashboard in a browser |

**Setup (advanced — the dashboard does this graphically)**

| Command                        | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `coro init [--local]`          | Non-interactive / scripted first-time configuration (writes `~/.coro/config.json`) |
| `coro login`                   | Pair the runner with the cloud control plane (team mode) |

**Day-to-day (the dashboard mirrors all of these)**

| Command                        | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `coro job --repo … --spec …`   | Submit a new job                                         |
| `coro jobs`                    | List recent jobs                                         |
| `coro status <jobId>`          | Show a job's current state and phase                     |
| `coro logs <jobId> [--follow]` | Stream a job's logs                                      |
| `coro message <jobId> <text>`  | Send a mid-flight message to a running job               |
| `coro resume <jobId>`          | Resume a paused/failed job                               |
| `coro runner status`           | Show resolved config + mode (`local` / `hybrid`)         |
| `coro runner start`            | Alias of `coro start` (kept for back-compat)             |

> Tip: alias `coro=node $(pwd)/packages/runner/dist/cli/index.js` in your
> shell while developing, or `npm link` the runner package once.

**Auto-open behaviour:** `coro start` will not open a browser when it
detects a headless environment (`CI=true`, `SSH_CONNECTION` set, or a
Linux desktop with no `DISPLAY`). Override with `--open` (force) or
`--no-open` (suppress), or set `CORO_NO_OPEN=1` permanently.

---

## Configuration

Solo-mode config lives at `~/.coro/config.json`. Schema and defaults are
in `[packages/runner/src/config/local-config.ts](packages/runner/src/config/local-config.ts)`.

Minimal example:

```json
{
  "anthropic": { "method": "apiKey", "apiKey": "sk-ant-…" },
  "intelligence": { "dir": "~/.coro/intelligence" },
  "paths":        { "workingDir": "~/.coro/work" },
  "git": {
    "provider":  "bitbucket",
    "username":  "you@example.com",
    "token":     "ATBB…",
    "workspace": "your-workspace"
  }
}
```

Optional `tenant.overlay` (Phase 4) lets you pull a tenant intelligence
overlay from a local directory or a git remote:

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

Cached clones live under `~/.coro/cache/tenant-overlays/<tenantId>/`.

---

## Testing

```bash
pnpm test                                    # everything
pnpm --filter @coro/runner test              # runner unit + mcp + integration
pnpm --filter @coro/runner test:integration  # job-level integration tests
pnpm --filter @coro/runner test:mcp          # MCP tool surface tests
pnpm --filter @coro/runner test -- <pattern> # single file or pattern
```

Three pre-existing tests are known to fail without local Redis (two in
`tests/integration/job-registry.redis.test.ts`, one in
`tests/integration/dispatcher-send-message.test.ts`). They are unrelated
to solo mode and skipped in CI defaults.

---

## Roadmap

- **Phase 5 — Hybrid/team SaaS:** cloud control plane (`@coro/runner`'s
`src/cloud/`) wires JWT-issued `tenant.overlay` configs and the
`cloudBlob` overlay loader.
- **Desktop shell:** ship a single-binary distribution
(Electron or Tauri — TBD) that wraps the runner + dashboard so non-CLI
users can install Coro by downloading one app.
- **CLI install:** publish a single `npm i -g @coro/cli` once the workspace
separation has settled.
- **Legacy monolith retirement:** remove the `packages/runner/src/index.ts`
bootstrap (and its file watcher / Redis assumptions) now that solo and
hybrid modes cover all use cases.

For a developer-oriented deep dive on the architecture (intelligence
resolver, MCP tool wiring, tenant context, runner modes), read
`[CLAUDE.md](CLAUDE.md)`.