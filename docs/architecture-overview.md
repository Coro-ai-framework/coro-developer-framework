# Coro: High-Level Overview

**Audience:** Anyone who wants to understand how the system works
**Last updated:** 2026-04-26

---

## What is Coro?

Coro is a multi-tenant, plug-and-play AI agent platform for software
teams. It automates engineering workflows — currently **generic
implementation jobs** in any language plus internal **self-update**
jobs for the intelligence layer. New workflows and languages can be
added without touching the runtime.

Coro uses **Claude** (via the Claude Agent SDK) as its reasoning engine,
driven by a lightweight runner. The key design principle:

> **Markdown files are the intelligence. TypeScript is just the plumbing.**
> All workflow logic, decision-making, and accumulated knowledge live in
> markdown files. The runner runs phases, provides tools, and stores
> state.

Coro ships in two deployment shapes:

- **Solo mode** — runner + bundled dashboard + SQLite, all on a single
  laptop. Zero external dependencies.
- **Team mode (hybrid)** — local runner per developer plus a shared
  cloud control plane (Postgres + WebSocket + dashboard).

---

## How it works

```
  CLI / Dashboard           Jira ticket            Webhook (PR merged,
  (coro job …)              assigned                comment, etc.)
              │                  │                       │
              └──────────────────┼───────────────────────┘
                                 ▼
                       ┌─────────────────────┐
                       │   @coro-ai/runner      │  one process per developer
                       │   (always running)  │  • REST + dashboard server
                       └────────┬────────────┘  • job runner + MCP tools
                                │
              ┌─────────────────┼──────────────────────┐
              ▼                 ▼                      ▼
      ┌──────────────┐  ┌────────────────┐  ┌────────────────────────┐
      │  SQLite or   │  │  Claude Agent  │  │  Layered intelligence  │
      │  Cloud (WS)  │  │  SDK           │  │  base + tenant + repo  │
      │  state       │  │  runs phases   │  │  overlays              │
      └──────────────┘  └────────────────┘  └────────────────────────┘
```

1. A **trigger** starts a job — CLI command, dashboard form, Jira ticket,
   or webhook event.
2. The runner creates a **Job** with a `workflowPath` and looks up the
   matching **Workflow** (a markdown file with YAML front matter
   defining phase order, agent assignments, and model selection).
3. The **intelligence resolver** materialises a per-job overlay from
   three layers (base → tenant → repo) into
   `<workingDir>/<jobId>/_intelligence/`.
4. For each phase, the runner builds a small system prompt from the
   workflow + agent markdown + job context, and hands it to the
   Claude Agent SDK. Static intelligence (`.claude/CLAUDE.md`) and
   skills (`.claude/skills/`) are loaded natively by the SDK.
5. Claude executes the phase: reading code, writing code, calling MCP
   tools (Git providers, Loki, Jira, etc.), and making decisions.
6. When a job needs to wait for something external (e.g. a PR review),
   it **parks** in state. In solo mode, the runner polls the Git
   provider; in team mode, the cloud receives the webhook and notifies
   the runner over WebSocket. Either way, the job resumes automatically.

---

## The intelligence layers

Coro composes agent behaviour from three layers, materialised per-job:

```
┌─────────────────────────────────────────────────────────────┐
│ Repo overlay        <repoCheckout>/.coro/                   │
├─────────────────────────────────────────────────────────────┤
│ Tenant overlay      localDir | gitRemote | cloudBlob        │
├─────────────────────────────────────────────────────────────┤
│ Base intelligence   @coro-ai/intelligence-base/layer/          │
└─────────────────────────────────────────────────────────────┘
```

| Layer      | What it contains                                                          | Owner               |
| ---------- | ------------------------------------------------------------------------- | ------------------- |
| **Base**   | Generic agents, workflows, skills, empty memory templates                 | Coro maintainers    |
| **Tenant** | Company-specific facts, conventions, accumulated memory                   | The customer team   |
| **Repo**   | Per-repository overrides (e.g. a custom planner for a specific service)   | The target repo     |

Within each layer:

| Path                            | What it is                                              | How it changes                          |
| ------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| `.claude/CLAUDE.md`             | Always-loaded behaviour rules, conventions, context     | Humans edit; layers **append**          |
| `agents/`                       | Step-by-step procedures for each role                   | Agents can `propose_change`             |
| `workflows/`                    | Phase sequences, agent assignments, model selection     | Humans edit; layers replace             |
| `.claude/skills/`               | On-demand domain knowledge and language conventions     | Agents can `propose_change`             |
| `memory/`                       | Lessons learned from past jobs                          | Grows automatically; reviewed via PR    |

Agents are **generic** — the same coder agent handles Go, .NET, and
TypeScript. It becomes specialised by invoking the relevant skills on
demand during execution.

The target repo's own `.claude/` is **not** touched by Coro — Claude
Code's native walk-up handles it directly when the SDK is rooted in
the cloned repo.

---

## Workflows

### Generic implementation job

```
[Spec Writing] → Planning → [Code → Review → Test → Evaluate] → Reporting
```

Triggered from the CLI, dashboard, or a Jira ticket. The planner turns
the request into work items, and the runtime loops through coding,
review, testing, and evaluation until those work items are done.

---

## Key concepts

**Jobs park, not poll.** When a job waits for a PR merge or a developer
reply, it saves state and ends the SDK query. When the awaited event
arrives, the runner resumes exactly where it left off. Zero CPU while
waiting.

**Self-improvement.** Agents record insights during their work via
`add_insight`. The evaluator reviews them at the end and can call
`propose_change` to suggest updates to memory, skills, or agent
markdown. **Humans always approve before changes take effect** —
proposals land as files in solo mode (review locally) or in the cloud
dashboard in team mode.

**Language-agnostic.** Supporting a new language means adding one
convention skill (`.claude/skills/{language}-conventions/SKILL.md`).
The planner detects the target language from the repo (e.g. `go.mod`
→ `golang`, `*.csproj` → `dotnet`) and signals it to downstream agents
via `set_job_params`. No infrastructure changes.

**Multi-tenant by design.** Each runner carries a `TenantContext` —
`solo-<host>` for laptop deployments, `team-<teamId>` for cloud-backed
teams — that scopes intelligence overlays, state, and proposals. One
Coro deployment can serve many isolated tenants.

**Concurrent jobs.** Multiple developers (or a single developer
running multiple jobs) can run workflows simultaneously. Each job has
isolated working directories, its own intelligence overlay, and its
own state row.

---

## Tools available to agents

Agents have access to ~30 domain-specific MCP tools (under the
`mcp__coro__` prefix) plus the standard SDK file/shell/grep tools:

- **Git provider** — BitBucket and GitHub: create repos, open PRs,
  post reviews, approve, merge.
- **Observability** — query Loki logs and Tempo traces.
- **Jira** — read tickets, post comments, transition issues.
- **Build verification** — Bash from the repo checkout; language-specific commands live in `{language}-conventions` skills.
- **Job control** — manage phases, work items, park/resume, escalate
  to humans.
- **Self-improvement** — record insights, propose changes to agent
  knowledge.

---

## Deployment

- **Solo mode (default):** `coro start` boots the runner, serves the
  dashboard at `http://localhost:3000/dashboard/`, and keeps state in
  `~/.coro/state.db`. PR events are detected by polling.
- **Team mode (hybrid):** each developer's runner authenticates to a
  shared cloud control plane (`@coro-ai/runner`'s `src/cloud/`) over an
  authenticated WebSocket. Postgres holds team state; webhooks land on
  the cloud's stable URL and are routed to the right runner.

The same workflow and agent markdown work in both modes.

---

## In one sentence

Coro is a multi-tenant AI agent platform — defined entirely in
markdown — where Claude-powered agents autonomously plan, code, test,
review, and ship scoped changes through structured workflows, learning
and improving from every job they run, with humans always in the
approval loop.
