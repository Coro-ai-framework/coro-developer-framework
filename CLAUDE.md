# Coro — AI Agent Workspace

> **Agent runtime instructions are in `.claude/CLAUDE.md`.** This file is for developers working on this repository.
>
> **Naming note:** the product is now called **Coro**. The MD files under
> `agents/`, `workflows/`, `memory/`, and `.claude/` in this repo currently
> still describe the **A5 Labs example tenant**. Phase 2 of the multi-tenant
> rollout carves the A5 Labs–specific content out into a separate tenant
> overlay. Until then, treat the company-specific facts (BitBucket workspace,
> service accounts, observability endpoints, language migration stories) as
> tenant data, not platform behaviour.

This repository contains the Coro runner, the Coro dashboard, and the
bootstrap intelligence layer (agents, workflows, skills, memory) used by the
A5 Labs example tenant.

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

| Agent file | Phase(s) | Used by workflows |
|-----------|----------|------------------|
| `agents/planner.md` | planning, reporting | job |
| `agents/coder.md` | coding | job |
| `agents/tester.md` | testing | job |
| `agents/evaluator.md` | evaluation | job |
| `agents/pr-reviewer.md` | review | job |
| `agents/spec-writer.md` | spec-writing | job (Jira-triggered) |

Agents are workflow-agnostic and language-agnostic. They receive domain-specific expertise by invoking skills on-demand. The same coder agent works for Go, .NET, and TypeScript projects — the invoked skills change, not the agent.

---

## Skills

On-demand domain knowledge and language conventions that agents invoke via the `Skill` tool:

```
.claude/skills/
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

When any agent calls `propose_change`, the runner's intelligence file watcher detects the written files and automatically:

1. Validates the proposal (TypeScript build, YAML parse, workflow config parse, skill frontmatter)
2. Creates a branch in this repo: `improvement/{short-description}`
3. Commits the changed files
4. Opens a PR tagged with the human developers and the configured reviewer account
5. Labels the PR `agent-self-improvement`

**Agent knowledge improvements are always reviewed by humans before becoming canonical.** No agent can silently modify how other agents behave. Once the PR merges, the runner pulls the latest intelligence and all subsequent job phases use the updated instructions immediately.

The self-improvement pipeline covers three layers of intelligence:
- **Memory** (`memory/*.md`) — high volatility, grows with every job
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
│
├── .claude/                             ← Intelligence loaded by the SDK natively
│   ├── CLAUDE.md                        ← Agent runtime instructions (A5 Labs tenant content)
│   ├── settings.json                    ← Claude Code settings
│   └── skills/
│       ├── feature-planning/SKILL.md
│       ├── feature-testing/SKILL.md
│       ├── golang-conventions/SKILL.md
│       ├── dotnet-conventions/SKILL.md
│       └── self-improvement-guide/SKILL.md
├── config/
│   ├── credentials.md                   ← API keys and tokens (gitignored)
│   └── repos.md                         ← Service registry
├── agents/                              ← Agent role definitions
├── workflows/                           ← Workflow phase definitions
├── memory/                              ← Accumulated knowledge from past jobs
├── docs/                                ← Architecture documentation
│
└── packages/                            ← pnpm workspace packages
    ├── runner/                          ← Coro Runner (TypeScript/Node.js)
    │   ├── docker-compose.yml           ← Local legacy stack: runner + redis + ngrok
    │   ├── docker-compose.cloud.yml     ← Cloud control plane stack: postgres + redis
    │   ├── Dockerfile
    │   ├── package.json                 ← @coro/runner
    │   ├── tsconfig.json
    │   ├── config/settings.example.json
    │   ├── cli/                         ← The `coro` CLI
    │   │   ├── index.ts
    │   │   └── commands/                ← job, login, init, runner, logs, status, ...
    │   └── src/
    │       ├── index.ts                 ← Legacy monolith entry point
    │       ├── server.ts                ← HTTP: /jobs, /webhook, SSE
    │       ├── mcp-server.ts            ← In-process MCP server (Coro domain tools)
    │       ├── mcp-handlers.ts
    │       ├── watcher.ts               ← Self-improvement file watcher
    │       ├── workflow-parser.ts
    │       ├── config/                  ← settings.ts, local-config.ts
    │       ├── jobs/                    ← runner.ts, dispatcher.ts, types.ts
    │       ├── clients/                 ← bitbucket, github, git, jira, loki, tempo
    │       ├── prompt/builder.ts
    │       ├── runner/                  ← Hybrid + local mode bootstrap (`coro runner start`)
    │       ├── cloud/                   ← Cloud control plane service
    │       ├── state/                   ← Redis / SQLite / Cloud state backends
    │       └── tools/                   ← MCP tool implementations
    └── dashboard/                       ← Coro Dashboard (React + Vite)
        ├── package.json                 ← @coro/dashboard
        ├── vite.config.ts
        └── src/                         ← React UI (jobs, intelligence, settings)
```
