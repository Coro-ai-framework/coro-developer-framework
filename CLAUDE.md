# A5 Labs — AI Agent Workspace

> **Agent runtime instructions are in `.claude/CLAUDE.md`.** This file is for developers working on this repository.

This repository contains all AI agent definitions, workflows, skills, memory, and tooling for A5 Labs engineering automation.

## How this system works

Agents in this repository do not run directly inside Claude Code sessions. They are driven by the **Agent Host Service** — an always-running TypeScript/Node.js service (`tools/`) that:

1. Receives job requests from the `a5` CLI or external event sources (BitBucket webhooks, Jira webhooks)
2. Creates a typed `Job` object with a `workflowPath` pointing to the correct workflow MD file
3. Assembles a system prompt from the workflow file, agent instructions, and memory — static content (behavior rules, company context, git conventions) is loaded natively by the SDK from `.claude/CLAUDE.md`
4. Runs the Claude Agent SDK's `query()` function for each workflow phase — the SDK manages the full tool-use loop, subagent spawning, and conversation history internally
5. Parks the job in Redis when waiting for an external event (PR merge, review comment, human approval)
6. Resumes the job when the expected event webhook arrives

**The MD files in this repo are the intelligence. The Agent Host is the infrastructure that runs them.**

### Design philosophy

**TypeScript = dumb tool shell.** It runs phases linearly, provides MCP tools, persists state in Redis, and parks/resumes on webhooks. It has zero orchestration intelligence.

**Intelligence = MD files + LLM judgment.** Workflow markdown defines phases and metadata. Agent markdown defines procedures. The LLM reads artifacts, calls tools to update state, and uses `goto_phase` to control flow. The evaluator decides when to loop. The planner decides how many features. The coder decides when it needs a fresh session.

Full architecture: [docs/architecture.md](docs/architecture.md)
Local setup guide: [docs/local-setup.md](docs/local-setup.md)
Agent Host technical spec: [docs/agent-host-spec.md](docs/agent-host-spec.md)

---

## Job types and workflow routing

Every job carries a `type` and a `workflowPath`. The Agent Host uses these — not hardcoded logic — to decide which workflow and which agents to run. This is how new workflows drop in without changing the infrastructure.

| Trigger | JobType | workflowPath |
|---------|---------|-------------|
| `a5 migrate ...` (CLI) | `migration` | `workflows/migration/workflow.md` |
| `a5 feature ...` (CLI) | `feature` | `workflows/feature/workflow.md` |
| Jira ticket assigned to agent | `feature` | `workflows/feature/workflow.md` |
| Agent writes to `memory/`, `agents/`, or `.claude/` | `self-update` | *(inline, no workflow file)* |

---

## What lives here

- **agents/** — One MD file per agent. Each defines role, inputs, outputs, and step-by-step procedure. Agents are language-agnostic generic process definitions.
- **workflows/** — Lifecycle definitions, one subdirectory per workflow type. Each `workflow.md` has YAML front matter defining phases, agent assignments, model selection, and subagent definitions.
- **.claude/** — Intelligence loaded by the Agent SDK natively:
  - `.claude/CLAUDE.md` — Always-loaded runtime instructions: behavior rules, company context, git conventions, infrastructure context.
  - `.claude/skills/` — On-demand domain knowledge and language conventions. Agents invoke skills when they need specialized guidance (e.g., `migration-coding`, `golang-conventions`).
- **config/** — `credentials.md` (gitignored, read by Agent Host at startup) and `repos.md` (service registry).
- **memory/** — Accumulated knowledge from past jobs. Read at the start of every phase. Never modified directly — updates go through a self-improvement PR.
- **docs/** — Architecture documentation for engineers and stakeholders.
- **tools/** — The Agent Host Service (TypeScript/Node.js). This is what actually runs the agents.

---

## Language-agnostic architecture

The system is fully language-agnostic. No language-specific defaults are hardcoded in the infrastructure. Language support works through two layers:

1. **Convention skills** (`.claude/skills/{language}-conventions/SKILL.md`) — coding standards per language. Adding a new language means writing one skill file.
2. **Planner agent** — detects the target language from the repository (e.g., `go.mod` → `golang`, `*.csproj` → `dotnet`) and calls `set_job_params({ language: "..." })` so downstream agents know which conventions skill to invoke.

---

## Agents

| Agent file | Phase(s) | Used by workflows |
|-----------|----------|------------------|
| `agents/analyzer.md` | analysis | migration |
| `agents/planner.md` | planning, reporting | migration, feature |
| `agents/coder.md` | repo-setup, coding | migration, feature |
| `agents/tester.md` | testing | migration, feature |
| `agents/evaluator.md` | evaluation | migration, feature |
| `agents/pr-reviewer.md` | review | migration, feature |
| `agents/spec-writer.md` | spec-writing | feature (Jira-triggered) |

Agents are workflow-agnostic and language-agnostic. They receive domain-specific expertise by invoking skills on-demand. The same coder agent works for Go migrations, .NET features, and TypeScript projects — the invoked skills change, not the agent.

---

## Skills

On-demand domain knowledge and language conventions that agents invoke via the `Skill` tool:

```
.claude/skills/
  migration-analysis/SKILL.md       — .NET codebase analysis patterns
  migration-planning/SKILL.md       — Migration planning heuristics
  migration-coding/SKILL.md         — Contract parity and translation patterns
  migration-testing/SKILL.md        — Comparison testing methodology
  migration-evaluation/SKILL.md     — Migration failure taxonomy
  migration-review/SKILL.md         — Migration PR review checklist
  feature-planning/SKILL.md         — Feature scoping and planning
  feature-testing/SKILL.md          — Feature testing methodology
  golang-conventions/SKILL.md       — Go coding standards
  dotnet-conventions/SKILL.md       — .NET/C# coding standards
  self-improvement-guide/SKILL.md   — Proposal types and file structure guide
```

Skills are invoked on-demand by agents, reducing per-phase token costs compared to always-injected knowledge modules.

---

## How to start a workflow

```bash
# Migrate a .NET service to Go
a5 migrate \
  --repo my-service \
  --projects MyService.API,MyService.Models \
  --reviewers alice,bob \
  --staging-url https://staging.my-service.a5labs.com

# Implement a feature
a5 feature \
  --repo my-service-go \
  --description "Add rate limiting to /api/users" \
  --reviewers alice,bob

# Check job status
a5 status --job my-service-migration

# Stream live logs for a running job
a5 logs --job my-service-migration

# List all jobs
a5 jobs
```

---

## Self-improvement rule

When any agent calls `propose_change`, the Agent Host file watcher detects the written files and automatically:

1. Validates the proposal (TypeScript build, YAML parse, workflow config parse, skill frontmatter)
2. Creates a branch in this repo: `improvement/{short-description}`
3. Commits the changed files
4. Opens a PR tagged with the human developers and `@a5-reviewer-agent`
5. Labels the PR `agent-self-improvement`

**Agent knowledge improvements are always reviewed by humans before becoming canonical.** No agent can silently modify how other agents behave. Once the PR merges, the Agent Host pulls the latest `a5-ai` and all subsequent job phases use the updated instructions immediately.

The self-improvement pipeline covers three layers of intelligence:
- **Memory** (`memory/*.md`) — high volatility, grows with every job
- **Skills** (`.claude/skills/*/SKILL.md`) — medium volatility, updated when agents discover systemic gaps
- **Agent instructions** (`agents/*.md`) — lower volatility, updated when procedures need fixing

---

## Repository structure

```
a5-ai/
├── CLAUDE.md                             ← You are here. Developer-facing guide.
├── .claude/
│   ├── CLAUDE.md                         ← Agent runtime instructions (loaded by SDK)
│   ├── settings.json                     ← Claude Code settings
│   └── skills/                           ← On-demand skills (domain knowledge + conventions)
│       ├── migration-analysis/SKILL.md
│       ├── migration-planning/SKILL.md
│       ├── migration-coding/SKILL.md
│       ├── migration-testing/SKILL.md
│       ├── migration-evaluation/SKILL.md
│       ├── migration-review/SKILL.md
│       ├── feature-planning/SKILL.md
│       ├── feature-testing/SKILL.md
│       ├── golang-conventions/SKILL.md
│       ├── dotnet-conventions/SKILL.md
│       └── self-improvement-guide/SKILL.md
├── config/
│   ├── credentials.md                    ← API keys and tokens (gitignored)
│   └── repos.md                          ← Service registry (add services here before migrating)
├── agents/
│   ├── analyzer.md                       ← Codebase analysis (language-agnostic)
│   ├── planner.md                        ← Implementation planning and ordering
│   ├── coder.md                          ← Code generation and PR management (unified, language-agnostic)
│   ├── tester.md                         ← Build verification and testing
│   ├── evaluator.md                      ← Failure diagnosis, memory updates, feature loop management
│   ├── pr-reviewer.md                    ← PR review, merge coordination
│   └── spec-writer.md                    ← Jira ticket → feature spec
├── workflows/
│   ├── migration/
│   │   ├── workflow.md                   ← Migration lifecycle (YAML + docs)
│   │   └── report-template.md           ← Final migration report
│   └── feature/
│       └── workflow.md                   ← Feature implementation lifecycle (YAML + docs)
├── memory/
│   ├── MEMORY.md                        ← Index — loaded into every agent prompt
│   ├── known-pitfalls.md                ← Translation mistakes and failure patterns
│   ├── successful-patterns.md           ← Validated approaches to reuse
│   ├── pr-feedback.md                   ← Recurring developer review feedback
│   └── dotnet-to-go-mappings.md         ← .NET→Go translation patterns (pre-seeded)
├── docs/
│   ├── architecture.md                  ← Full system architecture
│   ├── architecture-overview.md         ← High-level overview
│   ├── local-setup.md                   ← Docker Compose + ngrok local dev guide
│   └── agent-host-spec.md               ← Agent Host technical specification
└── tools/                               ← Agent Host Service (TypeScript/Node.js)
    ├── docker-compose.yml               ← Local stack: agent-host + redis + ngrok
    ├── Dockerfile
    ├── package.json
    ├── tsconfig.json
    ├── .env.example
    ├── config/
    │   └── settings.example.json
    ├── cli/                             ← The `a5` CLI
    │   ├── index.ts
    │   ├── sse-client.ts
    │   └── commands/
    │       ├── migrate.ts
    │       ├── feature.ts
    │       ├── status.ts
    │       ├── jobs.ts
    │       ├── resume.ts
    │       └── logs.ts
    └── src/
        ├── index.ts                     ← Startup: Redis, MCP server, HTTP server
        ├── server.ts                    ← HTTP: /jobs/migrate, /jobs/feature, /webhook, SSE
        ├── mcp-server.ts                ← In-process MCP server (all domain tools)
        ├── mcp-handlers.ts              ← MCP tool implementations
        ├── watcher.ts                   ← File watcher: memory/ + agents/ + .claude/ → self-update PRs
        ├── workflow-parser.ts           ← YAML front matter parser (phases, knowledge, conventions)
        ├── config/settings.ts
        ├── jobs/
        │   ├── types.ts                 ← JobType, Job, FeatureItem, status constants
        │   ├── registry.ts              ← Redis CRUD + PR/Jira/repo mappings
        │   ├── runner.ts                ← Claude Agent SDK query() per phase
        │   └── dispatcher.ts            ← Routes CLI/webhook/Jira triggers to job runners
        ├── clients/
        │   ├── bitbucket.ts             ← BitBucket REST API (two accounts)
        │   ├── git.ts                   ← Git operations via simple-git
        │   ├── loki.ts                  ← Loki HTTP API (graceful degradation)
        │   ├── tempo.ts                 ← Tempo HTTP API (graceful degradation)
        │   └── jira.ts                  ← Jira REST API (graceful degradation)
        ├── prompt/
        │   └── builder.ts              ← Assembles system prompt from MD files per phase
        └── tools/
            ├── types.ts                 ← ToolContext, PhaseSignals
            └── self-improvement.ts      ← propose_change, list_proposals
```
