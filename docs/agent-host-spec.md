# Coro Runner — Technical Specification

**Audience:** Engineers implementing or maintaining `@coro-ai/runner`
**Status:** Implemented (mid-`0.2.x`)
**Last updated:** 2026-04-26

> **Naming note:** earlier drafts of this document called the runner the
> "Agent Host". The runtime is now packaged as **`@coro-ai/runner`** in the
> pnpm workspace; the file name is preserved for backwards-compatibility
> with existing links.

---

## 1. Purpose

`@coro-ai/runner` is the always-running process on a developer's machine.
It is responsible for:

1. Receiving job requests from the `coro` CLI, the bundled dashboard,
   the cloud control plane (in hybrid mode), and webhook-driven
   triggers.
2. Materialising a per-job intelligence overlay (base + tenant + repo).
3. Driving a Claude Agent SDK `query()` for each phase.
4. Hosting the in-process MCP server that exposes Coro's domain tools.
5. Persisting job state in SQLite (local mode) or in cloud Postgres via
   a WebSocket transport (hybrid mode).
6. Detecting external events (PR merge, comment, etc.) and resuming
   parked jobs.

It is intentionally thin. All workflow intelligence lives in markdown
that the agents read; the runner runs the agents, it doesn't think for
them.

---

## 2. Technology

| Choice                                | Rationale                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------- |
| TypeScript / Node.js (>= 20)          | Strong typing for job state; ecosystem for SDKs and MCP tooling             |
| pnpm workspaces                       | Local linking between `@coro-ai/runner`, `@coro-ai/dashboard`, `@coro-ai/intelligence-base`, `@coro-ai/plugin-sdk`, `@coro-ai/llm-anthropic` |
| `@coro-ai/plugin-sdk` + `@coro-ai/llm-anthropic` | Plugin contract (`PhaseExecutor`) + the built-in Anthropic executor that wraps `@anthropic-ai/claude-agent-sdk`. The runner core never imports the Anthropic SDK directly. |
| Express + `ws`                        | Local REST server, plus WebSocket transport (hybrid mode)                   |
| `better-sqlite3`                      | Local-mode state (`~/.coro/state.db`)                                       |
| Drizzle ORM + Postgres                | Cloud control plane state (hybrid mode)                                     |
| `commander`                           | CLI command parsing                                                         |
| `pino` + `pino-pretty`                | Structured logging                                                          |

---

## 3. Repository layout

The runner lives in `packages/runner/`:

```
packages/runner/
├── package.json                ← @coro-ai/runner
├── tsconfig.json
├── docker-compose.cloud.yml    ← Cloud control plane stack: Postgres + (optional) Redis
├── cli/                        ← The `coro` CLI
│   ├── index.ts                ← Top-level program (`coro start`, …)
│   ├── browser-open.ts         ← Auto-opens dashboard with headless detection
│   └── commands/               ← start, init, login, job, jobs, status, logs, resume, message, runner
└── src/
    ├── runner/
    │   ├── index.ts            ← startRunner(): mode dispatch + bootstrap
    │   ├── server.ts           ← Express server: /dashboard, /jobs, /config, …
    │   ├── claude-login.ts     ← Claude OAuth login flow used by dashboard
    │   └── hybrid-dispatcher.ts ← WebSocket-driven cloud job dispatch
    ├── cloud/                  ← Cloud control plane service
    │   ├── index.ts            ← Cloud entrypoint
    │   ├── auth/               ← OAuth + JWT issuance for runner pairing
    │   ├── routes/             ← /teams, /teams/:id/jobs, /teams/:id/proposals, /webhook
    │   ├── ws/                 ← gateway + runner registry (WebSocket fan-out)
    │   └── db/                 ← Drizzle schema + connection
    ├── jobs/                   ← runner.ts (phase loop), dispatcher.ts, types.ts, creation.ts
    ├── plugins/                ← Plugin registry, loaders, builtin executor wiring
    │   ├── registry.ts         ← PluginRegistry: resolveScm/Tracker/Executor + resolvePhaseAssignment
    │   ├── loaders.ts          ← Disk + workspace plugin loading
    │   └── builtin/index.ts    ← buildBuiltinPluginRegistry (registers @coro-ai/llm-anthropic)
    ├── prompt/builder.ts       ← Phase-scoped system prompt assembly
    ├── intelligence/           ← Layered intelligence
    │   ├── tenant-context.ts   ← solo-<host> | team-<teamId>
    │   ├── resolver.ts         ← Per-job overlay materialisation
    │   ├── merge.ts            ← Layer merge primitives (replace + append)
    │   └── loaders/            ← localDir, gitRemote, cloudBlob, repo-coro
    ├── state/                  ← StateBackend interface + transports
    │   ├── backend.ts
    │   ├── sqlite-backend.ts   ← Local mode
    │   ├── cloud-backend.ts    ← Hybrid mode (over WebSocket)
    │   ├── redis-backend.ts    ← Legacy single-host shared state
    │   ├── ws-transport.ts     ← Runner → cloud WebSocket client
    │   ├── ws-protocol.ts
    │   ├── polling-transport.ts ← Local-mode PR polling
    │   └── in-process-transport.ts ← Test transport
    ├── clients/                ← bitbucket, github, git, jira, loki, tempo
    ├── tools/self-improvement.ts ← Proposal helpers
    ├── mcp-server.ts           ← In-process MCP server (Coro domain tools)
    ├── mcp-handlers.ts         ← Tool handler implementations
    ├── workflow-parser.ts      ← YAML front-matter + phase config
    ├── config/                 ← Settings type + LocalConfig schema
    ├── claude-code-path.ts     ← Resolves bundled Claude Code CLI
    └── dashboard-dist.ts       ← Resolves built dashboard assets
```

The dashboard (`@coro-ai/dashboard`) builds to a static `dist/` and is
served by the runner from `dashboard-dist.ts`. The base intelligence
(`@coro-ai/intelligence-base`) is consumed via `getBaseLayerRoot()` and
mounted as the bottom layer of every per-job overlay.

---

## 4. Deployment modes

The runner detects its mode at startup
(`src/config/local-config.ts → detectMode`):

| Mode      | Trigger                                                | State                            | Event delivery                  |
| --------- | ------------------------------------------------------ | -------------------------------- | ------------------------------- |
| `local`   | No `cloud.url` / `cloud.token` in config               | SQLite (`~/.coro/state.db`)      | `PollingTransport` polls Git provider |
| `hybrid`  | `cloud.url` + `cloud.token` present                    | Cloud Postgres via WebSocket     | Cloud forwards webhook events   |

Bootstrapping:

- `coro start` → `startRunner()` → either `startLocalRunner()` or
  `startHybridRunner()`.
- Both paths build a `Settings` object from `LocalConfig`, ensure the
  working + intelligence dirs exist, instantiate the right
  `StateBackend` and `EventTransport`, build the typed API clients,
  synthesize a `TenantContext`, and start an Express server on the
  configured port (default `3000`).
- The Express server is identical in both modes; only the state and
  transport differ.

---

## 5. Local HTTP API (the runner)

These endpoints are served by every runner — local or hybrid — at the
configured port (default `3000`). They power the bundled dashboard and
the `coro` CLI.

| Method | Path                                            | Purpose                                                                           |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| GET    | `/health`                                       | Liveness probe                                                                    |
| POST   | `/jobs`                                         | Submit a new job (CLI / dashboard)                                                |
| GET    | `/jobs`                                         | List jobs (filtered by status, paginated)                                         |
| GET    | `/jobs/:jobId`                                  | Get a single job's full state                                                     |
| GET    | `/jobs/:jobId/stream`                           | Server-Sent Events stream of live logs                                            |
| GET    | `/jobs/:jobId/artifacts/:artifactId/content`    | Download an artefact body                                                         |
| POST   | `/intake/stream`                                | Coro plan mode — SSE conversational brief (see §5.1)                              |
| POST   | `/jobs/:jobId/resume`                           | Resume a parked or failed job                                                     |
| POST   | `/jobs/:jobId/message`                          | Send a mid-flight developer message into the running job                          |
| GET    | `/config`                                       | Read current `LocalConfig` (secrets redacted)                                     |
| PUT    | `/config`                                       | Patch `LocalConfig` (dashboard preserves redacted values)                         |
| GET    | `/config/anthropic/claude-login/status`         | Status of an in-progress Claude OAuth login                                       |
| POST   | `/config/anthropic/claude-login/start`          | Start the Claude Code OAuth login flow                                            |
| POST   | `/config/anthropic/claude-login/callback`       | Complete the OAuth callback                                                       |
| POST   | `/config/anthropic/generate-oauth-token`        | Generate a long-lived Claude OAuth token                                          |
| GET    | `/dashboard/*`                                  | Serve the built dashboard SPA                                                     |
| GET    | `/`                                             | Redirects to `/dashboard/`                                                        |

### `POST /jobs` request (illustrative)

```json
{
  "type": "job",
  "workflowPath": "workflows/job/workflow.md",
  "params": {
    "repoSlug": "my-service",
    "description": "Add rate limiting to /api/users",
    "reviewers": ["alice", "bob"],
    "gitProvider": "github"
  }
}
```

`workflowPath` is resolved against the per-job intelligence overlay,
not the runner's process-wide intelligence dir.

### 5.1 `POST /intake/stream` (Coro plan mode)

Lightweight intake path for the dashboard **New Run** chat. Implemented in
`packages/runner/src/intake/handler.ts` with system instructions from
`packages/runner/src/intake/system-prompt.ts`.

- **Transport:** Server-Sent Events (`text/event-stream`).
- **Auth:** Same local runner surface as other dashboard routes (no separate token).
- **Executor path:** Prefer `PhaseExecutorRuntime.chat()` when implemented
  (direct Anthropic `/v1/messages` or OpenAI Responses — no Claude Code
  subprocess, no MCP tools). Falls back to `runSubagent` / `executePhase`
  only when `chat` is absent.
- **Model resolution:** Optional per-request `{ model, provider }` from the
  dashboard picker; otherwise `selectModel({ tier: 'planning' }, settings)`.
- **Session budgets:** 8 turns, 4k output tokens/turn, 30k tokens/session
  (in-memory map keyed by `sessionId`).
- **Abort behaviour:** Plan-mode streams do **not** wire `AbortSignal` to
  `req.on('close')` — Express 4 on Node 20 fires `close` immediately after
  `express.json()` finishes, which previously aborted every LLM call.

Request body requires `sessionId` (string) and `messages` (user/assistant
array). Optional `context` carries `recentRepos`, `recentReviewers`,
`availableWorkflows`, and `userLocale` for prompt grounding.

SSE payload types: `token` (text delta), `done` (optional usage), `error`.

The assistant is instructed to emit a final `<brief>{…json…}</brief>` block
parsed client-side (`packages/dashboard/src/lib/intake-brief.ts`). Dispatch
uses the same `POST /jobs` path as the classic form once the operator approves
the preview card.

Related config keys: `coachMode` (interactive defaults, graduation counter),
`intake.mode` (`ai` | `form` | `ask-each-time`). See
`packages/runner/src/config/local-config.ts`.

---

## 6. Cloud control plane API (hybrid mode only)

The cloud entrypoint is `src/cloud/index.ts` (`@coro-ai/runner`'s `dev:cloud`
script). It is its own Express server, distinct from the per-developer
runner:

| Method | Path                                | Purpose                                                                           |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------- |
| GET    | `/health`                           | Liveness                                                                          |
| -      | `/auth/*`                           | OAuth login + JWT issuance for runner pairing                                     |
| -      | `/teams/*`                          | Team CRUD                                                                         |
| -      | `/teams/:teamId/jobs/*`             | Team-scoped job CRUD; dispatches to the team's connected runner over WebSocket    |
| -      | `/teams/:teamId/proposals/*`        | Self-improvement proposal review + apply                                          |
| -      | `/webhook/*`                        | Per-team, HMAC-verified webhook receiver (BitBucket / GitHub)                     |
| GET    | `/teams/:teamId/runners`            | List currently connected runners for a team                                       |
| WS     | `/ws/runner`                        | Authenticated WebSocket for runner-cloud state + dispatch                         |

The `RunnerRegistry` (`src/cloud/ws/runner-registry.ts`) tracks live
connections per team; the `WsGateway` routes job-dispatch and
event-delivery messages to the right runner.

---

## 7. Job lifecycle

### 7.1 State

Job records carry:

```
id            jobId (e.g. my-service-job-1712123456789)
type          'job' | 'self-update' | …
tenantId      'solo-<host>' | 'team-<teamId>'
workflowPath  string (resolved against the per-job overlay)
params        free-form bag (repoSlug, description, reviewers, language, …)
phase         current phase name
status        'queued' | 'planning' | 'coding' | 'awaiting-pr-merge' |
              'awaiting-developer-input' | 'complete' | 'escalated' | 'failed' | …
workItems     ordered list with per-item status + loop count
currentWorkItem
prMappings    map of PRs owned by this job
artefacts     dashboard-renderable outputs (plan-md, pr-link, report-md, …)
insights      accumulated learnings for the evaluator
tokenUsage    per-phase usage telemetry
```

### 7.2 Typical sequence

```
queued
  → planning
  → awaiting-plan-approval        (interactive checkpoint)
  → coding:{work-item}
  → awaiting-pr-merge:{work-item}
  → testing:{work-item}
  → evaluation:{work-item}
  → [loop or advance]
  → reporting
  → complete | escalated | failed
```

### 7.3 Phase loop

Each phase resolves a `PhaseExecutor` plugin (default:
`@coro-ai/llm-anthropic`) and calls `executor.executePhase()`. The
executor owns the underlying LLM SDK call (Claude Agent SDK,
OpenAI Responses, etc.) and the full tool-use loop. The runner's
outer loop advances phases based on `PhaseSignals` set by MCP tool
handlers.

Executors may also implement **`chat()`** — a stateless conversational
completion used exclusively by Coro plan mode (`POST /intake/stream`).
It bypasses MCP bridges, hooks, working directories, and subprocess
agents. See `@coro-ai/plugin-sdk` `ChatRequest` / `ChatResult`.

```ts
while (!isTerminalStatus(job.status)) {
  resetSignals(signals)
  const mcp = createCoroMcpServer(toolCtx, signals)

  await resolveJobIntelligence({ … })      // re-resolve at every phase boundary
  const systemPrompt = await buildSystemPrompt(job, jobIntelligenceDir, logger)

  const assignment = pluginRegistry.resolvePhaseAssignment(job, phaseConfig, settings)
  const executor = pluginRegistry.resolveExecutor(assignment.providerId)

  await executor.executePhase({
    jobContext: { job, cwd: clonedRepoDir, intelligenceDir: jobIntelligenceDir },
    model: assignment.model,
    systemPrompt,
    mcpServer: mcp,
    signals,
    // …
  })
  // executor invokes MCP handlers, which mutate signals + state via stateBackend

  job = applyPhaseSignals(job, signals)     // goto_phase, await_event, escalate, complete
  await stateBackend.saveJob(job)
  if (signals.parked) break                 // resume happens on event delivery
}
```

The job runner does **not** decide work-item boundaries, loop counts,
or feature-specific logic. Those decisions live in the workflow + agent
markdown and are surfaced to the runner exclusively via tool calls.

### 7.3a Job completion readiness (completion gate)

When the workflow's last phase ends and no `goto_phase` / `await_event`
signal would re-route the job, the runner is about to transition the
job into `STATUS_COMPLETE`. Before doing so it evaluates a single,
workflow-agnostic invariant called the **completion gate**:

- If `job.workItems` is empty, the gate is skipped (campaigns,
  fast-lane single-implicit-scope jobs, jobs whose planner never
  called `set_work_items`). The job completes immediately.
- Otherwise, every entry in `job.workItems` must be in status
  `complete` or `escalated`. If any work item is still `pending` or
  `in-progress`, the runner:
  1. Writes a `[completion-gate]` line to the job log naming the
     blocking work items and the still-open vs merged PR mappings.
  2. Sets `job.pendingPrompt` to a structured corrective prompt
     (see `packages/runner/src/jobs/completion-gate.ts` —
     `buildJobCompletionBlockPrompt`) that lists every blocking
     work item, summarises `job.prMappings` by work item (open vs
     merged via the optional `mergedAt` stamp set by `scm_merge_pr`),
     and tells the agent to use `get_work_items`, `update_work_item`,
     and `goto_phase` to drive the missing work to completion.
  3. **Re-runs the current phase** — `phase` and `status` are
     unchanged. The agent receives the corrective prompt on its
     next turn and uses its workflow MD to decide where to route
     work next (e.g. `goto_phase("coding")` if implementation is
     incomplete, `goto_phase("review")` if PRs are open and
     unmerged). The runner does **not** hardcode any specific phase
     transition — that belongs to intelligence.
- Five consecutive completion-gate blocks (configurable via
  `COMPLETION_GATE_MAX_RETRIES`) transition the job to
  `STATUS_FAILED` with `escalationMessage` naming the work items
  that never closed. This is the safety net against a model that
  ends every turn without acting on the corrective prompt.

The counter is reset to zero on any non-completion phase transition,
so legitimate fix loops that move the job out of the final phase and
back are not counted against the cap.

The gate intentionally lives at the only place all workflows converge
on completion (`if (!nextPhase)`). Per-phase gates (e.g. `review →
evaluation`) are deliberately avoided because workflows differ:
standard `coding → review → evaluation`, fast `review-and-verify`,
deep extra-QA pipelines, etc. Encoding any specific transition in the
harness would break those alternatives.

### 7.4 Parking, events, and resumption

When an agent calls `await_event`, the runner sets the awaited event in
state (including optional `awaitingPrId` as a **hint** for the dashboard)
and ends the SDK query. The slot is freed.

#### Per-job event queue (in-memory)

The dispatcher (`packages/runner/src/jobs/dispatcher.ts`) keeps a
FIFO `eventQueue` per job id:

- While the job is **actively running**, inbound SCM webhooks are
  **queued** (not dropped). When the current runner turn finishes,
  the `finally` block drains **the entire queue in one batch** into a
  single `pendingPrompt` via `buildBatchedWebhookMessage` — e.g. a
  comment on PR #1 and approvals on PR #2/#3 arrive in one
  chronological list for the agent's next turn.
- While the job is **parked**, the first webhook wakes it immediately;
  additional webhooks that arrive before that run finishes are queued
  and merged into the same batched prompt on the next drain.
- The queue is process-scoped (not persisted). After a runner restart,
  `PollingTransport` cold-start polling resynchronises PR state.

#### Multi-PR polling (local mode)

`PollingTransport` polls the configured SCM provider at a fixed
interval (default `60s`) and delivers synthetic events to parked jobs.

For each parked job, the poller iterates **every unmerged entry in
`job.prMappings`** (not only `awaitingPrId`). Each mapping resolves
to the correct `repoKey` and SCM plugin (`matchesRemote`). This lets
approvals and comments on sibling PRs wake the job while the agent
was parked awaiting a different PR.

`scm_merge_pr` stamps `mergedAt` on the matching mapping so open vs
merged PRs are visible in logs, the completion gate, and the
**"Open PRs on this job"** block injected into every phase kickoff
(`packages/runner/src/jobs/phase-kickoff.ts`).

#### Webhooks (hybrid and local)

Plugin webhooks resolve the job via `getJobByPr` / `getJobByExternalRef`
for **any** PR mapped to the job — not only the PR in `awaitingPrId`.
Any matched event on a parked job triggers `resumeWithEvent`.

Developer-driven resumption (`coro resume <jobId>`, dashboard "resume"
button, or `coro message <jobId> <text>`) goes through the same
dispatcher path.

#### Coding preflight

When a job enters the `coding` phase and `currentWorkItem` already has
open (non-merged) PRs in `prMappings`, the kickoff prompt prepends a
`[coding-preflight]` warning — a soft nudge to hand off to `review`
instead of opening more PRs. The completion gate remains the hard
backstop.

### 7.5 Mid-phase steering (Anthropic)

While a job is actively running, the dashboard can send a developer
message without rebuilding the session:

1. **Push** — the message is framed as `[DEVELOPER MESSAGE]` and appended
   to the phase-long `PushableInput` stream (not `Query.streamInput()`,
   which would close stdin and break MCP).
2. **Interrupt** — optional `Query.interrupt()` so the agent yields and
   reads the queued message on the next iteration.

Two interrupt modes (see `ExecutorSessionController` in
`@coro-ai/plugin-sdk`):

| Mode | When | Behavior |
|------|------|----------|
| `safe` | Default while `mcp__*` tool in flight | Message is queued only; no interrupt (avoids aborting in-flight MCP control requests). |
| `urgent` | No MCP tool in flight, or **Pause** | `interrupt()` (5s ack budget) then async MCP heal (`mcpRebuild`, `setMcpServers`, reconnect external servers). PreToolUse blocks `mcp__*` while heal runs. The pushable stays open on `result` events whose `stop_reason` is `interrupted`, `tool_use`, or `pause_turn`; on all other reasons it closes when empty (same as pre-steering behavior) so the runner advances phases. |

**Pause** is distinct from steering: it parks the job first, then calls
`interrupt({ mode: 'urgent' })` and closes the developer-input channel
so the phase can end cleanly.

Recoverable SDK errors after interrupt (`[ede_diagnostic]`,
`Request was aborted`) are **not** treated as job failures — the
executor emits `stopReason: 'interrupted'` and logs a `[control]`
line (never a red `[error]`) instead of setting `STATUS_FAILED`.

If `interrupt()` does not ack within 10s, the steer message stays
queued and a `[control]` timeout line is appended.

MCP transport blips (`Stream closed`, etc.) trigger inline
`healMcpTransport()` and an optional retry nudge so the agent retries
the same tool call instead of replanning.

---

## 8. Intelligence resolution

Triggered at job start and at every phase boundary
(`src/intelligence/resolver.ts`):

```
inputs:
  baseLayerDir        → @coro-ai/intelligence-base/layer/
  tenantContext       → solo-<host> | team-<teamId> with optional overlay descriptor
  jobId               → unique job id
  workingRoot         → settings.paths.workingDir
  repoCheckoutDir     → derived from job.params.repoSlug (may not yet exist)
  loaderCacheRoot     → ~/.coro/cache/

outputs:
  intelligenceDir     → <workingRoot>/<jobId>/_intelligence/
```

Layers are merged according to the rules described in
[architecture.md §4.2](architecture.md#42-merge-rules):

- `.claude/CLAUDE.md` and `memory/**/*.md` are **appended** with
  provenance banners.
- All other paths follow **last-wins replace** semantics.

The materialised path is stable across re-resolves (it's a pure
function of `jobId` + `workingRoot`), so callers can capture
`jobIntelligenceDir` once and trust per-phase calls to refresh
contents in place.

---

## 9. Prompt assembly

`src/prompt/builder.ts` produces a phase-scoped system prompt from the
per-job overlay:

1. The workflow markdown referenced by `workflowPath` (front matter
   stripped).
2. The agent markdown for the current phase.
3. Structured current-job context (state JSON, accumulated insights).

`.claude/CLAUDE.md` and `.claude/skills/` are loaded natively by the
SDK when `settingSources: ['project']` is set and the SDK's `cwd` is
inside the per-job overlay (or the cloned repo, depending on the
phase). Skills are invoked on demand by agents — they are not injected
into the prompt.

The result is a small, focused prompt that does not hard-wire knowledge
into TypeScript and avoids per-phase token bloat.

---

## 10. MCP domain tools

The in-process MCP server (`src/mcp-server.ts`) is created fresh for
every phase, sharing the `ToolContext` and `PhaseSignals` objects with
the runner so handler tool calls are observed immediately.

Tool surface (under the `mcp__coro__` prefix):

| Group                          | Tools                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| BitBucket                      | `bb_create_repo`, `bb_create_pr`, `bb_get_pr_status`, `bb_get_pr_comments`, `bb_post_pr_comment`, `bb_reply_to_comment`, `bb_approve_pr`, `bb_merge_pr` |
| GitHub                         | `gh_create_repo`, `gh_create_pr`, `gh_get_pr_status`, `gh_get_pr_comments`, `gh_post_pr_comment`, `gh_reply_to_comment`, `gh_approve_pr`, `gh_merge_pr` |
| Observability                  | `loki_query`, `tempo_get_trace`, `tempo_search`                                                                       |
| Jira                           | `jira_get_issue`, `jira_post_comment`, `jira_transition_issue`                                                        |
| Job control                    | `set_work_items`, `update_work_item`, `get_work_items`, `request_new_session`, `set_job_params`, `goto_phase`, `await_event`, `escalate`, `log` |
| Artefacts                      | `post_artifact`, `get_artifacts`                                                                                      |
| Self-improvement               | `add_insight`, `propose_change`, `list_proposals`, `read_memory`                                                      |

The SDK ships standard built-in tools (Read, Write, Edit, Bash, Glob,
Grep, Skill, …) which the workflow's per-phase tool allowlist may
restrict.

Language-specific harness tools (`run_go_build`, `start_go_service`,
`stop_go_service`, `compare_request`) were removed — build and test use
Bash plus `{language}-conventions` skills.

### 10.1 Workspace layout and intelligence layering

- **`scm_clone_repo`** persists `params.repoCheckoutDir` and
  `params.repoCheckoutAbsDir` on the job after clone or reuse.
- The system prompt includes a **Workspace layout** block (see
  `packages/runner/src/jobs/workspace-layout.ts`) with job root vs repo
  paths. Phase kickoff repeats a short `cd` reminder.
- **Shared intelligence** (`CLAUDE.md`, agents, prompt builder) stays
  language-agnostic: paths, `cd` into repo, invoke Skill for
  `{language}-conventions`.
- **Language-specific** compile/test/env recipes live only in
  `packages/intelligence-base/layer/.claude/skills/*-conventions/`.

---

## 11. State backends

`StateBackend` (`src/state/backend.ts`) is the abstraction every job
runner code path uses.

| Backend                | When                                          |
| ---------------------- | --------------------------------------------- |
| `SqliteStateBackend`   | Local mode (`~/.coro/state.db`)               |
| `CloudStateBackend`    | Hybrid mode (state ops over WebSocket)        |
| `RedisStateBackend`    | Legacy / shared single-host deployments       |
| `InProcessTransport`   | Test transport                                |

The cloud control plane's Postgres schema (Drizzle) backs the cloud
backend; the runner never talks to Postgres directly.

---

## 12. Working directory

Default: `~/.coro/work/<jobId>/`.

Typical contents:

- `_intelligence/` — the materialised per-job overlay (base + tenant +
  repo).
- `<repoSlug>/` — the cloned target repository (where the SDK roots
  its cwd for code-touching phases).
- Generated plans, reports, evaluations, and test outputs.

Each job's directory is isolated from every other job's, so concurrent
runs are safe.

---

## 13. Self-update flow

When an agent calls `propose_change`, the proposal is persisted in
state with `kind` (memory / skill / agent / workflow), file payloads,
and a description.

- **Local mode:** the proposal is written to the configured
  intelligence directory (under a `proposals/` subtree) for human
  review locally before being committed to the upstream tenant
  overlay.
- **Hybrid mode:** the proposal is stored in cloud Postgres and shown
  in the dashboard's review UI. On approval, the cloud applies the
  change to the tenant overlay (and, optionally, opens a PR against
  the overlay's git remote).

In both cases, **proposals never silently mutate live intelligence**.
Once approved and applied, all subsequent phases pick up the change at
the next intelligence re-resolve.

---

## 14. CLI surface

Defined in `cli/index.ts`. After `pnpm -r build`, the binary lives at
`packages/runner/dist/cli/index.js`. Run any command with `--help`.

| Command                                | Purpose                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `coro start [--port N] [--no-open]`    | Boot the runner + dashboard and (by default) open the dashboard in a browser  |
| `coro init [--local]`                  | Non-interactive first-time configuration (writes `~/.coro/config.json`)       |
| `coro login`                           | Pair the runner with the cloud control plane (team mode)                      |
| `coro job …`                           | Submit a new job                                                              |
| `coro jobs`                            | List recent jobs                                                              |
| `coro status <jobId>`                  | Show a job's current state and phase                                          |
| `coro logs <jobId> [--follow]`         | Stream a job's logs                                                           |
| `coro message <jobId> <text>`          | Send a mid-flight message into a running job                                  |
| `coro resume <jobId>`                  | Resume a parked or failed job                                                 |
| `coro runner status` / `runner start`  | Inspect resolved config + mode; alias of `coro start` (back-compat)           |

Auto-open behaviour suppresses the browser when the runner detects a
headless environment (`CI=true`, `SSH_CONNECTION` set, or a Linux
desktop with no `DISPLAY`). Override with `--open` (force) or
`--no-open` (suppress); set `CORO_NO_OPEN=1` to make the suppression
permanent.

---

## 15. Cloud Compose stack (hybrid mode reference)

The cloud control plane is run separately from the per-developer
runner. A reference Compose file ships at
`packages/runner/docker-compose.cloud.yml` and stands up Postgres (and
optionally Redis) for the cloud entrypoint to consume.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: coro
      POSTGRES_PASSWORD: coro
      POSTGRES_DB: coro
    ports:
      - "5432:5432"
    volumes:
      - pg-data:/var/lib/postgresql/data

volumes:
  pg-data:
```

The cloud entrypoint is started with:

```bash
pnpm --filter @coro-ai/runner dev:cloud
```

Per-developer runners do **not** require Docker, Postgres, or Redis —
they boot directly from `coro start` and use SQLite by default.
