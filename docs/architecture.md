# Coro: Architecture Overview

**Audience:** Engineers, stakeholders, engineering managers
**Status:** Active implementation
**Last updated:** 2026-04-26

---

## 1. Executive summary

Coro is a multi-tenant, plug-and-play AI agent platform for software teams.
It runs AI-driven engineering workflows where the **intelligence lives in
markdown** and the TypeScript runtime only provides execution, state, and
tools. The same product ships in two deployment shapes:

- **Solo mode** — runner + dashboard + SQLite, all on a single laptop.
- **Team mode (hybrid)** — local runner per developer + shared cloud
  control plane (Postgres, WebSocket gateway, dashboard).

Two job classes exist today:

- **Implementation jobs** for scoped changes in an existing repository
  (`workflows/job/workflow.md`).
- **Self-update jobs** for improving the agent intelligence stack itself
  (triggered by `propose_change` calls).

The core design rule is unchanged:

> **Markdown files are the intelligence. TypeScript is the tool shell.**

Workflow logic, agent procedures, language conventions, and accumulated
memory all live in markdown. The runner does not hardcode product features
or workflow-specific logic. A job carries a `workflowPath`; the runner
materialises the right intelligence overlay, hands it to the Claude Agent
SDK, and exposes a domain-specific MCP toolset. The LLM does the rest.

---

## 2. Packages

Coro ships as a pnpm workspace with three packages:

| Package                       | Role                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `@coro/runner`                | The runtime: `coro` CLI, REST + dashboard server, job runner, MCP server, intelligence resolver, state backends, cloud control plane. |
| `@coro/dashboard`             | React + Vite + Tailwind UI. Built statically and served by the runner at `/dashboard/`. |
| `@coro/intelligence-base`     | The base intelligence layer: generic agents, workflows, skills, and empty memory templates. The runner imports `getBaseLayerRoot()` from this package. |

There is no monolithic "Agent Host" service; the runner *is* the host
and the cloud control plane is a separate `@coro/runner` entrypoint
(`src/cloud/`) that team-mode runners connect to.

---

## 3. Component map

```text
                Developer CLI / Dashboard / Webhooks / Jira
                                │
                                ▼
                    ┌──────────────────────────┐
                    │   @coro/runner (local)   │   one process per developer
                    │   + bundled @coro/       │   • REST server (CLI + dashboard)
                    │     dashboard at         │   • Job runner (Claude Agent SDK)
                    │     /dashboard/          │   • In-process MCP server
                    └──────────┬───────────────┘
                               │
        ┌──────────────────────┼──────────────────────────────┐
        │                      │                              │
        ▼                      ▼                              ▼
┌────────────────┐   ┌────────────────────┐   ┌────────────────────────────┐
│ State backend  │   │ Intelligence       │   │ External API clients       │
│  • Sqlite      │   │ resolver           │   │  • BitBucket / GitHub      │
│   (local mode) │   │  • Base layer      │   │  • Jira                    │
│  • Cloud over  │   │  • Tenant overlay  │   │  • Loki / Tempo            │
│   WebSocket    │   │  • Repo overlay    │   │  • Git CLI                 │
│   (hybrid)     │   │ → per-job overlay  │   │                            │
└────────────────┘   └────────────────────┘   └────────────────────────────┘

                                Hybrid mode only:
                                ▼
                    ┌──────────────────────────┐
                    │ @coro/runner (cloud)     │
                    │  src/cloud/              │
                    │  • Postgres (Drizzle)    │
                    │  • WebSocket gateway     │
                    │  • REST API              │
                    │  • Webhook receiver      │
                    └──────────────────────────┘
```

The runner is the only long-running process on a developer's machine.
External services (BitBucket, GitHub, Loki, Tempo, Jira) are talked to
directly from the runner via typed clients. In team mode, an additional
cloud process holds shared state and federates webhook events to the
right runner.

---

## 4. Layered intelligence

### 4.1 The three layers

Per job, the **intelligence resolver** stacks three layers and writes the
merged result to `<workingDir>/<jobId>/_intelligence/`:

```
┌─────────────────────────────────────────────────────────────┐
│ Repo overlay        <repoCheckout>/.coro/                   │
├─────────────────────────────────────────────────────────────┤
│ Tenant overlay      localDir | gitRemote | cloudBlob        │
├─────────────────────────────────────────────────────────────┤
│ Base intelligence   @coro/intelligence-base/layer/          │
└─────────────────────────────────────────────────────────────┘
```

| Layer      | Source                           | Owner               | Loads at                                                                       |
| ---------- | -------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| **Base**   | `@coro/intelligence-base/layer/` | Coro maintainers    | Runner start                                                                   |
| **Tenant** | `tenant.overlay` (config or JWT) | The customer team   | Job start                                                                      |
| **Repo**   | `<targetRepo>/.coro/`            | The target repo     | Each phase boundary (opportunistic — appears once the agent clones the repo)   |

### 4.2 Merge rules

| Path                                                            | Mode                               | Why                                                                  |
| --------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `.claude/CLAUDE.md`                                             | **append** with provenance banners | Mirrors Claude Code's native CLAUDE.md walk-up. Tenants extend, never overwrite. |
| `memory/**/*.md`                                                | **append** with provenance banners | Memory is cumulative knowledge — additions never erase prior entries. |
| Everything else (`agents/`, `workflows/`, `.claude/skills/`, `.claude/settings.json`, …) | **last-wins** replace              | Predictable per-path override; tenants and repos can fully redefine an agent or workflow. |

Append banners look like `<!-- ─── coro layer: tenant:team-abc ─── -->`
so the model can see provenance when reading the merged file.

### 4.3 Resolver lifecycle

The resolver (`packages/runner/src/intelligence/resolver.ts`) runs:

1. **At job start** — materialises base + tenant + (opportunistic) repo
   overlay into `<workingDir>/<jobId>/_intelligence/`.
2. **At every phase boundary** — re-resolves idempotently. This is how
   the repo overlay (`<repoCheckout>/.coro/`) gets picked up: agents
   typically clone the target repo during phase 1, so phase 2 onward
   sees the now-present `.coro/`.

The runner points all per-job markdown reads (workflow loader, prompt
builder, subagent loader, filesystem hooks) at the resolved path.

### 4.4 The target repo's own `.claude/`

Coro intentionally does **not** touch the target repo's `.claude/`
directory. That contract belongs to Claude Code's native walk-up, which
the SDK runs at its `cwd` (the cloned repo). This is the "hybrid
Claude-native" model: Coro owns `agents/`, `workflows/`, `memory/`, and
`.claude/skills/`; Claude Code owns project-level `.claude/CLAUDE.md`
discovery.

---

## 5. Tenant context

Every runner instance carries a `TenantContext`
(`packages/runner/src/intelligence/tenant-context.ts`) that identifies
which tenant a job belongs to:

- **Local mode** synthesises `solo-<host>` from the OS hostname. The
  local config can attach a `tenant.overlay` source so a single-host
  solo deployment still benefits from a tenant overlay.
- **Hybrid mode** derives `team-<teamId>` from the JWT used to
  authenticate to the cloud control plane. Today the hybrid handshake
  leaves the cloud-supplied overlay descriptor `undefined`; that link
  is closed in the next phase.

The `TenantContext` is attached to the `RunnerContext` at bootstrap and
to the `ToolContext` per job. The intelligence resolver reads it to
decide which tenant overlay to apply; MCP tools that write back to
memory or proposals route writes to the right layer.

---

## 6. Workflow model

### 6.1 Job routing

Each job has two fields that control execution:

```ts
type:         JobType         // 'job' | 'self-update' | …
workflowPath: string          // relative to the resolved intelligence dir
```

| Trigger source                           | JobType       | workflowPath                          |
| ---------------------------------------- | ------------- | ------------------------------------- |
| `coro job` (CLI or dashboard)            | `job`         | `workflows/job/workflow.md`           |
| Jira ticket assigned to the agent        | `job`         | `workflows/job/workflow.md`           |
| Internal proposal flow (`propose_change`)| `self-update` | inline (no workflow file)             |

### 6.2 Workflow definitions

Workflows are markdown files with YAML front matter. The front matter
defines:

- initial phase and status
- per-phase agent assignment
- model selection (`planning` vs `coding`)
- optional interactive checkpoints (pauses for developer input)
- optional subagents and per-subagent tool allowlists
- optional trigger-specific overrides (e.g. start in `spec-writing` for
  Jira-triggered jobs)

Example shape:

```yaml
---
initial_phase: planning
initial_status: queued

phases:
  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning
    interactive_checkpoint: true

  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
    subagents:
      - name: code-reviewer
        agent: agents/pr-reviewer.md
        model: coding
        tools: [Read, Glob, Grep, mcp__coro__bb_post_pr_comment]

overrides:
  jira:
    initial_phase: spec-writing
---
```

### 6.3 Current implementation workflow

The generic implementation workflow is work-item driven:

```text
[Spec Writing] → Planning → [Coding → Review → Testing → Evaluation] → Reporting
```

The planner defines work items. The evaluator decides whether to loop,
move forward, escalate, or finish. The runner only honours the agent's
tool calls (`set_work_items`, `update_work_item`, `goto_phase`,
`await_event`) and phase signals.

---

## 7. Agents, skills, and memory

### 7.1 Always-loaded context

`.claude/CLAUDE.md` is loaded natively by the SDK
(`settingSources: ['project']`) from the resolved per-job overlay. It
provides:

- behavior rules
- git conventions
- tenant and infrastructure context
- PR conventions
- tool usage expectations

### 7.2 Phase agents

| Phase          | Agent                       |
| -------------- | --------------------------- |
| `spec-writing` | `agents/spec-writer.md`     |
| `planning`     | `agents/planner.md`         |
| `coding`       | `agents/coder.md`           |
| `review`       | `agents/pr-reviewer.md`     |
| `testing`      | `agents/tester.md`          |
| `evaluation`   | `agents/evaluator.md`       |
| `reporting`    | `agents/planner.md`         |

Agents are **generic procedures**. They become specialised by invoking
skills on demand — the same coder agent works for Go, .NET, and other
languages.

### 7.3 Skills

Skills live under `.claude/skills/{name}/SKILL.md` and are invoked by
agents through the `Skill` tool. Current categories:

- implementation planning and testing
- language conventions for Go and .NET
- self-improvement guidance

The runner does not inject skills into every prompt; agents pull them
when needed. This keeps per-phase prompts small.

### 7.4 Memory

The `memory/` directory stores durable lessons learned: known pitfalls,
successful patterns, recurring PR feedback, language mapping notes.

Agents load memory on demand through the `read_memory` MCP tool. The
evaluator may file `propose_change` to add new memory or skill content;
those proposals always go through the human-reviewed PR pipeline.

---

## 8. Prompt assembly

The prompt builder
(`packages/runner/src/prompt/builder.ts`) assembles a
**phase-scoped** system prompt from the per-job intelligence overlay:

1. the workflow markdown referenced by `workflowPath` (front matter
   stripped)
2. the agent markdown for the current phase
3. structured current-job context (state JSON, accumulated insights)

The SDK separately loads `.claude/CLAUDE.md` and exposes `.claude/skills/`
to the agent at runtime. Memory is fetched by the agent via `read_memory`
when needed. The result is a small, focused prompt that does not
hard-wire knowledge into TypeScript.

---

## 9. Job lifecycle

### 9.1 State model

Jobs persist:

- identity and routing (`id`, `type`, `workflowPath`, `tenantId`)
- trigger context (`triggerSource`, `params`)
- execution status (`status`, `phase`)
- work-item progress (`workItems`, `currentWorkItem`, `workItemLoopCount`)
- PR mappings and artefacts
- insights and token usage

### 9.2 Typical lifecycle

```text
queued → planning → awaiting-plan-approval
       → coding:{work-item} → awaiting-pr-merge:{work-item}
       → testing:{work-item} → evaluation:{work-item}
       → [loop or advance]
       → reporting → complete | escalated | failed
```

Some jobs may begin in `spec-writing` when triggered from Jira.

### 9.3 Parking and resumption

Jobs are event-driven. When a job calls `await_event`, it parks by
storing the awaited event in state and ending the SDK query. The runner
then frees the slot.

- In **local mode**, a polling transport
  (`src/state/polling-transport.ts`) periodically polls the configured
  Git provider for PR-state changes (created, updated, merged, comments)
  and dispatches matched events to the parked job.
- In **hybrid mode**, the cloud control plane receives webhooks
  (`/webhook`, HMAC-verified per team), looks up the parked job in
  Postgres, and sends a job-resume command to the right runner over
  WebSocket.

In both modes, the runner reloads the job and resumes execution from
the saved phase. No polling on the agent side, no busy-wait.

---

## 10. State and persistence

The runner uses a `StateBackend` interface
(`packages/runner/src/state/backend.ts`) so the same job runner code
works in both deployment modes.

| Mode    | Backend                | Where state lives                         |
| ------- | ---------------------- | ----------------------------------------- |
| Local   | `SqliteStateBackend`   | `~/.coro/state.db` (better-sqlite3)       |
| Hybrid  | `CloudStateBackend`    | Postgres in cloud, accessed over WebSocket |

A legacy `RedisStateBackend` is still in the tree for cases where a
shared single-host Redis is preferred, but it is not part of the default
solo or team flows.

### 10.1 Working directory

Each job gets its own working directory under `<workingDir>/<jobId>/`.
Default is `~/.coro/work/<jobId>/`. Typical contents:

- `_intelligence/` — the materialised per-job overlay (base + tenant + repo)
- `<repoSlug>/` — the cloned target repository
- generated plans, reports, evaluations, and test outputs

This keeps concurrent jobs isolated.

---

## 11. Tool system

### 11.1 Built-in SDK tools

The Claude Agent SDK provides standard code-navigation and editing tools:
file read/write/edit, shell execution, glob, grep, and subagents where
configured by the workflow.

### 11.2 MCP domain tools

The in-process MCP server (`packages/runner/src/mcp-server.ts`) exposes
business-specific capabilities under the `mcp__coro__` prefix:

- **BitBucket** — `bb_create_repo`, `bb_create_pr`, `bb_get_pr_comments`,
  `bb_post_pr_comment`, `bb_reply_to_comment`, `bb_approve_pr`,
  `bb_merge_pr`, `bb_get_pr_status`
- **GitHub** — `gh_create_repo`, `gh_create_pr`, `gh_get_pr_comments`,
  `gh_post_pr_comment`, `gh_reply_to_comment`, `gh_approve_pr`,
  `gh_merge_pr`, `gh_get_pr_status`
- **Observability** — `loki_query`, `tempo_get_trace`, `tempo_search`
- **Jira** — `jira_get_issue`, `jira_post_comment`, `jira_transition_issue`
- **Test harness** — `run_go_build`, `start_go_service`, `stop_go_service`,
  `compare_request`
- **Job control** — `set_work_items`, `update_work_item`, `get_work_items`,
  `set_job_params`, `goto_phase`, `await_event`, `escalate`, `log`,
  `request_new_session`
- **Artefacts** — `post_artifact`, `get_artifacts`
- **Self-improvement** — `add_insight`, `propose_change`, `list_proposals`,
  `read_memory`

These tools are domain-aware but workflow-agnostic. The workflow and
agent markdown decide when to call them.

---

## 12. Deployment modes

### 12.1 Solo (local) mode

Single laptop, zero external dependencies:

- `coro start` boots the runner.
- The runner serves the dashboard at `http://localhost:3000/dashboard/`
  and auto-opens it in the browser (suppressed in headless / CI / SSH).
- State lives in SQLite at `~/.coro/state.db`.
- PR events are detected by polling the configured Git provider.
- Self-improvement proposals land as files in the configured intelligence
  directory for human review.

This is the recommended default for individual developers and small
teams getting started.

### 12.2 Team (hybrid) mode

Each developer runs their own runner; a shared cloud control plane
holds team state and federates webhook events:

- Cloud process: `@coro/runner`'s `src/cloud/` entrypoint, backed by
  Postgres (Drizzle ORM), with a WebSocket gateway and REST API.
- Runner ↔ cloud: authenticated WebSocket; the runner extracts `teamId`
  from a JWT to derive its tenant context.
- Webhooks: BitBucket / GitHub send to the cloud's stable
  `/webhook` endpoint; the gateway routes events to the right runner.
- Tenant overlays: pulled per team. Sources are `localDir`, `gitRemote`
  (cached under `~/.coro/cache/tenant-overlays/<tenantId>/`), or
  `cloudBlob` (delivered through the cloud handshake).

The same workflow and agent markdown work in both modes — the execution
contract is identical.

### 12.3 Configuration

Solo-mode config lives at `~/.coro/config.json`. Schema and defaults are
in `packages/runner/src/config/local-config.ts`. The dashboard's
**Settings** page is the primary way to edit it.

---

## 13. Self-improvement loop

Agents accumulate **insights** during their work via `add_insight`.
The evaluator reviews them at the end of a job and may call
`propose_change` to suggest updates to memory, skills, or agent
markdown.

- In **solo mode**, proposals are written to the intelligence
  directory; the developer reviews them locally before committing
  upstream.
- In **team mode**, proposals are persisted in the cloud and surfaced
  in the dashboard for team review; on approval the cloud applies them
  to the tenant overlay.

In both cases, **humans always approve before changes take effect**.
Once applied, all subsequent jobs see the updated intelligence at the
next phase boundary.

The self-improvement pipeline covers three layers of intelligence:

- **Memory** (`memory/*.md`) — high volatility, grows with every job.
- **Skills** (`.claude/skills/*/SKILL.md`) — medium volatility.
- **Agent instructions** (`agents/*.md`) — lower volatility.

---

## 14. Security and control

Key rules:

- Credentials (Anthropic, Git provider, observability) are stored
  per-user in `~/.coro/config.json` or per-team in the cloud. They are
  used by the runner's typed API clients but never embedded in the
  prompt or shown to the model directly.
- Webhook requests at the cloud `/webhook` endpoint are HMAC-verified
  per team before being routed.
- Self-improvement proposals always require human approval.
- Each job operates inside its own working directory and only
  against repositories it has been pointed at.
- Multi-tenancy is enforced at the resolver and state layers: tenant
  overlays are scoped by `tenantId`, and the cloud's job/proposal
  routes are mounted under `/teams/:teamId/…`.

---

## 15. Glossary

| Term              | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Job               | A unit of work executed by a runner.                                                     |
| Work item         | A tracked slice of work inside a job, produced by the planner.                           |
| Workflow          | A markdown document defining ordered phases and agent assignments.                       |
| `workflowPath`    | Path (relative to the resolved intelligence dir) to the workflow markdown for a job.     |
| Agent             | A markdown-defined procedure for a specific phase role.                                  |
| Skill             | On-demand guidance loaded by an agent for a domain or language.                          |
| Tenant            | A solo developer (`solo-<host>`) or a team (`team-<teamId>`) that owns intelligence and state. |
| Tenant overlay    | A markdown layer that customises base intelligence for one tenant.                       |
| Repo overlay      | A markdown layer that lives inside a target repo's `.coro/` directory.                   |
| Resolver          | The component that materialises the per-job intelligence overlay.                        |
| Park              | Stop active execution while waiting for an external event.                               |
| Resume            | Continue a parked job after the awaited event arrives.                                   |
