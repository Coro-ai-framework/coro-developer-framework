# AI Agent Platform: Architecture Overview

**Audience:** Engineers, Stakeholders, Engineering Managers
**Status:** Implementation in progress
**Last updated:** 2026-04-07

---

## 1. Executive Summary

We are building an internal AI agent platform to automate engineering workflows. Two workflows are currently defined: .NET-to-Go service migration and feature implementation in any language. The platform is designed to grow: new workflows, new languages, and new agents drop in without requiring infrastructure changes.

The platform uses the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) as its reasoning engine, orchestrated by a purpose-built **Agent Host Service** that receives events, manages job state, and drives agents through structured workflows defined as Markdown files.

**Core design principle:** The Markdown files in the `a5-ai` repository are the intelligence. The TypeScript infrastructure is a deliberately thin "dumb tool shell" — it runs phases linearly, provides MCP tools, persists state in Redis, and parks/resumes on webhooks. It has **zero orchestration intelligence**. All workflow logic, decision rules, feature loop management, and accumulated knowledge live in MD files. The LLM reads these files, calls tools to update state, and uses `goto_phase` to control flow. The evaluator decides when to loop. The planner decides how many features. The coder decides when it needs a fresh session.

### Language-agnostic architecture

The system is fully language-agnostic. No language-specific defaults are hardcoded in infrastructure. Language support works through three intelligence layers:

1. **Convention files** (`conventions/{language}.md`) — one file per language
2. **Workflow YAML metadata** — phases declare `conventions: [auto]` to load conventions matching `job.params.language`
3. **Planner agent** — detects the target language from the repository and calls `set_job_params` so all downstream phases load the correct conventions

Adding support for a new language requires writing one convention file and referencing it in the workflow YAML. Zero infrastructure changes.

---

## 2. System Components

### 2.1 Component Map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            TRIGGER SOURCES                                   │
│                                                                              │
│  Developer CLI              BitBucket Webhooks         Jira Webhooks         │
│  a5 migrate ...             pr:created                 issue_assigned        │
│  a5 feature ...             pr:comment_created         issue_updated         │
│                             pr:approved                                      │
│                             pr:fulfilled (merged)                            │
└──────────────┬──────────────────────────┬──────────────────────┬─────────────┘
               │                          │                      │
               ▼                          ▼                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          AGENT HOST SERVICE                                  │
│                          (TypeScript / Node.js)                              │
│                                                                              │
│  ┌─────────────────┐  ┌──────────────────────┐  ┌─────────────────────────┐ │
│  │   HTTP Server   │  │   Webhook Receiver   │  │    File Watcher         │ │
│  │  POST /jobs/*   │  │  HMAC verification   │  │  memory/ + agents/ +   │ │
│  │  GET  /jobs/*   │  │  event routing       │  │  knowledge/ + config/  │ │
│  │  SSE  /stream   │  └──────────┬───────────┘  │  → self-update PRs     │ │
│  └────────┬────────┘             │              └────────────┬────────────┘ │
│           └──────────────────────▼───────────────────────────▼──────────┐   │
│                               Job Dispatcher                              │   │
│                  Routes trigger → JobType → workflowPath                  │   │
│           ┌───────────────────────────────────────────────────────┘   │   │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        Redis Job Registry                            │    │
│  │  job:{id} → Job JSON (metadata + features[])                       │    │
│  │  job:{id}:log → log stream                                          │    │
│  │  pr:{prId}:job → jobId     jira:{ticketId}:job → jobId             │    │
│  └──────────────────────────────────────┬──────────────────────────────┘    │
│                                         │                                   │
│  ┌──────────────────────────────────────▼──────────────────────────────┐    │
│  │                          Job Runners                                 │    │
│  │  One per active job. Claude Agent SDK query() per phase.            │    │
│  │  SDK manages the full tool-use loop internally.                     │    │
│  │  Parks when awaiting external event. Resumes on webhook.            │    │
│  └──────────────────────────────────────┬──────────────────────────────┘    │
│                                         │                                   │
│  ┌──────────────────────────────────────▼──────────────────────────────┐    │
│  │                        Prompt Builder                                │    │
│  │  Assembles system prompt per phase:                                 │    │
│  │  CLAUDE.md + workflow + agent + memory + conventions + knowledge    │    │
│  │  + infrastructure context + job context (JSON)                      │    │
│  │  Conventions: metadata-driven from workflow YAML (never hardcoded) │    │
│  │  Knowledge: domain-specific guides loaded per phase                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────┼────────────────────────────────────┘
                                          │
          ┌───────────────────────────────┼───────────────────────────────┐
          │                               │                               │
          ▼                               ▼                               ▼
┌──────────────────┐       ┌──────────────────────────┐     ┌────────────────────┐
│  CLAUDE AGENT SDK│       │       BITBUCKET           │     │  OBSERVABILITY     │
│                  │       │                           │     │                    │
│  query() → SDK   │       │  Service repos            │     │  Loki (logs)       │
│  manages tool    │       │  a5-ai repo               │     │  Tempo (traces)    │
│  loop, subagents │       │  @a5-coder-agent           │     │  Grafana (UI)      │
│  built-in tools  │       │  @a5-reviewer-agent        │     └────────────────────┘
│                  │       └──────────────────────────┘
│  ┌────────────┐  │
│  │ Built-ins  │  │
│  │ Read Write │  │
│  │ Edit Bash  │  │
│  │ Glob Grep  │  │
│  └────────────┘  │
│  ┌────────────┐  │
│  │ MCP Server │  │
│  │ (in-proc)  │  │
│  │ BB, Loki,  │  │
│  │ Jira, Test │  │
│  │ Job Ctrl,  │  │
│  │ Features,  │  │
│  │ Self-Impr  │  │
│  └────────────┘  │
│  ┌────────────┐  │
│  │ Subagents  │  │
│  │ (per-phase │  │
│  │  from YAML)│  │
│  └────────────┘  │
└──────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SHARED FILE VOLUME                                │
│                                                                             │
│  a5-ai/                        ← Intelligence layer (agents, workflows,    │
│                                   knowledge, conventions, memory)          │
│  working/{job-id}/             ← Per-job intermediate state                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Descriptions

#### Agent Host Service

The central service. Always running. Key responsibilities:

- **HTTP Server:** Accepts job requests from the `a5` CLI (`POST /jobs/migrate`, `POST /jobs/feature`). Streams log output via SSE (`GET /jobs/:id/stream`).
- **Webhook Receiver:** Accepts BitBucket and Jira webhook events. Verifies HMAC signatures. Routes each event to the correct parked job via the Redis registry.
- **Job Dispatcher:** Creates `Job` objects with the correct `type` and `workflowPath`, and starts job runners. Maps trigger sources (CLI, BitBucket, Jira) to job types.
- **Job Runners:** Each active job runs as a series of Claude Agent SDK `query()` calls — one per workflow phase. The SDK manages the entire tool-use loop, subagent spawning, and conversation flow internally. The runner handles linear phase advancement, `goto_phase` overrides, `await_event` parking, and error handling. The runner has **zero orchestration intelligence** — all multi-feature loops, session resets, and completion decisions are made by the LLM via agent instructions.
- **Prompt Builder:** Assembles the system prompt for each phase by loading CLAUDE.md, the workflow file, the agent instructions, memory files, conventions (resolved from workflow YAML metadata), knowledge modules (loaded per-phase), infrastructure context, and the job context JSON. Convention loading is purely metadata-driven — the builder has no knowledge of any programming language.
- **MCP Server:** An in-process MCP server exposes all domain-specific tools (BitBucket, observability, Jira, test harness, feature tracking, job control, self-improvement) to the Agent SDK. The SDK's built-in tools handle filesystem, shell, git, and code search.
- **File Watcher:** Monitors `a5-ai/memory/`, `a5-ai/agents/`, `a5-ai/knowledge/`, `a5-ai/conventions/`, and `a5-ai/tools/src/` on the shared volume. When an agent writes to these directories, the watcher validates changes (TypeScript build, YAML parse, workflow config parse) and opens a PR on the `a5-ai` repo for human review.

#### Intelligence Layer

The intelligence layer is the collection of Markdown files that define how agents think and act. It is organized into five tiers with different volatility and update paths:


| Layer             | Directory      | Volatility   | Updated by                                  |
| ----------------- | -------------- | ------------ | ------------------------------------------- |
| Root instructions | `CLAUDE.md`    | Rarely       | Human developers                            |
| Workflows         | `workflows/`   | Rarely       | Human developers                            |
| Agents            | `agents/`      | Occasionally | Evaluator/PR Reviewer → propose_change → PR |
| Knowledge modules | `knowledge/`   | Occasionally | Agents → propose_change → PR                |
| Conventions       | `conventions/` | Rarely       | Human developers, agents → PR               |
| Memory            | `memory/`      | Frequently   | Agents → direct write → watcher PR          |


All changes to the intelligence layer go through a PR for human review. No agent can silently modify how other agents behave.

#### Claude Agent SDK

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) replaces direct Claude API usage. Key capabilities:


| Feature                               | How it's used                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `query()`                             | Single call per phase — SDK handles the full tool-use loop, retries, and message history             |
| Built-in tools                        | `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep` — no custom filesystem/shell tools needed            |
| `createSdkMcpServer()`                | In-process MCP server for domain tools (BitBucket, Loki, Jira, etc.)                                 |
| `tool()` + Zod                        | Type-safe tool definitions with schema validation                                                    |
| Subagents                             | Workflow YAML defines per-phase subagents (e.g. code-reviewer, test-runner) that can run in parallel |
| `permissionMode: 'bypassPermissions'` | Headless operation for automated workflows                                                           |


#### Redis Job Registry

Redis stores job metadata (not conversation history — the SDK manages that):


| Key                    | Type          | Contains                                                                                               |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `job:{jobId}`          | String (JSON) | Job metadata: status, phase, params, features[], insights[], featureLoopCount, PR mappings, timestamps |
| `job:{jobId}:log`      | List          | Log lines streamed to the CLI                                                                          |
| `pr:{prId}:job`        | String        | Maps BitBucket PR ID → jobId                                                                           |
| `jira:{ticketId}:job`  | String        | Maps Jira ticket ID → jobId                                                                            |
| `repo:{repoSlug}:jobs` | Set           | All job IDs associated with a repo                                                                     |


Jobs survive Agent Host restarts because all state is in Redis and the shared volume.

#### Shared File Volume

Two directories on the shared volume:

- `a5-ai/` — A live checkout of this git repository. The Agent Host pulls latest before each job phase so merged improvements take effect immediately.
- `working/{job-id}/` — Per-job intermediate state: extracted contracts, migration plans, test results, evaluations, error logs. Isolated per job; multiple jobs run concurrently without interference.

#### BitBucket Service Accounts

Two dedicated accounts give agents real BitBucket identities:


| Account              | BitBucket role        | Used for                                                                           |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `@a5-coder-agent`    | Developer             | Creating repos, branches, commits; opening PRs; responding to review comments      |
| `@a5-reviewer-agent` | Reviewer / Maintainer | Posting code reviews; approving PRs; triggering merges; monitoring comment threads |


Human developers see these accounts in PRs and can interact with them normally.

#### CLI (`a5`)

A lightweight Node.js CLI that submits jobs to the Agent Host and streams log output. Developers do not need to keep the terminal open — jobs continue running on the host.

---

## 3. Workflow Types and Extensibility

### 3.1 The extensibility model

Every job carries two fields that determine its behavior:

```typescript
type: JobType        // 'migration' | 'feature' | 'self-update'
workflowPath: string // path to the workflow MD file, e.g. 'workflows/migration/workflow.md'
```

The job runner and prompt builder use these fields — never hardcoded logic — to load the right workflow and agents. Adding a new workflow type requires:

1. A new `workflows/{type}/workflow.md` file with YAML front matter defining phases, agents, models, knowledge modules, conventions, and optional subagents
2. A new entry in the dispatcher's trigger routing table
3. A new CLI command (if CLI-triggered)

No changes to the runner, prompt builder, Redis schema, or MCP server.

### 3.2 Workflow YAML front matter

Workflows are Markdown files with YAML front matter that configures phase sequences, agent assignments, model selection, knowledge module injection, convention routing, and subagent definitions:

```yaml
---
initial_phase: planning
initial_status: queued

phases:
  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
    knowledge: [knowledge/migration/coding-guide.md]
    conventions: [auto]
    subagents:
      - name: code-reviewer
        agent: agents/pr-reviewer.md
        model: coding
        tools: [Read, Glob, Grep, mcp__a5__bb_get_pr_comments]

overrides:
  jira:
    initial_phase: spec-writing
---
```

Key metadata fields on each phase:


| Field         | Purpose                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `knowledge`   | Array of knowledge module paths to inject into the agent's context for this phase |
| `conventions` | Array of convention file paths or `"auto"` to resolve from `job.params.language`  |
| `subagents`   | Array of subagent definitions for parallel work within this phase                 |


The Markdown content below the front matter contains the human-readable workflow documentation, phase descriptions, and orchestration logic (e.g., how the evaluator manages the multi-feature loop).

### 3.3 Convention and knowledge routing

The prompt builder assembles the system prompt for each phase using metadata from the workflow YAML:

1. `**conventions/git.md**` is always loaded (universal process conventions)
2. If the phase declares `conventions: [auto]`, the builder looks up `job.params.language` and loads `conventions/{language}.md`
3. If the phase declares `conventions: ["conventions/dotnet.md"]`, that explicit file is loaded
4. If the phase declares `knowledge: [...]`, those files are loaded as "Domain Knowledge" sections

The builder never hardcodes any language. The `conventions/` directory can hold files for any language. Adding language support is a pure intelligence-layer task.

### 3.4 Trigger → Job routing table


| Trigger source    | Event                                                   | JobType       | workflowPath                      |
| ----------------- | ------------------------------------------------------- | ------------- | --------------------------------- |
| CLI: `a5 migrate` | —                                                       | `migration`   | `workflows/migration/workflow.md` |
| CLI: `a5 feature` | —                                                       | `feature`     | `workflows/feature/workflow.md`   |
| Jira webhook      | `issue_assigned`                                        | `feature`     | `workflows/feature/workflow.md`   |
| File watcher      | `memory/*.md`, `agents/*.md`, `knowledge/*.md` modified | `self-update` | *(inline)*                        |


### 3.5 Agent reuse across workflows

Agents are workflow-agnostic and language-agnostic. They receive domain-specific expertise through injected knowledge modules and conventions. The same coder agent works for Go migrations, .NET features, and TypeScript projects — the injected context changes, not the agent:


| Job phase               | Agent loaded            |
| ----------------------- | ----------------------- |
| `spec-writing`          | `agents/spec-writer.md` |
| `analysis`              | `agents/analyzer.md`    |
| `planning`, `reporting` | `agents/planner.md`     |
| `repo-setup`, `coding`  | `agents/coder.md`       |
| `review`                | `agents/pr-reviewer.md` |
| `testing`               | `agents/tester.md`      |
| `evaluation`            | `agents/evaluator.md`   |


---

## 4. Workflow: .NET to Go Migration

### 4.1 End-to-end flow

```
Developer: a5 migrate --repo my-service --projects MyService.API --reviewers alice,bob
        │
        ▼
Dispatcher creates Job { type: 'migration', workflowPath: 'workflows/migration/workflow.md' }
        │
        ▼
Phase 0: Initialization
  - Read memory/MEMORY.md and all memory files
  - Verify credentials
  - Clone .NET repo to working/{job-id}/source/
  - Create working/{job-id}/ state directory
  - Set job.params.language = "dotnet" (source language for analyzer)

        ▼
Phase 1: Analysis (Analyzer Agent + analysis-guide.md knowledge)
  - Parse C# code: extract all endpoints, DTOs, middleware, auth, EF models
  - Query Loki: real traffic patterns per endpoint (30 days)
  - Query Tempo: downstream dependency traces
  - Output: service-contract.json, dependencies.json, traffic-baseline.json, analysis-notes.md
  - Conventions loaded: dotnet.md (source language), git.md

        ▼
Phase 2: Planning (Planner Agent + planning-guide.md knowledge)
  - Group endpoints into features (domain-based)
  - Order by: dependencies first, then traffic volume, then complexity
  - Annotate with risk level (high/medium/low)
  - Call set_features to register the feature list with the job
  - Call set_job_params({ language: "golang" }) to switch to target language
  - Output: migration-plan.md
  ✋ Optional human checkpoint before proceeding

        ▼
Phase 3: Repository Setup (Coder Agent)
  - Create {service-name}-go repo on BitBucket as @a5-coder-agent
  - Push initial Go project scaffold to main
  - Conventions loaded: golang.md (target language), git.md

        ▼
Phase 4-7: Feature Implementation Loop  ◄──────────────────────┐
  │  Driven by the Evaluator agent, NOT the runner             │
  │                                                             │
  ├── Coding (Coder Agent + coding-guide.md knowledge)         │
  │     - Call get_features → find next pending feature         │
  │     - Call update_feature → mark it in-progress            │
  │     - If new feature: call request_new_session             │
  │     - Create feature branch, implement, open PR            │
  │                                                             │
  ├── Review (PR Reviewer Agent + review-guide.md knowledge)   │
  │     - Post structured review as @a5-reviewer-agent         │
  │     - Coordinate fixes with coder via goto_phase           │
  │     - Wait for human approval → merge PR                   │
  │                                                             │
  ├── Testing (Tester Agent + testing-guide.md knowledge)      │
  │     - Build service, run comparison tests vs staging .NET  │
  │     - Diff: status codes, body, headers                    │
  │     - Output: test-results/{feature}.json                  │
  │                                                             │
  └── Evaluation (Evaluator Agent + evaluation-guide.md)       │
        - Classify failures, write to memory                   │
        - Call update_feature to set status                    │
        - Decision:                                            │
          ├─ Fix needed → incrementLoop, check count ──────────┘
          │   (if loopCount >= 5 → escalate)
          ├─ Feature complete + more pending →
          │   request_new_session + goto_phase("coding") ──────┘
          └─ All complete → auto-advance to reporting

        ▼
Phase 8: Migration Report (Planner Agent)
  - Endpoint map: migrated / with-deviation / escalated
  - Test coverage per endpoint
  - Cutover validation checklist
  - Smoke test suite for post-cutover verification
```

### 4.2 Language handling in migration

Migration workflows involve two languages:

1. **Source language** (e.g., .NET/C#) — used by the analyzer phase. The init phase sets `job.params.language` to the source language so the analyzer gets the right conventions.
2. **Target language** (e.g., Go) — used by coding, review, testing, and evaluation phases. The planner updates `job.params.language` to the target language via `set_job_params` after producing the plan.

The knowledge modules in `knowledge/migration/` provide the cross-language translation guidance.

### 4.3 Job parking and resumption

Jobs are event-driven. When a job needs to wait for something external, it parks itself in Redis rather than polling:

```
Coder opens PR #42 → calls mcp__a5__await_event('pr:fulfilled', 42)
  → job.status = 'awaiting-pr-merge', job.awaitingPrId = 42
  → Redis: SET pr:42:job → {jobId}
  → Runner exits (zero CPU usage while waiting)

PR #42 merged by developer
  → BitBucket fires pr:fulfilled webhook to Agent Host
  → Agent Host: GET pr:42:job → {jobId}
  → Load job from Redis, resume runner for the next phase
  → Agent SDK query() continues with fresh context
```

This same pattern handles PR comment events, approval events, and Jira ticket updates.

### 4.4 Feature tracking

Feature progress is tracked as structured state on the Job object in Redis:

```typescript
interface FeatureItem {
  name: string
  status: 'pending' | 'in-progress' | 'complete' | 'escalated'
  loopCount: number
}

// On the Job object:
features: FeatureItem[]     // populated by planner via set_features
featureLoopCount: number    // current feature's loop count
currentFeature: string      // name of the in-progress feature
```

Agents manage this state via MCP tools (`set_features`, `update_feature`, `get_features`). The runner never reads or acts on these fields — they are purely for agent use and context visibility.

---

## 5. Workflow: Feature Implementation

```
Trigger: a5 feature ... OR Jira ticket assigned to @a5-feature-agent
        │
        ▼
[Jira path only] Phase 0: Spec Writing (Spec Writer Agent)
  - Read Jira ticket: title, description, acceptance criteria, components
  - Infer: repo, affected files/services, PR reviewers, test plan
  - Output: working/{job-id}/feature-spec.md
  - Post comment on Jira ticket confirming ticket was received

        ▼
Phase 1: Planning (Planner Agent + feature planning-guide.md)
  - Read feature-spec.md (or CLI description)
  - Detect target language from repo (go.mod → golang, *.csproj → dotnet, etc.)
  - Call set_job_params({ language: "<detected>" })
  - Call set_features to register feature list
  - Produce implementation plan

        ▼
Phase 2+: Code → Review → Test → Evaluate
  - Same agents as migration, with conventions loaded from job.params.language
  - Feature-specific knowledge modules (knowledge/feature/*.md) injected
  - Same evaluator-driven loop for multi-feature jobs
  - On complete: transition Jira ticket to Done (via mcp__a5__jira_transition_issue)
```

The feature workflow is completely language-neutral. A .NET feature job gets `conventions/dotnet.md` injected. A Go feature gets `conventions/golang.md`. A TypeScript feature gets `conventions/typescript.md`. The planner detects the language and all downstream phases load the correct conventions automatically.

---

## 6. Self-Improvement Loop

The system has three layers of accumulated intelligence, each with a different volatility and update path:


| Layer       | Location            | Volatility                         | Example                                      |
| ----------- | ------------------- | ---------------------------------- | -------------------------------------------- |
| Memory      | `memory/*.md`       | High — grows with every job        | New pitfall discovered during migration      |
| Knowledge   | `knowledge/**/*.md` | Medium — updated for systemic gaps | Missing translation pattern in coding guide  |
| Conventions | `conventions/*.md`  | Low — updated for standards gaps   | Human feedback reveals a missing naming rule |


All three layers are watched by the file watcher. All changes go through a PR for human review.

### 6.1 Centralized insights model

Self-improvement uses a **centralized insights model**. Rather than having every agent call `propose_change` directly, agents record observations as lightweight **insights** on the job. The evaluator — which runs last and has full context — reviews all insights and decides which ones warrant a self-improvement proposal.

This design avoids duplicate proposals, eliminates noise from agents that lack perspective on whether a finding is systemic, and lets the evaluator synthesize observations from multiple phases (e.g., "the planner struggled with auth, and the coder hit the same issue").

```
Phase 1: Planning
  Planner discovers x-token-auth returns 401, finds Basic auth workaround
  → Calls mcp__a5__add_insight({ category: "auth", summary: "...", detail: "..." })
  → Insight stored on Job.insights[] in Redis

Phase 2: Coding
  Coder hits the same auth issue cloning the repo
  → Calls mcp__a5__add_insight with similar details

Phase 3-4: Review, Testing
  (agents may record their own insights — build quirks, flaky tests, etc.)

Phase 5: Evaluation
  Evaluator receives all insights in system prompt (auto-injected by prompt builder)
  → Reviews each insight, checks mcp__a5__list_proposals for duplicates
  → Calls mcp__a5__propose_change to create a memory-update PR
  → Also acts on its own test-result analysis as before
```

### 6.2 Insight tracking

Insights are stored as structured data on the Job object in Redis:

```typescript
interface Insight {
  phase: string       // auto-populated from the current job phase
  category: string    // "auth", "tooling", "convention-gap", "api-quirk", etc.
  summary: string     // one-line description
  detail: string      // full context: what was tried, what worked, why
  suggestion?: string // optional: what should be updated
}

// On the Job object:
insights: Insight[]   // accumulated across all phases
```

The prompt builder includes `job.insights` in the "Insights from Upstream Agents" section of the job context when the array is non-empty. This ensures the evaluator sees every insight without needing an explicit tool call.

### 6.3 Who proposes what


| Agent       | Records insights via `add_insight`                       | Calls `propose_change` directly                |
| ----------- | -------------------------------------------------------- | ---------------------------------------------- |
| Planner     | Yes — auth workarounds, repo quirks, environment issues  | No                                             |
| Coder       | Yes — build quirks, dependency issues, workarounds       | No                                             |
| Tester      | Yes — flaky tests, pre-existing errors, environment gaps | No                                             |
| PR Reviewer | Yes — single-job observations                            | Yes — systemic patterns seen across 2+ PRs     |
| Evaluator   | No (runs last)                                           | Yes — acts on upstream insights + own analysis |


### 6.4 Proposal pipeline

```
Evaluator calls mcp__a5__propose_change
  → Writes proposal summary + target files to disk

File Watcher (Agent Host) detects changes
  → Validates: TypeScript build, YAML parse, workflow config parse
  → On success:
      → Creates branch: improvement/{timestamp}-{slug}
      → Commits changed files
      → Opens PR on a5-ai as @a5-coder-agent
      → Tags human developers + @a5-reviewer-agent
  → On failure:
      → Writes validation failure report to memory/proposals/

Agents can call mcp__a5__list_proposals to:
  → Avoid re-proposing something that was already filed
  → Learn from rejected proposals (build failures)
  → Check what improvements are pending review

Human developers review the PR
  → Can accept, modify, or reject
  → Modify: the agent learns from the correction on the next run

On merge:
  → Agent Host pulls latest a5-ai
  → All subsequent job phases load the updated instructions
  → The mistake will not be repeated
```

**Every improvement has a PR trail. Humans are always in control.**

---

## 7. Multiple Concurrent Jobs

Multiple developers can run workflows simultaneously. Jobs are fully isolated:

```
Developer 1: a5 migrate --repo user-service        Developer 2: a5 feature --repo payments-api
                    │                                                   │
                    ▼                                                   ▼
      working/user-svc-migration-1234/              working/payments-feature-5678/
      Job Runner A (SDK query() per phase)          Job Runner B (SDK query() per phase)
      language: golang (target)                     language: typescript (detected)
      conventions/golang.md loaded                  conventions/typescript.md loaded
      knowledge/migration/*.md injected             knowledge/feature/*.md injected
```

The same BitBucket service accounts handle all jobs simultaneously — `@a5-coder-agent` can have open PRs across multiple repos. The Redis registry ensures each webhook event routes to the correct job via `pr:{prId}:job`.

---

## 8. Data Flow and Persistence

### What lives where


| Data                               | Location                             | Updated by                                                              |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Root instructions                  | `a5-ai/CLAUDE.md` (git)              | Human developers                                                        |
| Agent instructions                 | `a5-ai/agents/` (git)                | Agents → propose_change → PR → merge                                    |
| Workflow definitions               | `a5-ai/workflows/` (git)             | Human developers                                                        |
| Knowledge modules                  | `a5-ai/knowledge/` (git)             | Agents → propose_change → PR → merge                                    |
| Conventions                        | `a5-ai/conventions/` (git)           | Human developers, agents → PR                                           |
| Accumulated memory                 | `a5-ai/memory/` (git)                | Evaluator (informed by job insights) / PR Reviewer → watcher PR → merge |
| Per-job intermediate state         | `working/{job-id}/` (shared volume)  | Job runners                                                             |
| Job metadata + features + insights | Redis `job:{jobId}`                  | Job runners, MCP tools                                                  |
| PR → job mapping                   | Redis `pr:{prId}:job`                | Dispatcher on PR open                                                   |
| Jira → job mapping                 | Redis `jira:{ticketId}:job`          | Dispatcher on Jira trigger                                              |
| Generated code                     | Service repos on BitBucket           | Coder agent                                                             |
| Credentials                        | `config/credentials.md` (gitignored) | Developer (manual)                                                      |


### Per-job working directory

```
working/{job-id}/
├── job.md                           ← Job parameters, type, status, start time
├── source/                          ← Cloned source repo
├── service-contract.json            ← Extracted endpoint contracts (migration)
├── dependencies.json                ← External dependencies (migration)
├── traffic-baseline.json            ← Loki traffic patterns (migration)
├── analysis-notes.md                ← Analyzer ambiguity flags
├── feature-spec.md                  ← Jira-derived feature specification (feature jobs)
├── migration-plan.md                ← Ordered feature list (migration)
├── implementation-plan.md           ← Feature implementation plan (feature jobs)
├── test-results/
│   └── {feature}.json               ← Tester output per feature
├── evaluations/
│   └── {feature}.md                 ← Evaluator diagnosis and fix brief
├── migration-report.md              ← Final output (migration)
└── errors.md                        ← Escalated blockers requiring human input
```

---

## 9. Tool System

### 9.1 Built-in tools (Claude Agent SDK)

The Agent SDK provides these tools out of the box — no custom implementation needed:


| Tool    | Purpose                                |
| ------- | -------------------------------------- |
| `Read`  | Read file contents                     |
| `Write` | Write/create files                     |
| `Edit`  | Make targeted edits to existing files  |
| `Bash`  | Execute shell commands (including git) |
| `Glob`  | Find files by pattern                  |
| `Grep`  | Search file contents                   |
| `Agent` | Spawn subagents for parallel work      |


### 9.2 Domain tools (MCP Server)

Domain-specific tools are exposed via an in-process MCP server (`mcp-server.ts`). All tool schemas are defined using `tool()` + Zod for type-safe validation:


| Category             | Tools                                                                                             | Count  |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| BitBucket (coder)    | `bb_create_repo`, `bb_create_pr`, `bb_get_pr_status`                                              | 3      |
| BitBucket (reviewer) | `bb_get_pr_comments`, `bb_post_pr_comment`, `bb_reply_to_comment`, `bb_approve_pr`, `bb_merge_pr` | 5      |
| Observability        | `loki_query`, `tempo_get_trace`, `tempo_search`                                                   | 3      |
| Jira                 | `jira_get_issue`, `jira_post_comment`, `jira_transition_issue`                                    | 3      |
| Test harness         | `run_go_build`, `start_go_service`, `stop_go_service`, `compare_request`                          | 4      |
| Feature tracking     | `set_features`, `update_feature`, `get_features`, `request_new_session`, `set_job_params`         | 5      |
| Job control          | `mark_phase_complete`, `goto_phase`, `await_event`, `escalate`, `log`                             | 5      |
| Self-improvement     | `add_insight`, `propose_change`, `list_proposals`                                                 | 3      |
| **Total domain**     |                                                                                                   | **31** |


#### Feature tracking tools

These tools enable LLM-driven multi-feature orchestration without any logic in the runner:


| Tool                  | Purpose                                                           | Called by         |
| --------------------- | ----------------------------------------------------------------- | ----------------- |
| `set_features`        | Register the ordered feature list for the job                     | Planner           |
| `update_feature`      | Update a feature's status or increment its loop count             | Evaluator, Coder  |
| `get_features`        | Read the current feature list with statuses and loop counts       | All agents        |
| `request_new_session` | Clear session ID for fresh context (e.g., starting a new feature) | Evaluator, Coder  |
| `set_job_params`      | Merge key-value pairs into job.params (e.g., set language)        | Planner, Analyzer |


### 9.3 Subagents

Subagents are defined per-phase in the workflow YAML front matter. The runner converts them to Agent SDK `AgentDefinition` objects and passes them to `query()`. The main agent can spawn them via the built-in `Agent` tool:

```yaml
subagents:
  - name: code-reviewer
    agent: agents/pr-reviewer.md
    model: coding
    tools: [Read, Glob, Grep, mcp__a5__bb_get_pr_comments]
```

Each subagent gets its own Claude session with access to the MCP server and any specified built-in tools.

---

## 10. Knowledge Architecture

### 10.1 Knowledge modules

Knowledge modules live in `knowledge/` and contain domain-specific expertise for each workflow type. They are injected into agent prompts based on the `knowledge` field in workflow YAML:

```
knowledge/
  migration/
    analysis-guide.md      ← .NET codebase analysis patterns
    planning-guide.md      ← Migration planning heuristics
    coding-guide.md        ← Contract parity and translation patterns
    testing-guide.md       ← Comparison testing methodology
    evaluation-guide.md    ← Migration failure taxonomy
    review-guide.md        ← Migration PR review checklist
  feature/
    planning-guide.md      ← Feature scoping and planning
    testing-guide.md       ← Feature testing methodology
```

### 10.2 Separation of concerns

The intelligence layer separates **procedure** from **domain expertise**:

- **Agent files** define procedure: what to do, in what order, which tools to call. They are generic and language-agnostic.
- **Knowledge modules** define domain expertise: how to do it for a specific technology or workflow. They are loaded per-phase based on workflow YAML metadata.
- **Convention files** define coding standards: how to write correct code in a specific language. They are loaded via the `auto` mechanism based on `job.params.language`.

This separation means:

- The same coder agent handles Go migrations and .NET features — different knowledge/conventions are injected
- Adding a new workflow type (e.g., security audit) means creating new knowledge modules and a workflow file, not new agents
- Adding a new language means creating one convention file — no infrastructure changes

---

## 11. Deployment

### 11.1 Local development (Docker Compose + ngrok)

```
docker-compose up
  ├── agent-host  (Node.js)    → localhost:3000
  ├── redis       (Redis 7)    → localhost:6379
  └── ngrok                    → public HTTPS URL → localhost:3000

BitBucket webhook URL = {ngrok public URL}/webhook
```

The shared volume mounts to `tools/data/` locally so developers can inspect job state with standard file tools. See [local-setup.md](local-setup.md) for the complete setup guide.

### 11.2 Production (Kubernetes)

```
Kubernetes cluster
├── Deployment:   agent-host (1+ replicas)
├── Ingress:      stable HTTPS URL for BitBucket/Jira webhooks
├── PVC:          shared volume (working/ + a5-ai checkout)
├── Redis:        managed (Redis Cloud) or in-cluster
└── Secret:       all credentials (BitBucket, Claude API, Loki, Tempo, Jira)
```

Moving from local to production requires only updating the webhook URL in BitBucket/Jira settings and providing credentials via K8s Secrets. No code changes.

### 11.3 Configuration

All configuration lives in `tools/config/settings.json` with environment variable overrides. The `jira` block is optional — the system starts and runs without it, with Jira tools returning `{ available: false }`.

---

## 12. Security

- **Credentials** are never committed to git. Injected as environment variables (locally via `.env`, in K8s via Secrets).
- **Webhook payloads** are verified using HMAC-SHA256 before processing. The raw request body is used for verification — the server does not pre-parse webhook JSON.
- **Service account permissions** are minimum required: Developer on target repos, Reviewer on `a5-ai`.
- **File system access** — The Agent SDK operates within the job's working directory (`cwd`). Domain tools are scoped via MCP server context.
- **Claude API calls** never include credentials. Credentials are used only by the MCP tool implementations, not passed to the LLM.
- **Self-improvement changes** require human PR approval before taking effect. Agents cannot silently modify their own instructions. The watcher validates all proposals before opening PRs.

---

## 13. Glossary


| Term             | Definition                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent            | A Claude Agent SDK `query()` session given a specific role via an MD file, with access to built-in tools and the MCP server                                                              |
| Convention       | A coding standards file for a specific language (`conventions/{lang}.md`), loaded dynamically based on `job.params.language`                                                             |
| Feature          | A logical group of endpoints or changes handled as one branch + PR, tracked via `FeatureItem` in the job state                                                                           |
| FeatureItem      | A structured record tracking a feature's name, status (pending/in-progress/complete/escalated), and loop count                                                                           |
| Insight          | A structured learning or workaround recorded by any agent via `add_insight`, stored on `Job.insights[]`, and reviewed by the evaluator at the end of the workflow                        |
| Job              | A unit of work with a `type`, `workflowPath`, features list, insights list, and state persisted in Redis and the shared volume                                                           |
| JobType          | `migration`, `feature`, or `self-update` — determines which workflow and phases apply                                                                                                    |
| Job Runner       | The TypeScript code that drives Claude Agent SDK sessions for one job across its phases. Has zero orchestration intelligence.                                                            |
| Knowledge module | A domain-specific guide in `knowledge/` that supplements agent instructions with workflow-specific expertise, loaded per-phase                                                           |
| Memory           | MD files in `a5-ai/memory/` containing accumulated knowledge from past jobs, updated via PRs                                                                                             |
| MCP Server       | In-process Model Context Protocol server exposing domain tools to the Agent SDK                                                                                                          |
| Park             | When a job pauses to wait for an external event (PR merge, comment, approval) without consuming CPU                                                                                      |
| Phase            | A discrete stage within a workflow, each mapped to a specific agent MD file and run as one `query()` call                                                                                |
| Prompt Builder   | Assembles the system prompt per phase from CLAUDE.md, workflow, agent, memory, conventions, knowledge, and job context                                                                   |
| Resume           | When an incoming webhook event restores a parked job and continues its runner loop                                                                                                       |
| Self-improvement | The centralized learning loop: agents record insights via `add_insight`, the evaluator reviews them and calls `propose_change`, triggering validation and a PR on a5-ai for human review |
| Service account  | A BitBucket user account operated by the system (`@a5-coder-agent`, `@a5-reviewer-agent`)                                                                                                |
| Spec Writer      | Agent that translates a Jira ticket into a structured feature spec for the planner                                                                                                       |
| Subagent         | A child agent spawnable within a phase for parallel work (e.g. code-reviewer, test-runner)                                                                                               |
| Workflow         | An MD file with YAML front matter defining ordered phases, agent assignments, model selection, knowledge/convention routing, and subagent definitions                                    |
| workflowPath     | The relative path to the workflow MD file for a job, e.g. `workflows/migration/workflow.md`                                                                                              |


