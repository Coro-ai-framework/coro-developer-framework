# AI Agent Platform: Architecture Overview

**Audience:** Engineers, stakeholders, engineering managers  
**Status:** Active implementation  
**Last updated:** 2026-04-24

---

## 1. Executive Summary

This platform runs AI-driven engineering workflows where the intelligence lives in Markdown and the TypeScript runtime only provides execution, state, and tools.

Two workflow classes exist today:

- **Implementation jobs** for scoped changes in an existing repository
- **Self-update jobs** for improving the agent intelligence stack itself

The core design rule is unchanged:

> **Markdown files are the intelligence. TypeScript is the tool shell.**

The runtime does not hardcode product features or workflow-specific business logic. A job carries a `workflowPath`, the runner loads that workflow document, and the LLM decides how to proceed using workflow definitions, agent instructions, skills, memory, and MCP tools.

---

## 2. System Components

### 2.1 Component map

```text
Developer CLI / Dashboard / Jira / Webhooks
                  |
                  v
        +-------------------------+
        |   Agent Host Service    |
        |  TypeScript / Node.js   |
        +-----------+-------------+
                    |
      +-------------+-------------------------------+
      |             |               |               |
      v             v               v               v
 +----------+  +----------+  +-------------+  +-------------+
 | State    |  | Prompt   |  | MCP Server  |  | Job Runner  |
 | Backend  |  | Builder  |  | + Clients   |  | per active  |
 |          |  |          |  |             |  | job         |
 +----------+  +----------+  +-------------+  +-------------+
      |                                                  |
      v                                                  v
 Redis / SQLite / Postgres                      Claude Agent SDK
                                                + built-in tools
```

### 2.2 Runtime responsibilities

The TypeScript runtime is responsible for:

- Accepting job creation requests from the CLI, dashboard, Jira, or internal watchers
- Persisting job state and log streams
- Loading the correct workflow document from `workflowPath`
- Building the per-phase prompt from workflow, agent, and job context
- Exposing domain-specific MCP tools to the agent
- Advancing, parking, and resuming jobs based on tool signals and external events

The runtime is **not** responsible for deciding work-item boundaries, loop counts, or feature-specific logic. Those decisions belong to the workflow and agent markdown.

---

## 3. Workflow Model

### 3.1 Job routing

Each job has two fields that control execution:

```ts
type: JobType
workflowPath: string
```

Current routing:

| Trigger source | JobType | workflowPath |
| --- | --- | --- |
| CLI `a5 job` | `job` | `workflows/job/workflow.md` |
| Jira assignment | `job` | `workflows/job/workflow.md` |
| Internal watcher / proposal flow | `self-update` | `workflows/self-update/workflow.md` or inline flow |

### 3.2 Workflow definitions

Workflows are markdown files with YAML front matter. The front matter defines:

- initial phase and status
- phase ordering
- per-phase agent assignment
- model selection (`planning` vs `coding`)
- optional trigger-specific overrides
- optional subagents and tool allowlists

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

  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding

overrides:
  jira:
    initial_phase: spec-writing
---
```

### 3.3 Current implementation workflow

The generic implementation workflow is work-item driven:

```text
[Spec Writing] -> Planning -> [Coding -> Review -> Testing -> Evaluation]
```

The planner defines work items. The evaluator decides whether to loop, move forward, escalate, or finish. The runner only honors the agent's tool calls and phase signals.

---

## 4. Agents, Skills, and Memory

### 4.1 Always-loaded context

`.claude/CLAUDE.md` provides:

- behavior rules
- git conventions
- company and infrastructure context
- PR conventions
- tool usage expectations

### 4.2 Phase agents

Current first-class agents:

| Phase | Agent |
| --- | --- |
| `spec-writing` | `agents/spec-writer.md` |
| `planning` | `agents/planner.md` |
| `coding` | `agents/coder.md` |
| `review` | `agents/pr-reviewer.md` |
| `testing` | `agents/tester.md` |
| `evaluation` | `agents/evaluator.md` |
| `reporting` | `agents/planner.md` |

Agents are generic procedures. They become specialized by loading skills on demand.

### 4.3 Skills

Skills live under `.claude/skills/` and are invoked by agents when needed.

Current categories:

- implementation planning and testing
- language conventions for Go and .NET
- self-improvement guidance

The runtime does not inject every skill into every prompt. Skills are loaded when the agent chooses them.

### 4.4 Memory

The `memory/` directory stores durable lessons learned:

- known pitfalls
- successful patterns
- recurring PR feedback
- language mapping notes

Agents load memory on demand via the MCP memory tools. The evaluator may propose updates when a reusable pattern emerges.

---

## 5. Prompt Assembly

The prompt builder assembles a phase-scoped prompt from:

1. the workflow markdown referenced by `workflowPath`
2. the agent markdown for the current phase
3. structured current-job context

The SDK separately loads `.claude/CLAUDE.md` and makes skills available. This keeps the phase prompt smaller and avoids hardwiring knowledge into TypeScript.

Conceptually:

```ts
const systemPrompt = [
  workflowDocument,
  currentPhaseAgentDocument,
  currentJobContextJson,
].join('\n\n---\n\n')
```

---

## 6. Job Lifecycle

### 6.1 State model

Jobs persist:

- identity and routing (`id`, `type`, `workflowPath`)
- trigger context (`triggerSource`, `params`)
- execution status (`status`, `phase`)
- work-item progress (`workItems`, `currentWorkItem`, `workItemLoopCount`)
- PR mappings and artefacts
- insights and token usage

### 6.2 Typical lifecycle

```text
queued -> planning -> awaiting-plan-approval
       -> coding:{work-item} -> awaiting-pr-merge:{work-item}
       -> testing:{work-item} -> evaluation:{work-item}
       -> [loop or advance]
       -> reporting -> complete | escalated | failed
```

Some jobs may begin in `spec-writing` when triggered from Jira.

### 6.3 Parking and resumption

Jobs are event-driven. When a job needs a PR merge, developer input, or another external event, it parks by storing the awaited event in state. The runner then exits. When the matching webhook or human action arrives, the dispatcher reloads the job and resumes the runner from its saved phase.

This avoids polling and avoids burning CPU while the job waits.

---

## 7. State and Persistence

### 7.1 Supported backends

The runtime supports multiple persistence backends behind a common abstraction:

- **Redis** for the current local/server runtime
- **SQLite** for lightweight local mode
- **Postgres** for cloud and dashboard-oriented state

This abstraction lets the runner stay workflow-driven while the deployment model changes.

### 7.2 Working directory

Each job gets its own working directory under `working/{job-id}/`.

Typical contents include:

- generated plans
- reports and evaluations
- test outputs
- temporary execution state
- checked-out repositories used during the job

This keeps concurrent jobs isolated from one another.

---

## 8. Tool System

### 8.1 Built-in SDK tools

The Claude Agent SDK provides standard code-navigation and editing tools such as:

- file read/write/edit
- shell execution
- glob and grep
- subagents where configured

### 8.2 MCP domain tools

The in-process MCP server exposes business-specific capabilities, including:

- GitHub and BitBucket PR operations
- Jira issue access
- Loki and Tempo queries
- work-item tracking
- job control (`goto_phase`, `await_event`, `escalate`, `log`)
- self-improvement primitives (`add_insight`, `propose_change`, `list_proposals`)

These tools are domain-aware, but still generic with respect to workflow type. The workflow and agents decide when to use them.

---

## 9. Deployment Modes

### 9.1 Local / monolithic mode

Local development runs the Agent Host, Redis, and dashboard-facing APIs together. Webhooks arrive through ngrok or another tunnel.

### 9.2 Cloud-oriented mode

The newer architecture separates:

- local runner execution
- cloud control plane state and dashboard
- authenticated WebSocket communication between them

The same workflow and agent documents remain valid in both modes because the execution contract stays the same.

---

## 10. Security and Control

Key rules:

- credentials are injected via environment or config, never exposed to the model directly
- webhook requests are verified before routing
- self-improvement changes always go through a human-reviewed PR flow
- jobs only operate within their allowed working directory and configured repositories

Humans remain in the approval loop for code changes, PR merges, and intelligence updates.

---

## 11. Glossary

| Term | Meaning |
| --- | --- |
| Job | A unit of work executed by the platform |
| Work item | A tracked slice of work inside a job |
| Workflow | A markdown document that defines ordered phases and agent assignments |
| workflowPath | Relative path to the workflow markdown used by a job, for example `workflows/job/workflow.md` |
| Agent | A markdown-defined procedure for a specific phase role |
| Skill | On-demand guidance loaded by an agent for a domain or language |
| Park | Stop active execution while waiting for an external event |
| Resume | Continue a parked job after the awaited event arrives |
