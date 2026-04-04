# A5 Labs — AI Agent Platform: Architecture Overview

**Audience:** Engineers, Stakeholders, Engineering Managers
**Status:** Implementation in progress
**Last updated:** 2026-04-02

---

## 1. Executive Summary

A5 Labs is building an internal AI agent platform to automate engineering workflows. The first workflow is the migration of .NET 8 microservices to Go. The platform is designed to grow: a feature implementation workflow (CLI or Jira-triggered) is the next planned addition, followed by further automation without requiring infrastructure changes.

The platform uses Anthropic's Claude as its reasoning engine, orchestrated by a purpose-built **Agent Host Service** that receives events, manages job state, and drives agents through structured workflows defined as Markdown files.

**Core design principle:** The Markdown files in the `a5-ai` repository are the intelligence. The TypeScript infrastructure is deliberately thin — it runs agents, routes events, and executes tool calls. All workflow logic, decision rules, and accumulated knowledge live in MD files that humans can read, review, and improve via normal pull requests.

---

## 2. System Components

### 2.1 Component Map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            TRIGGER SOURCES                                   │
│                                                                              │
│  Developer CLI              BitBucket Webhooks         Jira Webhooks (future)│
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
│  │  POST /jobs/*   │  │  HMAC verification   │  │  memory/ + agents/      │ │
│  │  GET  /jobs/*   │  │  event routing       │  │  → self-update PRs      │ │
│  │  SSE  /stream   │  └──────────┬───────────┘  └────────────┬────────────┘ │
│  └────────┬────────┘             │                           │              │
│           └──────────────────────▼───────────────────────────▼──────────┐   │
│                               Job Dispatcher                              │   │
│                  Routes trigger → JobType → workflowPath                  │   │
│           ┌───────────────────────────────────────────────────────┘   │   │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        Redis Job Registry                            │    │
│  │  job:{id} → full Job JSON      pr:{prId}:job → jobId               │    │
│  │  job:{id}:log → log stream     jira:{ticketId}:job → jobId         │    │
│  └──────────────────────────────────────┬──────────────────────────────┘    │
│                                         │                                   │
│  ┌──────────────────────────────────────▼──────────────────────────────┐    │
│  │                          Job Runners                                 │    │
│  │  One per active job. Stateful Claude API session loop.              │    │
│  │  Parks when awaiting external event. Resumes on webhook.            │    │
│  └──────────────────────────────────────┬──────────────────────────────┘    │
└─────────────────────────────────────────┼────────────────────────────────────┘
                                          │
          ┌───────────────────────────────┼───────────────────────────────┐
          │                               │                               │
          ▼                               ▼                               ▼
┌──────────────────┐       ┌──────────────────────────┐     ┌────────────────────┐
│   CLAUDE API     │       │       BITBUCKET           │     │  OBSERVABILITY     │
│                  │       │                           │     │                    │
│ claude-opus-4-6  │       │  Service repos            │     │  Loki (logs)       │
│ (planning, eval) │       │  a5-ai repo               │     │  Tempo (traces)    │
│                  │       │  @a5-coder-agent           │     │  Grafana (UI)      │
│ claude-sonnet-4-6│       │  @a5-reviewer-agent        │     └────────────────────┘
│ (coding, review) │       └──────────────────────────┘
└──────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SHARED FILE VOLUME                                │
│                                                                             │
│  a5-ai/                        ← Agent instructions, workflows, memory     │
│  working/{job-id}/             ← Per-job intermediate state                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Descriptions

#### Agent Host Service

The central orchestration service. Always running. Key responsibilities:

- **HTTP Server:** Accepts job requests from the `a5` CLI (`POST /jobs/migrate`, `POST /jobs/feature`). Streams log output via SSE (`GET /jobs/:id/stream`).
- **Webhook Receiver:** Accepts BitBucket and Jira webhook events. Verifies HMAC signatures. Routes each event to the correct parked job via the Redis registry.
- **Job Dispatcher:** Creates `Job` objects with the correct `type` and `workflowPath`, and starts job runners. Maps trigger sources (CLI, BitBucket, Jira) to job types.
- **Job Runners:** Each active job runs as a stateful Claude API session loop. The runner pulls the latest `a5-ai` MD files, assembles a system prompt for the current phase, calls Claude, executes tool calls, persists state to Redis, and either advances to the next phase or parks to wait for an external event.
- **File Watcher:** Monitors `a5-ai/memory/` and `a5-ai/agents/` on the shared volume. When an agent writes to either directory, the watcher automatically creates a branch, commits the changes, and opens a PR on the `a5-ai` repo for human review.

#### Redis Job Registry

Redis is the durable backbone of the system. Key schema:

| Key | Type | Contains |
|-----|------|---------|
| `job:{jobId}` | String (JSON) | Full `Job` object including conversation history |
| `job:{jobId}:log` | List | Log lines streamed to the CLI |
| `pr:{prId}:job` | String | Maps BitBucket PR ID → jobId |
| `jira:{ticketId}:job` | String | Maps Jira ticket ID → jobId |
| `repo:{repoSlug}:jobs` | Set | All job IDs associated with a repo |

Jobs survive Agent Host restarts because all state is in Redis and the shared volume.

#### Shared File Volume

Two directories on the shared volume:

- `a5-ai/` — A live checkout of this git repository. The Agent Host pulls latest before each job phase so merged improvements take effect immediately.
- `working/{job-id}/` — Per-job intermediate state: extracted contracts, migration plans, test results, evaluations, error logs. Isolated per job; multiple jobs run concurrently without interference.

#### BitBucket Service Accounts

Two dedicated accounts give agents real BitBucket identities:

| Account | BitBucket role | Used for |
|---------|---------------|---------|
| `@a5-coder-agent` | Developer | Creating repos, branches, commits; opening PRs; responding to review comments |
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

1. A new `workflows/{type}/workflow.md` file
2. A new entry in the dispatcher's trigger routing table
3. A new CLI command (if CLI-triggered)

No changes to the runner, prompt builder, Redis schema, or tool implementations.

### 3.2 Trigger → Job routing table

| Trigger source | Event | JobType | workflowPath |
|---------------|-------|---------|-------------|
| CLI: `a5 migrate` | — | `migration` | `workflows/migration/workflow.md` |
| CLI: `a5 feature` | — | `feature` | `workflows/feature/workflow.md` |
| Jira webhook | `issue_assigned` | `feature` | `workflows/feature/workflow.md` |
| File watcher | `memory/*.md` or `agents/*.md` modified | `self-update` | *(inline)* |

### 3.3 Agent reuse across workflows

Agents are workflow-agnostic. The same coder, tester, pr-reviewer, and evaluator run identically regardless of workflow type. The prompt builder selects which agent MD to load based on the current job phase:

| Job phase | Agent loaded |
|-----------|-------------|
| `spec-writing` | `agents/spec-writer.md` |
| `analysis` | `agents/analyzer.md` |
| `planning` | `agents/planner.md` |
| `repo-setup`, `coding` | `agents/coder.md` |
| `review` | `agents/pr-reviewer.md` |
| `testing` | `agents/tester.md` |
| `evaluation` | `agents/evaluator.md` |

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

        ▼
Phase 1: Analysis (Analyzer Agent)
  - Parse C# code: extract all endpoints, DTOs, middleware, auth, EF models
  - Query Loki: real traffic patterns per endpoint (30 days)
  - Query Tempo: downstream dependency traces
  - Output: service-contract.json, dependencies.json, traffic-baseline.json, analysis-notes.md

        ▼
Phase 2: Planning (Planner Agent)
  - Group endpoints into features (domain-based)
  - Order by: dependencies first, then traffic volume, then complexity
  - Annotate with risk level (high/medium/low)
  - Output: migration-plan.md
  ✋ Optional human checkpoint before proceeding

        ▼
Phase 3: Repository Setup
  - Create {service-name}-go repo on BitBucket as @a5-coder-agent
  - Push initial Go project scaffold to main (chi router, zerolog, envconfig, health endpoint)

        ▼
Phase 4: Feature Loop  ◄─────────────────────────────────┐
  │                                                       │
  ├── 4a. Code (Coder Agent)                             │
  │     - Read memory/known-pitfalls.md                  │
  │     - Create feature branch                          │
  │     - Implement endpoints matching contract exactly  │
  │     - Write table-driven tests                       │
  │     - Open PR as @a5-coder-agent                     │
  │     - Park: await pr:created webhook                 │
  │                                                       │
  ├── 4b. Review (PR Reviewer Agent)                     │
  │     - Resumed by pr:created webhook                  │
  │     - Post structured review as @a5-reviewer-agent   │
  │     - Park: await pr:comment events                  │
  │     - On developer comment → relay to Coder          │
  │     - On human approval + Coder fixes → merge PR     │
  │     - Park: await pr:fulfilled webhook               │
  │                                                       │
  ├── 4c. Test (Tester Agent)                            │
  │     - Resumed by pr:fulfilled webhook                │
  │     - Build Go service, load staging helm config     │
  │     - Replay requests against Go + .NET staging      │
  │     - Diff: status codes, body, headers              │
  │     - Query Loki for errors during test run          │
  │     - Output: test-results/{feature}.json            │
  │                                                       │
  ├── 4d. Evaluate (Evaluator Agent)                     │
  │     - Classify failures: contract-violation /        │
  │       behavior-drift / performance / skipped         │
  │     - Write new knowledge to memory/                 │
  │     - Edit agents/*.md if process gap found          │
  │     - Decision:                                      │
  │       ├─ Failures → loop back to 4a (max 5x) ───────┘
  │       └─ Complete → mark feature done
  │
  └── (advance to next feature)

        ▼
Phase 5: Migration Report
  - Endpoint map: migrated / with-deviation / escalated
  - Test coverage per endpoint
  - Cutover validation checklist
  - Smoke test suite for post-cutover verification
```

### 4.2 Job parking and resumption

Jobs are event-driven. When a job needs to wait for something external, it parks itself in Redis rather than polling:

```
Coder opens PR #42 → calls await_event('pr:fulfilled', 42)
  → job.status = 'awaiting-pr-merge', job.awaitingPrId = 42
  → Redis: SET pr:42:job → {jobId}
  → Runner exits (zero CPU usage while waiting)

PR #42 merged by developer
  → BitBucket fires pr:fulfilled webhook to Agent Host
  → Agent Host: GET pr:42:job → {jobId}
  → Load job from Redis, append webhook payload as user message
  → Restart runner from last state
```

This same pattern handles PR comment events, approval events, and (in future) Jira ticket updates.

---

## 5. Workflow: Feature Implementation (Future)

When `workflows/feature/workflow.md` is created, feature jobs become available. The phases are similar to migration but scoped differently:

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
Phase 1: Planning (Planner Agent)
  - Read feature-spec.md (or CLI description)
  - Understand existing Go codebase
  - Produce implementation plan with feature branches

        ▼
Phase 2+: Code → Review → Test → Evaluate (same as migration)
  - Same agents, same self-improvement loop
  - On complete: transition Jira ticket to Done (via jira_transition_issue tool)
```

The only new component is `agents/spec-writer.md`. All other agents reuse their existing MD files unchanged.

---

## 6. Self-Improvement Loop

When an agent writes to `memory/` or edits `agents/*.md`, the platform learns from the experience:

```
Evaluator: found a new .NET→Go serialization pitfall
  → Writes to memory/known-pitfalls.md via write_file tool
  → Edits agents/coder.md to add a rule: "never use X, use Y instead"

File Watcher (Agent Host) detects changes
  → Creates branch: improvement/timespan-serialization-pitfall
  → Commits changed files
  → Opens PR on a5-ai as @a5-coder-agent:
      Title: "[Self-improvement] Add TimeSpan serialization pitfall"
      Body: "Discovered during my-service migration (job-id: xxx).
             Go was serializing TimeSpan as HH:mm:ss, .NET expects ISO 8601.
             Added rule to coder.md and entry to known-pitfalls.md."
  → Tags human developers + @a5-reviewer-agent
  → Labels: agent-self-improvement

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
Developer 1: a5 migrate --repo user-service        Developer 2: a5 migrate --repo payment-service
                    │                                                   │
                    ▼                                                   ▼
      working/user-svc-migration-1234/              working/payment-svc-migration-5678/
      Job Runner A (Claude session)                 Job Runner B (Claude session)
      @a5-coder-agent → PR in user-service-go      @a5-coder-agent → PR in payment-service-go
```

The same BitBucket service accounts handle all jobs simultaneously — `@a5-coder-agent` can have open PRs across multiple repos. The Redis registry ensures each webhook event routes to the correct job via `pr:{prId}:job`.

---

## 8. Data Flow and Persistence

### What lives where

| Data | Location | Updated by |
|------|----------|-----------|
| Agent instructions | `a5-ai/agents/` (git) | Evaluator / PR Reviewer → PR → merge |
| Workflow definitions | `a5-ai/workflows/` (git) | Human developers |
| Accumulated knowledge | `a5-ai/memory/` (git) | Evaluator / PR Reviewer → PR → merge |
| Conventions | `a5-ai/conventions/` (git) | Human developers |
| Per-job intermediate state | `working/{job-id}/` (shared volume) | Job runners |
| Job status and conversation | Redis `job:{jobId}` | Job runners |
| PR → job mapping | Redis `pr:{prId}:job` | Dispatcher on PR open |
| Jira → job mapping | Redis `jira:{ticketId}:job` | Dispatcher on Jira trigger |
| Generated Go code | `{service-name}-go` BitBucket repo | Coder agent |
| Credentials | `config/credentials.md` (gitignored) | Developer (manual) |

### Per-job working directory

```
working/{job-id}/
├── job.md                           ← Job parameters, type, status, start time
├── source/                          ← Cloned .NET repo (migration) or Go repo (feature)
├── service-contract.json            ← Extracted endpoint contracts (migration)
├── dependencies.json                ← External dependencies (migration)
├── traffic-baseline.json            ← Loki traffic patterns (migration)
├── analysis-notes.md                ← Analyzer ambiguity flags
├── feature-spec.md                  ← Jira-derived feature specification (feature jobs)
├── migration-plan.md                ← Ordered feature list with statuses
├── test-results/
│   └── {feature}.json               ← Tester output per feature
├── evaluations/
│   └── {feature}.md                 ← Evaluator diagnosis and fix brief
├── migration-report.md              ← Final output
└── errors.md                        ← Escalated blockers requiring human input
```

---

## 9. Tool System

Agents can call 32 tools. The Agent Host executes each tool call and returns the result to Claude:

| Category | Tools | Count |
|----------|-------|-------|
| File system | `read_file`, `write_file`, `list_directory`, `create_directory` | 4 |
| Git | `git_clone`, `git_checkout_branch`, `git_commit`, `git_push`, `git_pull`, `git_get_diff` | 6 |
| BitBucket (coder account) | `bb_create_repo`, `bb_create_pr`, `bb_push_commit` | 3 |
| BitBucket (reviewer account) | `bb_get_pr_comments`, `bb_post_pr_comment`, `bb_reply_to_comment`, `bb_approve_pr`, `bb_merge_pr` | 5 |
| Observability | `loki_query`, `tempo_get_trace`, `tempo_search` | 3 |
| Jira *(stubbed)* | `jira_get_issue`, `jira_post_comment`, `jira_transition_issue` | 3 |
| Test harness | `run_go_build`, `start_go_service`, `stop_go_service`, `compare_request` | 4 |
| Job control | `mark_phase_complete`, `await_event`, `escalate`, `log` | 4 |
| **Total** | | **32** |

All file system tools enforce path boundaries — reads and writes are scoped to the shared volume. Loki, Tempo, and Jira tools degrade gracefully if their credentials are not configured.

---

## 10. Deployment

### 10.1 Local development (Docker Compose + ngrok)

```
docker-compose up
  ├── agent-host  (Node.js)    → localhost:3000
  ├── redis       (Redis 7)    → localhost:6379
  └── ngrok                    → public HTTPS URL → localhost:3000

BitBucket webhook URL = {ngrok public URL}/webhook
```

The shared volume mounts to `tools/data/` locally so developers can inspect job state with standard file tools. See [local-setup.md](local-setup.md) for the complete setup guide.

### 10.2 Production (Kubernetes)

```
Kubernetes cluster
├── Deployment:   agent-host (1+ replicas)
├── Ingress:      stable HTTPS URL for BitBucket/Jira webhooks
├── PVC:          shared volume (working/ + a5-ai checkout)
├── Redis:        managed (Redis Cloud) or in-cluster
└── Secret:       all credentials (BitBucket, Claude API, Loki, Tempo, Jira)
```

Moving from local to production requires only updating the webhook URL in BitBucket/Jira settings and providing credentials via K8s Secrets. No code changes.

### 10.3 Configuration

All configuration lives in `tools/config/settings.json` with environment variable overrides. The `jira` block is optional — the system starts and runs without it, with Jira tools returning `{ available: false }`.

---

## 11. Security

- **Credentials** are never committed to git. Injected as environment variables (locally via `.env`, in K8s via Secrets).
- **Webhook payloads** are verified using HMAC-SHA256 before processing. The raw request body is used for verification — the server does not pre-parse webhook JSON.
- **Service account permissions** are minimum required: Developer on target repos, Reviewer on `a5-ai`.
- **File system access** in tools is path-restricted to the shared volume. Agents cannot read or write outside `working/` and `a5-ai/`.
- **Claude API calls** never include credentials. Credentials are used only by the TypeScript tool implementations, not passed to the LLM.
- **Self-improvement changes** require human PR approval before taking effect. Agents cannot silently modify their own instructions.

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| Agent | A Claude API session given a specific role via an MD file, with access to a defined set of tools |
| Job | A unit of work with a `type`, `workflowPath`, and state persisted in Redis and the shared volume |
| JobType | `migration`, `feature`, or `self-update` — determines which workflow and phases apply |
| Job Runner | The TypeScript loop that drives a Claude API session for one job |
| Workflow | An MD file defining the ordered phases and decision logic for one type of job |
| Phase | A discrete stage within a workflow, each mapped to a specific agent MD file |
| Memory | MD files in `a5-ai/memory/` containing accumulated knowledge, updated via PRs |
| Self-improvement | When an agent writes to memory or agents/, triggering a PR on a5-ai for human review |
| Spec Writer | Agent that translates a Jira ticket into a structured feature spec for the planner |
| Feature | A logical group of endpoints or changes handled as one branch + PR |
| Service account | A BitBucket user account operated by the system (`@a5-coder-agent`, `@a5-reviewer-agent`) |
| Park | When a job pauses to wait for an external event (PR merge, comment, approval) without consuming CPU |
| Resume | When an incoming webhook event restores a parked job and continues its runner loop |
| workflowPath | The relative path to the workflow MD file for a job, e.g. `workflows/migration/workflow.md` |
