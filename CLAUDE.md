# Coro — AI Agent Workspace

> **Agent runtime instructions** are in `packages/intelligence-base/layer/.claude/CLAUDE.md`. **This** file is for developers working on this repository.

This repository contains:

- The **Coro runner** (`packages/runner/`) — TypeScript/Node.js process that
  executes agent workflows.
- The **Coro dashboard** (`packages/dashboard/`) — React + Vite web UI.
- The **base intelligence layer** (`packages/intelligence-base/`) — the
  generic, company-agnostic agents, workflows, skills, and memory templates
  that ship with every Coro install. The runner reads its base intelligence
  from this package via `getBaseLayerRoot()`; nothing in the repo root
  shadows it anymore.

### Layered intelligence

Coro composes intelligence from three layers using a **hybrid model**:
the resolver owns Coro-specific content (`agents/`, `workflows/`,
`memory/`, `.claude/skills/`, `.claude/CLAUDE.md`); the target repo's
own `.claude/` is left for Claude Code's native loader to discover at
the SDK's `cwd`.

```
┌─────────────────────────────────────────────────────────────┐
│ Repo overlay        <repoCheckout>/.coro/                   │
├─────────────────────────────────────────────────────────────┤
│ Tenant overlay      localDir | gitRemote | cloudBlob        │
├─────────────────────────────────────────────────────────────┤
│ Base intelligence   @coro/intelligence-base/layer/  ← here  │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
   <workingDir>/<jobId>/_intelligence/    ← materialised overlay
```

- **Base** is everything in `packages/intelligence-base/layer/`. It is
  intentionally company-agnostic: no BitBucket workspace names, no service
  accounts, no migration stories. It is the contract every tenant extends.
- **Tenant overlay** supplies company-specific facts (service-account
  identities, observability endpoints, deployment substrate, etc.).
  Declared via `tenant.overlay` in `~/.coro/config.json` (solo) or by
  the cloud control plane (hybrid, Phase 5). Three source kinds:
  `localDir` (filesystem), `gitRemote` (cached clone under
  `~/.coro/cache/tenant-overlays/<tenantId>/`), and `cloudBlob`
  (Phase 5 stub today — warns and skips).
- **Repo overlay** is per-target-repo customisation that lives in a
  `.coro/` folder inside the repo being worked on. The resolver
  intentionally does NOT touch the repo's `.claude/` — that contract
  belongs to Claude Code's native walk-up via
  `settingSources: ['project']`.

#### Merge semantics

Two deterministic rules, applied per-file as the resolver stacks
layers:

| Path | Mode | Rationale |
|---|---|---|
| `.claude/CLAUDE.md` | **append** with banners | Mirrors Claude Code's native CLAUDE.md walk-up; tenants extend, never overwrite, base guidance. |
| `memory/**/*.md` | **append** with banners | Memory is cumulative knowledge — additions never erase prior entries. |
| Everything else (`agents/`, `workflows/`, `.claude/skills/`, `.claude/settings.json`, …) | **last-wins** (file replace) | Predictable per-path override; tenants and repos can fully redefine an agent or workflow. |

Append banners look like `<!-- ─── coro layer: tenant:team-abc ─── -->`
so the model can see provenance when reading the merged file.

#### Resolver lifecycle

The **intelligence resolver**
(`packages/runner/src/intelligence/resolver.ts`) runs:

1. **At job start** — materialises base + tenant + (opportunistic) repo
   overlay into `<workingDir>/<jobId>/_intelligence/`.
2. **At every phase boundary** — re-resolves idempotently. This is how
   the repo overlay (`<workingDir>/<repoSlug>/.coro/`) gets picked up:
   the agent typically clones the target repo during phase 1, so phase
   2 onward sees the now-present repo `.coro/`.

The runner points all per-job markdown reads (workflow loader, prompt
builder, subagent loader, filesystem hooks) at the resolved path. The
HTTP server still reads `settings.paths.coroIntelligenceDir` for the
read-only mirror it serves — it is tenant-agnostic by design.

#### Tenant context

Every runner instance carries a `TenantContext`
(`packages/runner/src/intelligence/tenant-context.ts`) that identifies
which tenant a job belongs to:

- **Local mode** (single-host SQLite + polling) synthesises `solo-<host>`
  from the OS hostname. The local config can attach a `tenant.overlay`
  source so a single-host solo deployment still benefits from a tenant
  overlay.
- **Hybrid mode** derives `team-<teamId>` from the JWT used to
  authenticate to the cloud control plane. Phase 4 leaves the
  cloud-supplied overlay descriptor `undefined`; Phase 5 wires it in
  via the WebSocket handshake.

The `TenantContext` is attached to the `RunnerContext` at bootstrap and
to the `ToolContext` per job. The intelligence resolver reads it to
decide which tenant overlay to apply; MCP tools that write back to
memory or proposals will use it to route writes to the right layer in
later phases.

## How this system works

Agents in this repository do not run directly inside Claude Code sessions. They are driven by the **Coro Runner** — an always-running TypeScript/Node.js service (`packages/runner/`) that:

1. Receives job requests from the `coro` CLI or external event sources (BitBucket webhooks, Jira webhooks)
2. Creates a typed `Job` object with a `workflowPath` pointing to the correct workflow MD file
3. Assembles a system prompt from the workflow file, agent instructions, and memory — static content (behavior rules, tenant context, git conventions) is loaded natively by the SDK from `.claude/CLAUDE.md`
4. Runs the Claude Agent SDK's `query()` function for each workflow phase — the SDK manages the full tool-use loop, subagent spawning, and conversation history internally
5. Parks the job in Redis when waiting for an external event (PR merge, review comment, human approval)
6. Resumes the job when the expected event webhook arrives

**The MD files in this repo are the intelligence. The Coro Runner is the infrastructure that runs them.**

### Design philosophy

**TypeScript = dumb tool shell.** It runs phases linearly, provides MCP tools, persists state (Redis / SQLite / cloud), and parks/resumes on webhooks. It has zero orchestration intelligence.

**Intelligence = MD files + LLM judgment.** Workflow markdown defines phases and metadata. Agent markdown defines procedures. The LLM reads artifacts, calls tools to update state, and uses `goto_phase` to control flow. The evaluator decides when to loop. The planner decides how many features. The coder decides when it needs a fresh session.

Full architecture: [docs/architecture.md](docs/architecture.md)
Local setup guide: [docs/local-setup.md](docs/local-setup.md)
Coro Runner technical spec: [docs/agent-host-spec.md](docs/agent-host-spec.md)

---

## Job types and workflow routing

Every job carries a `type` and a `workflowPath`. The runner uses these — not hardcoded logic — to decide which workflow and which agents to run. This is how new workflows drop in without changing the infrastructure.

| Trigger | JobType | workflowPath |
|---------|---------|-------------|
| `coro job ...` (CLI) | `job` | `workflows/job/workflow.md` |
| Jira ticket assigned to agent | `job` | `workflows/job/workflow.md` |
| Agent writes to `memory/`, `agents/`, or `.claude/` | `self-update` | *(inline, no workflow file)* |

---

## What lives here

- **agents/** — One MD file per agent. Each defines role, inputs, outputs, and step-by-step procedure. Agents are language-agnostic generic process definitions.
- **workflows/** — Lifecycle definitions, one subdirectory per workflow type. Each `workflow.md` has YAML front matter defining phases, agent assignments, model selection, and subagent definitions.
- **.claude/** — Intelligence loaded by the Agent SDK natively:
  - `.claude/CLAUDE.md` — Always-loaded runtime instructions: behavior rules, tenant context, git conventions, infrastructure context.
  - `.claude/skills/` — On-demand domain knowledge and language conventions. Agents invoke skills when they need specialized guidance (e.g., `feature-planning`, `golang-conventions`).
- **config/** — `credentials.md` (gitignored, read by the runner at startup) and `repos.md` (service registry).
- **memory/** — Accumulated knowledge from past jobs. Read at the start of every phase. Never modified directly — updates go through a self-improvement PR.
- **docs/** — Architecture documentation for engineers and stakeholders.
- **packages/runner/** — The Coro Runner (TypeScript/Node.js). Local agent runtime, cloud control plane, and the `coro` CLI.
- **packages/dashboard/** — The Coro Dashboard (React + Vite). Web UI for jobs, intelligence editing, and tenant administration.

---

## Language-agnostic architecture

The system is fully language-agnostic. No language-specific defaults are hardcoded in the infrastructure. Language support works through two layers:

1. **Convention skills** (`.claude/skills/{language}-conventions/SKILL.md`) — coding standards per language. Adding a new language means writing one skill file.
2. **Planner agent** — detects the target language from the repository (e.g., `go.mod` → `golang`, `*.csproj` → `dotnet`) and calls `set_job_params({ language: "..." })` so downstream agents know which conventions skill to invoke.

---

## Agents

| Agent file | Phase(s) / role | Used by workflows |
|-----------|----------------|------------------|
| `agents/planner.md` | planning | job |
| `agents/coder.md` | coding | job |
| `agents/code-reviewer.md` | `code-reviewer` subagent invoked by the coder pre-PR-open | job |
| `agents/pr-reviewer.md` | review (merge gatekeeper) | job |
| `agents/evaluator.md` | evaluation (verify build/tests/acceptance criteria + loop control) | job |
| `agents/spec-writer.md` | spec-writing | job (Jira-triggered) |
| `agents/campaign-planner.md` | campaign-planning | campaign |
| `agents/campaign-evaluator.md` | aggregation | campaign |

Agents are workflow-agnostic and language-agnostic. They receive domain-specific expertise by invoking skills on-demand. The same coder agent works for Go, .NET, and TypeScript projects — the invoked skills change, not the agent.

The implementation-job pipeline is intentionally tight: the convention/plan/test-coverage **review** happens once, inside the coding phase, via the `code-reviewer` subagent. The standalone `review` phase is a thin merge gatekeeper that handles human coordination + merge. **Build/test verification and acceptance-criteria checks** are owned by the evaluator (which runs them on the merged commit). Earlier versions had separate `review` and `testing` phases that re-did the same work — that has been consolidated to keep token cost and wall-clock time down without losing any robustness.

---

## Skills

On-demand domain knowledge and language conventions that agents invoke via the `Skill` tool:

```
packages/intelligence-base/layer/.claude/skills/
  feature-planning/SKILL.md         — Generic implementation planning guidance
  feature-testing/SKILL.md          — Generic implementation testing guidance
  golang-conventions/SKILL.md       — Go coding standards
  dotnet-conventions/SKILL.md       — .NET/C# coding standards
  self-improvement-guide/SKILL.md   — Proposal types and file structure guide
```

Skills are invoked on-demand by agents, reducing per-phase token costs compared to always-injected knowledge modules.

---

## How to start a workflow

```bash
coro job \
  --repo my-service-go \
  --description "Add rate limiting to /api/users" \
  --reviewers alice,bob

# Check job status
coro status --job my-service-job-1712123456789

# Stream live logs for a running job
coro logs --job my-service-job-1712123456789

# List all jobs
coro jobs
```

---

## Self-improvement rule

When any agent calls `propose_change`, the runner synchronously:

1. Validates the proposal (path allowlist per layer, frontmatter / heading checks per type)
2. Routes the change to the right writable layer — **tenant** (the configured intelligence repo, identical for solo and team) or **repo** (the project's `.coro/` overlay). The base layer that ships with the runner is never written.
3. Cuts a branch `coro/proposal/<jobId>-<layer>-<slug>` from that layer's default branch
4. Commits every file in the multi-file payload as one atomic commit
5. Pushes and opens a PR via the configured git provider (GitHub or Bitbucket)
6. Records the proposal in the state backend so `list_proposals` and the dashboard can surface it

**Agent knowledge improvements are always reviewed by humans before becoming canonical.** No agent can silently modify how other agents behave. Once the PR merges, the next job's intelligence resolver pulls the merged change automatically.

Each call produces exactly one PR. Bundle every file change for a layer into one `propose_change` call — splitting creates duplicate PRs. The Evaluator (and PR Reviewer for cross-PR systemic patterns) is responsible for grooming insights into a single multi-file proposal per layer per job.

The self-improvement pipeline covers three writable surfaces (across the tenant and repo layers):
- **Memory** (`memory/*.md` tenant, `.coro/memory/*.md` repo) — high volatility, grows with every job
- **Skills** (`.claude/skills/*/SKILL.md`) — medium volatility, updated when agents discover systemic gaps
- **Agent instructions** (`agents/*.md`) — lower volatility, updated when procedures need fixing

---

## Repository structure

```
a5-ai/                                   ← workspace root (will be renamed to coro/ in a future cut)
├── CLAUDE.md                            ← You are here. Developer-facing guide.
├── package.json                         ← pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json                   ← Shared TS compiler options
├── README.md                            ← User-facing quick start + workflows
├── docs/                                ← Architecture documentation
│
└── packages/                            ← pnpm workspace packages
    ├── intelligence-base/               ← @coro/intelligence-base — base intelligence layer
    │   ├── package.json
    │   ├── README.md
    │   ├── src/index.ts                 ← Manifest: getBaseLayerRoot(), pathInBaseLayer()
    │   ├── tests/manifest.test.ts
    │   └── layer/                       ← THE canonical generic intelligence
    │       ├── .claude/
    │       │   ├── CLAUDE.md            ← Generic Coro runtime instructions
    │       │   └── skills/
    │       │       ├── feature-planning/SKILL.md
    │       │       ├── feature-testing/SKILL.md
    │       │       ├── golang-conventions/SKILL.md
    │       │       ├── dotnet-conventions/SKILL.md
    │       │       └── self-improvement-guide/SKILL.md
    │       ├── agents/                  ← Generic agent role definitions
    │       ├── workflows/               ← Generic workflow phase definitions
    │       └── memory/                  ← Empty memory templates (tenants populate)
    ├── runner/                          ← Coro Runner (TypeScript/Node.js)
    │   ├── docker-compose.cloud.yml     ← Cloud control plane stack: postgres + redis
    │   ├── package.json                 ← @coro/runner
    │   ├── tsconfig.json
    │   ├── cli/                         ← The `coro` CLI
    │   │   ├── index.ts                 ← Top-level program (`coro start`, …)
    │   │   ├── browser-open.ts          ← Auto-opens dashboard with headless detection
    │   │   └── commands/                ← start, job, login, init, runner, logs, status, …
    │   └── src/
    │       ├── dashboard-dist.ts        ← Resolves built dashboard assets (shared helper)
    │       ├── claude-code-path.ts      ← Resolves bundled Claude Code CLI
    │       ├── mcp-server.ts            ← In-process MCP server (Coro domain tools)
    │       ├── mcp-handlers.ts
    │       ├── workflow-parser.ts
    │       ├── config/                  ← settings.ts (types only), local-config.ts
    │       ├── jobs/                    ← runner.ts, dispatcher.ts, types.ts
    │       ├── clients/                 ← bitbucket, github, git, jira, loki, tempo
    │       ├── prompt/builder.ts
    │       ├── intelligence/            ← Layered intelligence
    │       │   ├── tenant-context.ts    ← TenantContext (solo / team)
    │       │   ├── resolver.ts          ← Per-job overlay materialisation
    │       │   ├── merge.ts             ← Layer merge primitives (replace + append)
    │       │   └── loaders/             ← localDir, gitRemote, cloudBlob, repo .coro/
    │       ├── runner/                  ← Local + hybrid bootstrap (`coro start`)
    │       │   ├── index.ts             ← startRunner(): mode dispatch + bootstrap
    │       │   ├── server.ts            ← Express server: /dashboard, /jobs, /config, …
    │       │   ├── claude-login.ts      ← Claude OAuth login flow used by dashboard
    │       │   └── hybrid-dispatcher.ts ← WebSocket-driven cloud job dispatch
    │       ├── cloud/                   ← Cloud control plane service
    │       ├── state/                   ← SQLite (local) and cloud-backed (hybrid) state backends
    │       └── tools/                   ← MCP tool implementations
    └── dashboard/                       ← Coro Dashboard (React + Vite)
        ├── package.json                 ← @coro/dashboard
        ├── vite.config.ts
        └── src/                         ← React UI (jobs, intelligence, settings)
```
