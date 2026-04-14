# Agent Host Service — Technical Specification

**Audience:** Engineers implementing or maintaining the Agent Host
**Status:** Specification — not yet implemented
**Last updated:** 2026-04-01

---

## Purpose

The Agent Host is the always-running service that:
1. Receives job requests from the CLI
2. Receives BitBucket webhook events and routes them to the correct running job
3. Manages the lifecycle of Claude API sessions (job runners)
4. Persists job state in Redis and on the shared volume

It is intentionally thin. All workflow intelligence lives in the MD files that agents read. The Agent Host is infrastructure — it runs the agents, it doesn't think for them.

---

## Technology

| Choice | Rationale |
|--------|-----------|
| TypeScript / Node.js | Consistent with team preference; strong typing for job state |
| Express.js | Minimal HTTP framework for webhook receiver and CLI API |
| Redis (ioredis) | Job queue, PR→job mapping, status tracking |
| Anthropic SDK (`@anthropic-ai/sdk`) | Claude API with tool use support |
| Docker Compose | Local development stack |

---

## Directory Structure

```
tools/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
├── config/
│   ├── settings.example.json
│   └── settings.json              ← gitignored, created by developer
└── src/
    ├── index.ts                   ← Entry point: starts HTTP server, connects Redis
    ├── server.ts                  ← Express app: /webhook, /jobs, /migrate endpoints
    ├── jobs/
    │   ├── registry.ts            ← Redis-backed job registry
    │   ├── dispatcher.ts          ← Routes webhook events to job runners
    │   ├── runner.ts              ← Core job runner: Claude API session loop
    │   └── types.ts               ← Job state types and enums
    ├── prompt/
    │   ├── builder.ts             ← Assembles system prompts from MD files
    │   └── tools.ts               ← Tool definitions passed to Claude API
    ├── clients/
    │   ├── bitbucket.ts           ← BitBucket REST API client (both service accounts)
    │   ├── loki.ts                ← Loki HTTP API client
    │   ├── tempo.ts               ← Tempo HTTP API client
    │   └── git.ts                 ← Git operations (clone, branch, commit, push)
    ├── tools/
    │   └── test-harness.ts        ← HTTP request replay and response diffing
    └── config/
        └── settings.ts            ← Loads and validates settings.json + env vars
```

---

## HTTP API

### `POST /jobs/migrate`

Submitted by the CLI to start a migration job.

**Request body:**
```json
{
  "repo": "my-service",
  "projects": ["MyService.API", "MyService.Models"],
  "reviewers": ["alice", "bob"],
  "stagingUrl": "https://staging.my-service.a5labs.com",
  "serviceName": "my-service"
}
```

**Response:**
```json
{
  "jobId": "my-service-migration-1234",
  "status": "queued",
  "streamUrl": "/jobs/my-service-migration-1234/stream"
}
```

The CLI can connect to `streamUrl` (SSE) to receive real-time log output.

### `GET /jobs`

Returns all active and recent jobs with their current status.

### `GET /jobs/:jobId`

Returns full status and phase breakdown for a specific job.

### `POST /jobs/:jobId/resume`

Resume a job from its last checkpoint (for use after a failure or restart).

### `POST /webhook`

Receives BitBucket webhook events. Validates HMAC signature before processing.

---

## Job Lifecycle

### Job states (stored in Redis)

```
queued → initializing → analyzing → planning → awaiting-plan-approval
→ coding:{feature-n} → awaiting-pr-merge:{feature-n}
→ testing:{feature-n} → evaluating:{feature-n}
→ [loops back to coding if needed]
→ reporting → complete | escalated
```

### Redis key structure

```
job:{jobId}                    Hash: full job state
job:{jobId}:log                List: log lines (for streaming)
pr:{prId}:job                  String: jobId that owns this PR
repo:{repoSlug}:jobs           Set: all job IDs that have touched this repo
```

### Job runner loop

The job runner is the core of the system. It maintains a conversation history with Claude and loops until the job is done:

```typescript
while (job.phase !== 'complete') {
  // 1. Pull latest a5-ai MD files
  await git.pull(settings.paths.a5aiDir)

  // 2. Build system prompt for current phase
  const systemPrompt = await promptBuilder.build(job)
  // (assembles CLAUDE.md + workflow.md + agent.md for current phase)

  // 3. Call Claude API with tool use enabled
  const response = await claude.messages.create({
    model: selectModel(job.phase),
    system: systemPrompt,
    messages: job.conversationHistory,
    tools: toolDefinitions
  })

  // 4. Process tool calls
  for (const toolCall of response.tool_calls) {
    const result = await tools[toolCall.name](toolCall.input)
    job.conversationHistory.push({ role: 'tool', content: result })
  }

  // 5. Persist updated state
  await redis.hset(`job:${job.id}`, job)

  // 6. Check if phase is complete (agent signals via a special tool call)
  if (response.phase_complete) {
    job.phase = nextPhase(job)
  }

  // 7. If waiting for an external event (PR merge, human approval), park the job
  if (response.awaiting_event) {
    job.status = `awaiting-${response.awaiting_event}`
    await redis.hset(`job:${job.id}`, job)
    break  // Job resumes when the webhook arrives
  }
}
```

### How jobs park and resume

When a job is waiting for a BitBucket event (e.g., PR to be merged), it parks itself:

```
Job: "I've opened PR #42. Now waiting for it to be merged."
↓ Job stores: awaiting_event = "pr:fulfilled", pr_id = 42
↓ Maps: redis SET pr:42:job → my-service-migration-1234
↓ Job runner exits (no CPU usage while waiting)

Later: BitBucket fires pr:fulfilled for PR #42
↓ Dispatcher: lookup redis GET pr:42:job → my-service-migration-1234
↓ Resume job my-service-migration-1234
↓ Job runner restarts from last checkpoint with webhook payload as new input
```

---

## Tool Definitions

These are the tools the Claude API can call during a job. Each is a TypeScript function in `src/tools/` that the job runner executes.

### File system tools
| Tool | Description |
|------|-------------|
| `read_file` | Read a file from the shared volume |
| `write_file` | Write a file to the shared volume |
| `list_directory` | List directory contents |
| `create_directory` | Create a directory |

### Git tools
| Tool | Description |
|------|-------------|
| `git_clone` | Clone a repo to the shared volume |
| `git_checkout_branch` | Create and checkout a new branch |
| `git_commit` | Stage all changes and commit |
| `git_push` | Push branch to BitBucket |
| `git_pull` | Pull latest from remote |
| `git_get_diff` | Get the current diff as text |

### BitBucket tools
| Tool | Description | Account used |
|------|-------------|-------------|
| `bb_create_repo` | Create a new repository | `a5-coder-agent` |
| `bb_create_pr` | Open a pull request | `a5-coder-agent` |
| `bb_get_pr_comments` | Fetch all comments on a PR | `a5-reviewer-agent` |
| `bb_post_pr_comment` | Post a comment on a PR | `a5-reviewer-agent` |
| `bb_reply_to_comment` | Reply to a comment thread | `a5-reviewer-agent` |
| `bb_approve_pr` | Approve a PR | `a5-reviewer-agent` |
| `bb_merge_pr` | Merge a PR | `a5-reviewer-agent` |
| `bb_get_pr_status` | Get PR approvals and CI status | `a5-reviewer-agent` |

### Observability tools
| Tool | Description |
|------|-------------|
| `loki_query` | Run a LogQL query against Loki |
| `tempo_get_trace` | Fetch a trace by ID from Tempo |
| `tempo_search` | Search traces by service and tags |

### Test harness tools
| Tool | Description |
|------|-------------|
| `run_go_build` | Build the Go service and return any errors |
| `start_go_service` | Start the Go service on a local port |
| `stop_go_service` | Stop the running Go service |
| `compare_request` | Send identical request to two services, return diff |

### Job control tools
| Tool | Description |
|------|-------------|
| `mark_phase_complete` | Signal to the runner that the current phase is done |
| `await_event` | Park the job waiting for a named BitBucket event |
| `escalate` | Surface a blocker to the user and pause the job |
| `log` | Emit a log line visible to the developer watching the job |

---

## Prompt Assembly

The prompt has two layers:

1. **Natively loaded by the SDK** — The Agent Host passes `settingSources: ['project']` and symlinks `.claude/` into each job's working directory. The SDK discovers `.claude/CLAUDE.md` (always-loaded behavior rules, company context, git conventions, infrastructure) and `.claude/skills/` (on-demand knowledge and conventions) automatically.

2. **Custom system prompt** — The `promptBuilder` assembles a lightweight system prompt from a5-ai MD files. It always pulls the latest git state before building, so merged improvements are immediately reflected.

```typescript
// Example: building the system prompt for the Coder phase
const systemPrompt = [
  readFile('a5-ai/workflows/migration/workflow.md'),
  readFile('a5-ai/agents/coder.md'),
  readFile('a5-ai/memory/MEMORY.md'),
  ...loadAllMemoryFiles('a5-ai/memory/'),
  `## Current job context\n${JSON.stringify(job.context, null, 2)}`
].join('\n\n---\n\n')
```

Domain knowledge (e.g. migration coding patterns) and language conventions (e.g. Go standards) are no longer injected into the system prompt. Agents invoke them on-demand via the `Skill` tool, significantly reducing per-phase token costs.

---

## Webhook Event Routing

```
Incoming webhook → verify HMAC signature → parse event type

pr:created          → check if PR is owned by a job
                      → activate PR Reviewer job

pr:comment_created  → lookup pr:{prId}:job in Redis
                      → resume PR Reviewer job with comment payload

pr:approved         → lookup job → check if all required approvers have approved
                      → if yes: signal PR Reviewer job to proceed with merge

pr:fulfilled        → lookup job → advance to Tester phase

pr:fulfilled        (on a5-ai repo)
                    → pull latest a5-ai on shared volume
                    → notify all running jobs that MD files have updated
```

---

## Self-Update Flow

When an agent writes to `a5-ai/memory/`, `a5-ai/agents/`, or `a5-ai/.claude/` on the shared volume, the Agent Host detects the change (file watcher) and triggers a self-update job:

1. Branch `a5-ai`: `improvement/{description}`
2. Commit the changed files with a structured message
3. Open PR on `a5-ai` repo via `@a5-coder-agent`
4. Activate `@a5-reviewer-agent` on the PR
5. Wait for human approval and merge
6. On merge: pull latest, clear file-change flag

This ensures the shared volume's `a5-ai/` checkout is always in sync with the git repo.

---

## Docker Compose Spec (reference)

```yaml
services:
  agent-host:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - shared-data:/data
      - ./config/settings.json:/app/config/settings.json:ro
    env_file:
      - .env
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    restart: unless-stopped

  ngrok:
    image: ngrok/ngrok:latest
    command: http agent-host:3000
    ports:
      - "4040:4040"      # ngrok inspector UI
    environment:
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
    depends_on:
      - agent-host

volumes:
  shared-data:    # working/ and a5-ai/ checkout
  redis-data:     # Redis persistence
```
