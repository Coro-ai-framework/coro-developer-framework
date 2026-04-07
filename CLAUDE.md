# A5 Labs — AI Agent Workspace

This repository contains all AI agent definitions, workflows, conventions, knowledge modules, memory, and tooling for A5 Labs engineering automation.

## How this system works

Agents in this repository do not run directly inside Claude Code sessions. They are driven by the **Agent Host Service** — an always-running TypeScript/Node.js service (`tools/`) that:

1. Receives job requests from the `a5` CLI or external event sources (BitBucket webhooks, Jira webhooks)
2. Creates a typed `Job` object with a `workflowPath` pointing to the correct workflow MD file
3. Assembles a system prompt by loading that workflow file, the relevant agent MD file, memory, conventions, and knowledge modules
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
| Agent writes to `memory/`, `agents/`, or `knowledge/` | `self-update` | *(inline, no workflow file)* |

When a Jira ticket triggers a job, the **Spec Writer agent** (`agents/spec-writer.md`) runs first. It reads the ticket — title, description, acceptance criteria, components — and infers the repo, affected projects, PR reviewers, and a structured feature spec. The rest of the pipeline (planner → coder → tester → evaluator → pr-reviewer) is identical to a CLI-triggered feature job.

---

## What lives here

- **agents/** — One MD file per agent. Each defines role, inputs, outputs, and step-by-step procedure. Agents are language-agnostic generic process definitions.
- **workflows/** — Lifecycle definitions, one subdirectory per workflow type. Each `workflow.md` has YAML front matter defining phases, agent assignments, model selection, knowledge modules, and convention routing.
- **knowledge/** — Domain-specific guides for each workflow type. Injected into agent prompts based on workflow YAML metadata. Contains migration-specific and feature-specific expertise.
- **conventions/** — Coding and process rules agents must follow. One file per language (`golang.md`, `dotnet.md`) plus universal process conventions (`git.md`). Loaded dynamically based on `job.params.language`.
- **config/** — `credentials.md` (gitignored, read by Agent Host at startup) and `repos.md` (service registry).
- **memory/** — Accumulated knowledge from past jobs. Read at the start of every phase. Never modified directly — updates go through a self-improvement PR.
- **docs/** — Architecture documentation for engineers and stakeholders.
- **tools/** — The Agent Host Service (TypeScript/Node.js). This is what actually runs the agents.

---

## Language-agnostic architecture

The system is fully language-agnostic. No language-specific defaults are hardcoded in the infrastructure. Language support works through three layers:

1. **Convention files** (`conventions/{language}.md`) — coding standards per language. Adding a new language means writing one convention file.
2. **Workflow YAML** — phases declare `conventions: [auto]` to load the convention file matching `job.params.language`, or `conventions: ["conventions/golang.md"]` for explicit loading.
3. **Planner agent** — detects the target language from the repository (e.g., `go.mod` → `golang`, `*.csproj` → `dotnet`) and calls `set_job_params({ language: "..." })` so all downstream phases load the correct conventions.

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

Agents are workflow-agnostic and language-agnostic. They receive domain-specific expertise through injected knowledge modules and conventions. The same coder agent works for Go migrations, .NET features, and TypeScript projects — the injected context changes, not the agent.

---

## Knowledge modules

Domain-specific guides that supplement the generic agent instructions:

```
knowledge/
  migration/
    analysis-guide.md      — .NET codebase analysis patterns
    planning-guide.md      — Migration planning heuristics
    coding-guide.md        — Contract parity and translation patterns
    testing-guide.md       — Comparison testing methodology
    evaluation-guide.md    — Migration failure taxonomy
    review-guide.md        — Migration PR review checklist
  feature/
    planning-guide.md      — Feature scoping and planning
    testing-guide.md       — Feature testing methodology
```

Knowledge modules are loaded per phase via the `knowledge` field in workflow YAML. They are more stable than memory but less stable than conventions — updated when agents discover systemic gaps via `propose_change(type: "knowledge-update")`.

---

## BitBucket service accounts

Agents interact with BitBucket using two dedicated service accounts. These must exist in your BitBucket workspace with app passwords stored in `config/credentials.md`.

| Account | BB role | Used for |
|---------|---------|---------|
| `@a5-coder-agent` | Developer on all service repos and `a5-ai` | Creating repos, branches, commits, opening PRs, responding to review comments |
| `@a5-reviewer-agent` | Reviewer/Maintainer on all service repos and `a5-ai` | Posting code reviews, approving PRs, triggering merges, monitoring comment threads |

Human developers interact with these accounts exactly as they would with a human colleague — comments appear in PRs, review requests arrive normally.

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

## Agent behavior rules

These rules apply to every agent in every workflow. The Agent Host injects them via this CLAUDE.md into every system prompt.

1. **Read memory before doing anything.** Read `memory/MEMORY.md` and every file it references. Memory contains hard-won knowledge from past runs. Do not repeat known mistakes.

2. **Read conventions before writing code or opening PRs.** Follow the conventions injected into your context. All git operations must follow `conventions/git.md`.

3. **Use the `log` tool constantly.** Developers watch job progress via `a5 logs`. Log every significant action, decision, and result — not just errors. Be specific: `"Extracted 14 endpoints from UserController"` not `"Analyzed code"`.

4. **Never skip a workflow step silently.** If a step cannot be completed, call `escalate` with a precise description of the blocker. Do not invent a workaround that deviates from the workflow.

5. **Never change an API contract without documenting it.** If a service must deviate from the source contract, document the deviation in the PR description with the reason. Never silently omit an endpoint.

6. **Write to memory when you learn something reusable.** A failure pattern, a translation rule, a recurring PR review issue — if it will happen again, propose the change via `propose_change`. The Agent Host will validate it and open a PR on `a5-ai` for human review.

7. **Prefer observed behavior over code analysis.** When a service's behavior is ambiguous, call `loki_query` to check actual production traffic before assuming. Code can lie; logs don't.

8. **Scope is strict.** Only work on the repos, projects, and features specified in the job context. Do not analyze or touch anything outside scope, even if it looks related.

9. **Credentials are never read from files.** They are injected by the Agent Host as environment variables and available in the job context. Never ask for or log credentials.

10. **Use feature tracking tools for multi-feature jobs.** Call `get_features` to check progress, `update_feature` to update status, `set_features` to register the feature list, and `request_new_session` when starting a new feature.

---

## MCP tools available to agents

### Feature tracking
- `set_features` — Register the ordered feature list (called by planner)
- `update_feature` — Update a feature's status or increment its loop count
- `get_features` — Read the current feature list with statuses
- `request_new_session` — Clear session for fresh context (e.g., new feature)
- `set_job_params` — Set dynamic job parameters (e.g., language)

### Job control
- `mark_phase_complete` — Optional early turn end
- `goto_phase` — Override next phase (e.g., loop back to coding)
- `await_event` — Park job waiting for external event
- `escalate` — Escalate to human
- `log` — Append to job log stream

### BitBucket, Observability, Jira, Test harness
See `tools/src/mcp-server.ts` for the full tool inventory.

### Self-improvement
- `propose_change` — Propose changes to agents, conventions, knowledge, or code
- `list_proposals` — Check past proposals before proposing duplicates

---

## Self-improvement rule

When any agent calls `propose_change`, the Agent Host file watcher detects the written files and automatically:

1. Validates the proposal (TypeScript build, YAML parse, workflow config parse)
2. Creates a branch in this repo: `improvement/{short-description}`
3. Commits the changed files
4. Opens a PR tagged with the human developers and `@a5-reviewer-agent`
5. Labels the PR `agent-self-improvement`

If validation fails, a detailed error report is written to `memory/proposals/` so the agent can learn from the failure.

Agents can call `list_proposals` to check past proposals before proposing duplicates, and to learn from rejected proposals.

**Agent knowledge improvements are always reviewed by humans before becoming canonical.** No agent can silently modify how other agents behave. Once the PR merges, the Agent Host pulls the latest `a5-ai` and all subsequent job phases use the updated instructions immediately.

The self-improvement pipeline covers three layers of intelligence:
- **Memory** (`memory/*.md`) — high volatility, grows with every job
- **Knowledge** (`knowledge/**/*.md`) — medium volatility, updated when systemic gaps are found
- **Conventions** (`conventions/*.md`) — low volatility, updated when human feedback reveals standards gaps

---

## Repository structure

```
a5-ai/
├── CLAUDE.md                             ← You are here. Loaded into every agent prompt.
├── .claude/
│   ├── settings.json                     ← Claude Code hook configurations
│   └── skills/                           ← Invocable Claude Code skills
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
├── knowledge/
│   ├── migration/
│   │   ├── analysis-guide.md            ← .NET analysis patterns and extraction rules
│   │   ├── planning-guide.md            ← Migration planning heuristics
│   │   ├── coding-guide.md              ← Contract parity and translation patterns
│   │   ├── testing-guide.md             ← Comparison testing methodology
│   │   ├── evaluation-guide.md          ← Migration failure taxonomy
│   │   └── review-guide.md              ← Migration PR review checklist
│   └── feature/
│       ├── planning-guide.md            ← Feature scoping and planning
│       └── testing-guide.md             ← Feature testing methodology
├── conventions/
│   ├── git.md                           ← Branch naming, commit format, PR structure
│   ├── golang.md                        ← Go coding conventions
│   └── dotnet.md                        ← .NET/C# coding conventions
├── memory/
│   ├── MEMORY.md                        ← Index — loaded into every agent prompt
│   ├── known-pitfalls.md                ← Translation mistakes and failure patterns
│   ├── successful-patterns.md           ← Validated approaches to reuse
│   ├── pr-feedback.md                   ← Recurring developer review feedback
│   └── dotnet-to-go-mappings.md         ← .NET→Go translation patterns (pre-seeded)
├── docs/
│   ├── architecture.md                  ← Full system architecture
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
        ├── watcher.ts                   ← File watcher: memory/ + agents/ + knowledge/ → self-update PRs
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

---

## Company context

- **Company:** A5 Labs
- **Primary stack:** .NET 8 microservices (C#), migrating to Go
- **Source control:** BitBucket (workspace slug in `config/credentials.md`)
- **Observability:** Grafana — Loki (logs) + Tempo (distributed traces)
- **Deployment:** Kubernetes via Helm. Per-service config in `helm-app-config` repo (see `config/repos.md`)
- **Environments:** staging and production. Staging is the benchmark for all migration testing.
- **Issue tracking:** Jira (future integration — Jira-triggered feature jobs)
