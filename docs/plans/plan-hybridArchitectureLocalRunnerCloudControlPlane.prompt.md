# Plan: Hybrid Architecture — Local Runner + Cloud Control Plane

## TL;DR

Rearchitect the A5 Agent Host from a monolithic server into a **hybrid system**: a lightweight **local runner app** on each developer's machine handles all code execution and AI agent work, while a **cloud control plane** we host provides team visibility, webhook delivery, job state, proposals, and the dashboard. Communication is via **WebSocket**. Developers use their own Anthropic API keys. Source code never leaves the developer's machine.

This supersedes the previous multi-tenant-only plan (`multi-tenant-agent-host.md`). Multi-tenancy is still the goal, but the deployment model fundamentally changes from "everything on our infra" to "execution local, coordination cloud."

---

## Why This Architecture

1. **Compliance/NDA** — source code never leaves the developer's machine. The cloud only sees job metadata, logs, token counts, and proposals (intelligence file diffs). No repo contents, no source code.
2. **Team shareability** — the real product value: shared knowledge base, shared dashboards, webhook delivery, proposal review, job history across the team.
3. **Developer experience** — `a5` CLI or lightweight desktop app. `a5 login`, `a5 migrate --repo my-service`, watch progress on the dashboard. Like GitHub Actions self-hosted runners but for AI agents.
4. **Cost model** — developers bring their own Anthropic API key. We host the control plane (low compute — just state + static dashboard). Our infrastructure cost is minimal.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  CLOUD CONTROL PLANE (our infrastructure)                    │
│                                                              │
│  ┌─────────────┐  ┌──────────┐  ┌────────────────────────┐  │
│  │  REST API   │  │ Postgres │  │     Dashboard (SPA)    │  │
│  │  + WebSocket│  │  (state) │  │  jobs, logs, proposals │  │
│  │  gateway    │  │          │  │  team settings         │  │
│  └──────┬──────┘  └────┬─────┘  └────────────────────────┘  │
│         │              │                                     │
│  ┌──────┴──────────────┴──────────────────────────────────┐  │
│  │              Cloud Service (Node.js)                   │  │
│  │  • Account/team/tenant management                      │  │
│  │  • Webhook reception → event routing to runners        │  │
│  │  • Job state CRUD                                      │  │
│  │  • Proposal storage + review API                       │  │
│  │  • Intelligence sync coordination                      │  │
│  │  • Runner registry (which runners are online)          │  │
│  │  • Log aggregation + SSE streaming to dashboard        │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                  │
└───────────────────────────┼──────────────────────────────────┘
                            │ WebSocket (persistent, authenticated)
              ┌─────────────┼─────────────┐
              │             │             │
┌─────────────┴──┐  ┌──────┴──────┐  ┌───┴─────────────┐
│  Runner (Dev A) │  │ Runner (B)  │  │  Runner (Dev C) │
│                 │  │             │  │                 │
│  Claude Code    │  │ Claude Code │  │  Claude Code    │
│  subprocess     │  │ subprocess  │  │  subprocess     │
│  ├─ MCP server  │  │             │  │                 │
│  ├─ filesystem  │  │             │  │                 │
│  ├─ git ops     │  │             │  │                 │
│  └─ builds/test │  │             │  │                 │
│                 │  │             │  │                 │
│  intelligence/  │  │ intel/      │  │  intel/         │
│  working/       │  │ working/    │  │  working/       │
│  .a5/config     │  │ .a5/config  │  │  .a5/config     │
└─────────────────┘  └─────────────┘  └─────────────────┘
       │                    │                   │
       ▼                    ▼                   ▼
  Anthropic API        Anthropic API       Anthropic API
  (dev's own key)     (dev's own key)     (dev's own key)
```

### What lives where

| Component | Location | Why |
|-----------|----------|-----|
| Agent execution (`query()`) | Local runner | SDK constraint: spawns local subprocess |
| MCP tools (filesystem) | Local runner | Needs local filesystem access |
| MCP tools (state) | Cloud (via WebSocket RPC) | Shared team state |
| MCP tools (network APIs) | Local runner | Runs from dev's machine using dev's credentials |
| Source code repos | Local runner | NDA/compliance — never leaves machine |
| Intelligence files | Local runner (git-synced) | Read at phase start, editable by team |
| Intelligence git remote | Tenant's own GitHub/GitLab | Version control managed by tenant |
| Job state (jobs, features, phases) | Cloud Postgres | Shared across team |
| Job logs | Cloud Postgres | Viewable by team on dashboard |
| Proposals | Cloud Postgres | Reviewable by team on dashboard |
| Webhook endpoint | Cloud | Needs public URL for BitBucket/GitHub |
| Dashboard | Cloud (hosted SPA) | Team access from any browser |
| Account/team management | Cloud | Centralized auth + billing |

---

## Data Flow: Complete Job Lifecycle

```
1.  Developer: a5 migrate --repo payment-service
2.  Local runner connects to cloud via WebSocket (already authenticated)
3.  Runner → Cloud: createJob({ type: 'migration', params: { repo: 'payment-service' } })
4.  Cloud: creates job in Postgres, returns job ID, broadcasts to dashboard SSE
5.  Runner: loads workflow from local intelligence dir
6.  Runner: builds system prompt from local intelligence (agents, memory, skills)
7.  Runner: spawns Claude Code subprocess (dev's ANTHROPIC_API_KEY)

    --- PHASE LOOP ---
8.  Claude Code calls MCP tools:
    ├─ Bash("git clone ...") → LOCAL filesystem
    ├─ Read/Write/Grep/Glob → LOCAL filesystem
    ├─ mcp__a5__log("Analyzing...") → WebSocket → Cloud (stored in Postgres)
    ├─ mcp__a5__set_features([...]) → WebSocket → Cloud
    ├─ mcp__a5__bb_create_pr(...) → LOCAL BitBucket API call
    │                                + WebSocket → Cloud (addPrMapping)
    └─ mcp__a5__run_go_build(...) → LOCAL child_process

9.  Runner streams token usage to cloud every 5 turns (WebSocket)
10. Phase completes → Runner sends phase result to cloud
11. Runner advances to next phase (or parks)

    --- WEBHOOK ---
12. Developer reviews PR on BitBucket → comment added
13. BitBucket sends webhook → Cloud public endpoint
14. Cloud: looks up job by PR ID → finds runner → forwards event via WebSocket
15. Runner: receives event, resumes parked job

    --- PROPOSAL ---
16. Agent calls propose_change → Runner sends to Cloud (WebSocket)
17. Cloud stores proposal in Postgres
18. Team member opens dashboard → sees proposal with diff
19. Team member approves → Cloud sends "apply" command to runner (WebSocket)
20. Runner: writes file to local intelligence dir, git commit + push

    --- COMPLETION ---
21. All phases done → Runner sends STATUS_COMPLETE to cloud
22. Cloud updates job, broadcasts to dashboard
23. Working directory can be cleaned up locally
```

---

## Core Abstraction: StateBackend + EventTransport

The runner doesn't know or care whether state is local or remote. Two interfaces make the runner portable across deployment modes.

### StateBackend interface

```typescript
interface StateBackend {
  // Job CRUD
  createJob(input: JobInput): Promise<Job>
  getJob(jobId: string): Promise<Job | null>
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job>
  listJobs(tenantId?: string): Promise<Job[]>
  deleteJob(jobId: string): Promise<void>

  // Logs
  appendLog(jobId: string, line: string): Promise<void>
  getLog(jobId: string, start?: number, end?: number): Promise<string[]>

  // PR mappings
  mapPrToJob(prId: number, jobId: string): Promise<void>
  getJobByPr(prId: number): Promise<Job | null>
  addPrMapping(jobId: string, mapping: PrMapping): Promise<Job>
  markPrMerged(jobId: string, prId: number, mergedAt: string): Promise<Job>

  // Jira mappings
  mapJiraTicketToJob(ticketId: string, jobId: string): Promise<void>
  getJobByJiraTicket(ticketId: string): Promise<Job | null>

  // Proposals
  createProposal(proposal: Omit<Proposal, 'id'>): Promise<Proposal>
  listProposals(tenantId: string, status?: string): Promise<Proposal[]>
  getProposal(tenantId: string, id: string): Promise<Proposal | null>
  updateProposal(tenantId: string, id: string, updates: Partial<Proposal>): Promise<Proposal>
}
```

### EventTransport interface

```typescript
interface EventTransport {
  // Runner → Cloud: report events
  emitJobEvent(jobId: string, event: JobEvent): Promise<void>

  // Cloud → Runner: receive events (webhooks, resume commands)
  onEvent(handler: (event: InboundEvent) => Promise<void>): void

  // Parking: job waiting for external event
  park(jobId: string, awaitedEvent: AwaitedEvent): Promise<void>

  // Connection lifecycle
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
}
```

### Implementations

| Interface | Implementation | Used by |
|-----------|---------------|---------|
| `StateBackend` | `CloudStateBackend` | Hybrid mode — WebSocket RPC to cloud |
| `StateBackend` | `SqliteStateBackend` | Fully local mode — SQLite on disk |
| `StateBackend` | `RedisStateBackend` | Legacy/migration — current monolith |
| `EventTransport` | `WebSocketTransport` | Hybrid mode — persistent WS to cloud |
| `EventTransport` | `PollingTransport` | Fully local mode — polls BitBucket/GitHub APIs |
| `EventTransport` | `InProcessTransport` | Legacy/test — current monolith behavior |

---

## Components

### A. Cloud Control Plane

New codebase (or major refactor of `tools/src/server.ts`) deployed to our infrastructure.

**A.1 Auth + Team Management API**
- `POST /auth/signup` — create account (email/password or OAuth)
- `POST /auth/login` — JWT issuance (access + refresh tokens)
- `POST /auth/refresh` — token refresh
- `POST /teams` — create team (becomes a `tenantId`)
- `GET /teams/:id` — team details
- `POST /teams/:id/members` — invite member (email)
- `DELETE /teams/:id/members/:userId` — remove member
- `POST /teams/:id/runner-tokens` — generate a runner token (scoped JWT for machine auth)
- `GET /teams/:id/settings` — team settings (intelligence git remote, webhook URLs, integrations)
- `PATCH /teams/:id/settings` — update team settings

**A.2 Job State API**
- `POST /jobs` — create job (called by runner via WebSocket, or REST fallback)
- `GET /jobs` — list jobs (scoped to team via JWT)
- `GET /jobs/:id` — job detail
- `GET /jobs/:id/stream` — SSE for live logs + status updates
- `PATCH /jobs/:id` — update job state (runner sends phase transitions, token usage)
- `POST /jobs/:id/logs` — batch append log lines

**A.3 Webhook Gateway**
- `POST /webhook/bitbucket/:teamId` — per-team BitBucket webhook URL (team-specific HMAC)
- `POST /webhook/github/:teamId` — per-team GitHub webhook URL (future)
- `POST /webhook/jira/:teamId` — per-team Jira webhook URL
- Routing: extract PR/ticket ID → look up job in Postgres → find the job's team → find connected runner → forward event via WebSocket
- Per-team webhook secrets stored in `webhook_configs` table

**A.4 Proposal Management API**
- `GET /teams/:tenantId/proposals` — list (filterable by status)
- `GET /teams/:tenantId/proposals/:id` — detail with full diff content
- `POST /teams/:tenantId/proposals/:id/approve` — approve → send `proposal:apply` command to runner
- `POST /teams/:tenantId/proposals/:id/reject` — reject with optional reason
- `PATCH /teams/:tenantId/proposals/:id` — edit `newContent` before approving

**A.5 WebSocket Gateway**
- Endpoint: `wss://api.a5labs.com/ws/runner`
- Authentication: runner token JWT validated on upgrade
- Runner registration: on connect, runner sends `{ runnerId, teamId, hostname, capabilities }`
- Cloud tracks: `Map<teamId, Map<runnerId, WebSocket>>`

  **Runner → Cloud messages:**
  | Message | Purpose |
  |---------|---------|
  | `job:create` | Create a new job |
  | `job:update` | Patch job state (phase, status, features, token usage) |
  | `job:log` | Append log lines (batched, buffered 100ms) |
  | `job:prMapping` | Register PR → job mapping |
  | `job:proposal` | Create a proposal |
  | `job:park` | Park job waiting for external event |
  | `job:complete` | Mark job done |
  | `runner:heartbeat` | Keepalive + current job + resource stats |

  **Cloud → Runner messages:**
  | Message | Purpose |
  |---------|---------|
  | `event:webhook` | Forwarded webhook payload (PR comment, approval, merge) |
  | `event:resume` | Resume a parked job (manual from dashboard) |
  | `event:message` | Inject message into running job conversation |
  | `proposal:apply` | Approved proposal — runner writes file + git push |
  | `runner:ping` | Heartbeat check |

  **Protocol:**
  - JSON over WebSocket frames
  - Request/response correlation via `messageId` field for RPC-style calls
  - Timeout: 30s for RPC responses, 3 retries with exponential backoff
  - Log batching: runner buffers log lines for 100ms before sending as array

**A.6 Runner Registry**
- Track connected runners per team: `Map<teamId, Map<runnerId, RunnerInfo>>`
- `RunnerInfo`: `{ hostname, connectedAt, lastHeartbeat, currentJobId?, status: 'idle'|'busy'|'offline' }`
- Heartbeat timeout: 90s → mark offline, show alert on dashboard
- Dashboard panel: "3 runners online, 1 busy (payment-service-migration), 2 idle"
- If runner disconnects mid-job: mark job as `runner-disconnected`, dashboard shows alert
- On reconnect: runner can resume disconnected jobs (sends `job:update` with current state)

**A.7 Database Schema (Postgres)**

Core tables:
- `users` — id, email, name, password_hash, oauth_provider, created_at
- `teams` — id, name, slug (= tenantId), created_at
- `team_members` — team_id, user_id, role ('admin'|'member'), invited_at, joined_at
- `runner_tokens` — id, team_id, name, token_hash, last_used_at, created_at, revoked_at
- `jobs` — all fields from `Job` interface, team_id FK, indexed by team_id + status
- `job_logs` — job_id, line_number, content, timestamp (append-only, bulk insert friendly)
- `proposals` — all fields from `Proposal` interface, team_id FK, indexed by team_id + status
- `pr_mappings` — pr_id (unique), job_id, team_id
- `webhook_configs` — team_id, provider ('bitbucket'|'github'|'jira'), secret, endpoint_url

Redis (ephemeral only):
- Pub/sub channels for SSE broadcasting (`job:{id}:events`)
- Runner registry cache (faster than DB queries for routing)
- Rate limiting

**A.8 Dashboard (extend current React app)**
- Login/signup pages
- Team switcher (if user belongs to multiple teams)
- Runner status panel (online/offline/busy)
- Job list + detail (data from Postgres via REST, live updates via SSE)
- Proposals review page (diff viewer, approve/reject/edit)
- Team settings page:
  - Intelligence git remote URL
  - Webhook URLs (copy-paste for BitBucket/GitHub webhook setup)
  - Team members + roles (invite, remove)
  - Runner tokens (create, revoke, see last used)
- Getting started wizard (first-time setup)

---

### B. Local Runner App

Refactor of `tools/src/jobs/runner.ts` + `tools/cli/` into a standalone process.

**B.1 Runner process lifecycle**
- Standalone Node.js process (npm package: `@a5labs/runner`, installed globally or via npx)
- Future: wrap in Tauri/Electron for desktop app with system tray
- On startup:
  1. Read local config (`~/.a5/config.json`)
  2. Determine mode: `hybrid` (cloud URL + token present) or `local` (no cloud config)
  3. Hybrid: create `CloudStateBackend` + `WebSocketTransport`, connect to cloud
  4. Local: create `SqliteStateBackend` + `PollingTransport`, serve local dashboard
  5. Pull latest intelligence from git remote
  6. Register as available (hybrid) or wait for CLI commands (local)

**B.2 MCP tool wiring in hybrid mode**

MCP server created fresh each phase (same as today). Tool handlers route to the right place:

| Tool | Handler | Transport |
|------|---------|-----------|
| `run_go_build` | Local in-process | Direct `child_process.exec` |
| `start_go_service` | Local in-process | Direct `child_process.spawn` |
| `stop_go_service` | Local in-process | Direct kill |
| `compare_request` | Local in-process | Direct HTTP fetch |
| `bb_create_pr` | Local (API call) + cloud (PR mapping) | HTTP to BitBucket + WebSocket RPC |
| `bb_*` (read/write) | Local in-process | Direct HTTP to BitBucket/GitHub |
| `log` | Cloud | WebSocket RPC → Postgres |
| `set_features` | Cloud | WebSocket RPC |
| `update_feature` | Cloud | WebSocket RPC |
| `get_features` | Cloud | WebSocket RPC |
| `request_new_session` | Cloud | WebSocket RPC |
| `set_job_params` | Cloud | WebSocket RPC |
| `goto_phase` | Local (in-memory signals) | Direct |
| `mark_phase_complete` | Local (in-memory signals) | Direct |
| `await_event` | Local (signals) + Cloud (park) | Direct + WebSocket |
| `escalate` | Cloud | WebSocket RPC |
| `add_insight` | Cloud | WebSocket RPC |
| `propose_change` | Cloud | WebSocket RPC |
| `list_proposals` | Cloud | WebSocket RPC |

**B.3 Intelligence management**
- Local git clone of team's intelligence repo at `~/.a5/intelligence/` (configurable)
- On startup: `git pull` to get latest
- Before each phase: `git pull` (same as `builder.ts` does today)
- On `proposal:apply` from cloud:
  1. `git pull` (avoid conflicts)
  2. Write proposed file to intelligence dir
  3. `git add` + `git commit -m "chore: apply proposal {id} - {reason}"` + `git push`
  4. Other team members' runners pull on next phase start → knowledge propagates

**B.4 Local config**
```json
// ~/.a5/config.json
{
  "cloud": {
    "url": "wss://api.a5labs.com",
    "token": "a5rt_..."
  },
  "anthropic": {
    "apiKey": "sk-ant-..."
  },
  "intelligence": {
    "dir": "~/.a5/intelligence",
    "gitRemote": "git@github.com:acme-corp/a5-intelligence.git"
  },
  "paths": {
    "workingDir": "~/.a5/working"
  },
  "git": {
    "provider": "github",
    "username": "developer",
    "token": "ghp_..."
  }
}
```

**B.5 CLI commands**
```bash
# First-time setup
a5 login                              # browser OAuth → saves runner token to ~/.a5/config.json
a5 init                               # interactive: API key, intelligence repo, git provider
a5 init --local                       # skip cloud, use SQLite + polling

# Job management (dispatched locally, state synced to cloud)
a5 migrate --repo payment-service
a5 feature --repo my-service --description "Add rate limiting"
a5 status                             # list running/recent jobs
a5 logs --job <id>                    # tail logs (live from runner + cloud)
a5 resume --job <id>                  # resume parked job

# Intelligence management
a5 proposals list                     # list pending proposals
a5 proposals approve <id>             # approve + apply locally + push
a5 proposals reject <id>              # reject

# Runner lifecycle
a5 runner start                       # start runner (foreground or daemonize)
a5 runner stop                        # stop runner daemon
a5 runner status                      # connection status, current job
```

---

### C. SQLite Backend (fully local mode, no cloud)

For solo developers, air-gapped environments, or quick evaluation.

**C.1 SqliteStateBackend**
- Implements `StateBackend` interface
- Database at `~/.a5/state.db` (auto-created on first use)
- Tables mirror Postgres schema: `jobs`, `job_logs`, `proposals`, `pr_mappings`
- Uses `better-sqlite3` (synchronous, fast, no native compile issues)

**C.2 PollingTransport**
- Implements `EventTransport`
- When job parks on a PR event: spawns a polling loop
  - `pr:comment:created` → poll `GET /repositories/{repo}/pullrequests/{id}/comments` every 60s
  - `pr:approved` → poll `GET /repositories/{repo}/pullrequests/{id}` every 60s
  - `pr:merged` → poll PR status every 60s
- ~1 minute latency on event delivery (acceptable for jobs that take hours)

**C.3 Local dashboard**
- Runner serves the same React SPA on `localhost:3000`
- API endpoints served by the runner process itself (mini Express server)
- No auth needed (single user, local machine)

**C.4 Mode selection**
- `a5 init --local` configures local mode
- No cloud URL or runner token in config → runner auto-detects local mode
- Can upgrade later: `a5 login` adds cloud config → restart runner → hybrid mode

---

## Implementation Phases

### Phase 1: StateBackend + EventTransport Abstraction

*Pure refactor — no new features, no behavioral change.*

1. Define `StateBackend` interface in `tools/src/state/backend.ts` (mirrors all 17 `JobRegistry` methods)
2. Define `EventTransport` interface in `tools/src/state/transport.ts`
3. Define event types in `tools/src/state/events.ts`
4. Extract `RedisStateBackend` from `registry.ts` → `tools/src/state/redis-backend.ts`
5. Extract `InProcessTransport` from `dispatcher.ts` → `tools/src/state/in-process-transport.ts`
6. Refactor `runner.ts`: replace all `registry.*` calls with `stateBackend.*`
7. Refactor `mcp-handlers.ts`: `ctx.registry` → `ctx.stateBackend`
8. Refactor `dispatcher.ts` to use interfaces
9. Wire in `index.ts`, update all tests

**Files changed:**
- `tools/src/state/backend.ts` (new)
- `tools/src/state/transport.ts` (new)
- `tools/src/state/events.ts` (new)
- `tools/src/state/redis-backend.ts` (new, extracted from `registry.ts`)
- `tools/src/state/in-process-transport.ts` (new, extracted from `dispatcher.ts`)
- `tools/src/jobs/runner.ts` (refactor)
- `tools/src/mcp-handlers.ts` (refactor)
- `tools/src/tools/types.ts` (update `ToolContext`)
- `tools/src/jobs/dispatcher.ts` (refactor)
- `tools/src/index.ts` (wire implementations)
- All test files (update mocks)

**Verification:** All existing tests pass, `npm run build` clean, no behavioral change.

---

### Phase 2: Cloud Control Plane — Core API

*Depends on Phase 1 interfaces.*

1. New `cloud/` directory — Node.js + Express/Fastify + Drizzle ORM
2. Postgres schema + migrations: `users`, `teams`, `team_members`, `runner_tokens`, `jobs`, `job_logs`, `proposals`, `pr_mappings`, `webhook_configs`
3. Auth endpoints: signup, login, refresh (JWT), OAuth (GitHub)
4. Team management: CRUD, member invite/remove, runner token generation
5. `PostgresStateBackend` implementing `StateBackend`
6. Job + Proposal REST API (scoped by team JWT)
7. SSE endpoint for live dashboard updates (Redis pub/sub → SSE)
8. Docker Compose for local dev (Postgres + Redis + cloud service)

**Verification:** Auth flow E2E, Job CRUD scoped to team, Proposal lifecycle.

---

### Phase 3: WebSocket Gateway + Protocol

*Depends on Phase 1 + Phase 2.*

1. WebSocket upgrade handler at `/ws/runner` (`cloud/src/ws/gateway.ts`)
2. Runner JWT auth on upgrade
3. Runner registry: `Map<teamId, Map<runnerId, WebSocket>>`
4. Webhook → WebSocket forwarding (PR/ticket ID → job → team → runner)
5. Pending event queue for offline runners (deliver on reconnect)
6. `WebSocketTransport` on runner side (`tools/src/state/ws-transport.ts`) — auto-reconnect, heartbeat
7. `CloudStateBackend` on runner side (`tools/src/state/cloud-backend.ts`) — RPC over WebSocket, message ID correlation, log batching

**Verification:** Connect/disconnect tracking, job creation via WS, webhook forwarding E2E, log streaming E2E.

---

### Phase 4: Hybrid Runner Refactor

*Depends on Phase 1 + Phase 3.*

1. Local config system: `~/.a5/config.json` reader/writer (`tools/src/config/local-config.ts`)
2. Runner entry point: detect mode (hybrid/local/legacy), create appropriate backend + transport
3. MCP handler wiring: split into local-handler vs cloud-handler routing based on tool type
4. Intelligence git management: auto-pull on startup + before each phase, `proposal:apply` handler
5. CLI commands: `a5 login`, `a5 init`, `a5 runner start/stop/status`
6. npm package: `@a5labs/runner`

**Verification:** Full job E2E: `a5 init` → `a5 runner start` → `a5 migrate --repo test` → job runs locally, state in cloud, logs on dashboard, proposal visible.

---

### Phase 5: SQLite + Polling (local mode)

*Depends on Phase 1 only — parallel with Phases 2-4.*

1. `SqliteStateBackend` using `better-sqlite3` (`tools/src/state/sqlite-backend.ts`)
2. `PollingTransport` — poll BB/GH API every 60s for PR events (`tools/src/state/polling-transport.ts`)
3. Local dashboard: runner serves React SPA on `localhost:3000`
4. `a5 init --local` mode

**Verification:** `a5 init --local` → `a5 migrate` → jobs in SQLite, local dashboard works, PR polling picks up events.

---

### Phase 6: Multi-Tenancy

*Depends on Phase 2 + Phase 4.*

1. Team = tenant, all data scoped by `team.slug`
2. Per-team webhook URLs + HMAC secrets
3. Team settings dashboard page (intelligence git URL, webhook URLs, members, runner tokens)
4. Getting started wizard

**Verification:** Two teams, separate data, separate webhook secrets, separate intelligence repos.

---

### Phase 7: Desktop App (future, optional)

- Tauri wrapper, system tray, auto-start, auto-update
- Not needed for v1 — CLI is sufficient

---

## What Changes From Current Codebase

| Current | New |
|---------|-----|
| `registry.ts` (Redis direct) | `StateBackend` interface + `RedisBackend` / `PostgresBackend` / `SqliteBackend` |
| `server.ts` (monolith) | Cloud: full API service. Runner: optional local server for dashboard |
| `runner.ts` calls `registry.*` | Runner calls `stateBackend.*` (injected) |
| `mcp-handlers.ts` uses `ctx.registry` | Uses `ctx.stateBackend` — routes to cloud or local |
| `dispatcher.ts` (in-process) | Cloud dispatches via WebSocket; runner dispatches locally for local mode |
| `watcher.ts` (file → git PR) | Removed for tenants. Proposals go through cloud. Our team's watcher stays. |
| `index.ts` (boots everything) | Two entry points: `cloud/` (cloud service) + `tools/src/runner/` (local runner) |
| Single-tenant, single-process | Multi-tenant, distributed (cloud + N runners) |

## What Does NOT Change

- **`runner.ts` core loop**: workflow loading → prompt building → `query()` → event stream → phase transitions
- **`builder.ts`**: loads from local intelligence dir (receives `intelligenceDir` path)
- **`workflow-parser.ts`**: unchanged
- **Agent instructions** (`agents/*.md`): unchanged
- **Skills** (`.claude/skills/`): unchanged
- **Memory** (`memory/`): unchanged
- **MCP tool names and agent-facing interface**: agents never know whether state goes to Redis, Postgres, or SQLite

---

## Three Deployment Modes

| Mode | Runner | State | Events | Dashboard | Use case |
|------|--------|-------|--------|-----------|----------|
| **Hybrid** | Dev machine | Cloud Postgres | WebSocket + webhooks | Cloud (shared) | Teams |
| **Local** | Dev machine | SQLite | Polling (60s) | localhost:3000 | Solo/eval |
| **Legacy** | Our server | Redis | In-process | Current | Transition |

All three use the same runner engine, same MCP tools, same agent instructions. Only `StateBackend` and `EventTransport` differ.

---

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| **WebSocket** for runner↔cloud | Real-time webhook forwarding + log streaming. REST polling adds latency and load. |
| **Postgres** for cloud state | Relational queries for teams/members, ACID, cheaper than Redis at scale. Redis stays for pub/sub. |
| **Runner JWT tokens** | Scoped per-team. Cloud never sees dev's Anthropic key. Revocable. |
| **Git-synced intelligence** | Team owns their intelligence in their own repo. Cloud never stores intelligence content. |
| **Local-first execution** | SDK spawns local subprocess (hard constraint). Also enables NDA compliance. |
| **SQLite for local mode** | Zero dependencies, single file, perfect for single-user. |
| **Same MCP tool interface** | Agents unaware of deployment mode. No workflow or agent instruction changes needed. |
| **Two entry points, same codebase** | Shared runner engine + interfaces. Cloud is new code. No fork. |

## Scope Boundaries

**Included:**
- StateBackend + EventTransport abstraction layer
- Cloud control plane (API, WebSocket, Postgres, dashboard)
- Auth + team management + runner tokens
- Local hybrid runner with WebSocket communication
- Intelligence git sync + proposal review on dashboard
- SQLite + polling for fully local mode
- CLI for all modes

**Excluded (future):**
- Desktop app (Phase 7 — CLI sufficient for v1)
- Per-team billing / usage metering / Stripe integration
- Cross-team shared intelligence templates / marketplace
- GitHub App integration (personal tokens for v1)
- Multiple concurrent jobs per runner
- Runner auto-scaling
- Multi-region cloud deployment
- Mobile dashboard

## Dependency Graph

```
Phase 1 (abstractions) ──┬── Phase 2 (cloud API) ── Phase 3 (WebSocket) ── Phase 4 (hybrid runner) ── Phase 6 (multi-tenant)
                          │
                          └── Phase 5 (SQLite + local mode)                                            Phase 7 (desktop)
```

Phase 1 is the foundation — pure refactor, unlocks everything. Phases 2→3→4→6 are the critical path. Phase 5 is independent after Phase 1.
