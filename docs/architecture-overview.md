# AI Agent Platform: High-Level Overview

**Audience:** Anyone who wants to understand how the system works  
**Last updated:** 2026-04-14

---

## What is this?

An internal AI agent platform that automates engineering workflows — currently **generic implementation jobs** in any language plus internal **self-update** jobs for the intelligence layer. New workflows and languages can be added without infrastructure changes.

The platform uses **Claude** (Anthropic's LLM) as its reasoning engine, driven by a lightweight **Agent Host Service** that manages jobs and tools. The key design principle:

> **Markdown files are the intelligence. TypeScript is just the plumbing.**  
> All workflow logic, decision-making, and accumulated knowledge live in Markdown files. The infrastructure simply runs phases, provides tools, and stores state.

---

## How it works

```
  Developer runs CLI command          Jira ticket assigned          BitBucket webhook
  (a5 job ...)                        to AI agent                   (PR merged, comment, etc.)
              │                              │                              │
              └──────────────────────────────┼──────────────────────────────┘
                                             ▼
                                    ┌─────────────────┐
                                    │   Agent Host     │  TypeScript service (always running)
                                    │   Service        │  Receives triggers, manages jobs
                                    └────────┬────────┘
                                             │
                          ┌──────────────────┼──────────────────┐
                          ▼                  ▼                  ▼
                   ┌────────────┐    ┌─────────────┐    ┌─────────────────┐
                   │   Redis    │    │  Claude SDK  │    │  Markdown Files │
                   │ Job state  │    │  Runs agents │    │  (the brains)   │
                   └────────────┘    └─────────────┘    └─────────────────┘
```

1. A **trigger** starts a job — CLI command, Jira ticket, or webhook event.
2. The Agent Host creates a **Job** and looks up the matching **Workflow** (a Markdown file with YAML config defining the sequence of phases).
3. For each phase, the Host assembles a lightweight prompt from the workflow, agent instructions, and accumulated memory, then hands it to Claude. Static intelligence (behavior rules, company context, git conventions) is loaded natively by the SDK via `.claude/CLAUDE.md`, and domain knowledge and coding conventions are available as on-demand skills.
4. Claude executes the phase: reading code, writing code, calling tools (BitBucket, Loki, Jira, etc.), and making decisions.
5. When a job needs to wait for something external (e.g. a PR review), it **parks** in Redis and resumes automatically when the webhook arrives.

---

## The intelligence layer

All agent behavior is defined in Markdown files, organized into four layers:

| Layer | What it contains | How it changes |
|-------|-----------------|----------------|
| **Always-loaded context** (`.claude/CLAUDE.md`) | Behavior rules, company context, git conventions, infrastructure | Humans edit directly |
| **Agents** (`agents/`) | Step-by-step procedures for each role (coder, tester, reviewer, etc.) | Agents can propose updates via PR |
| **Workflows** (`workflows/`) | Phase sequences, agent assignments, model selection | Humans edit directly |
| **Skills** (`.claude/skills/`) | Domain knowledge (implementation planning and testing) and language conventions (Go, .NET) — invoked on-demand | Agents can propose updates via PR |
| **Memory** (`memory/`) | Lessons learned from past jobs — pitfalls, successful patterns, PR feedback | Grows automatically, reviewed via PR |

Agents are **generic** — the same coder agent handles Go, .NET, and TypeScript. It becomes specialized by invoking the relevant skills on-demand during execution.

---

## Workflows

### Generic implementation job

```
[Spec Writing] → Planning → [Code → Review → Test → Evaluate]
```

Triggered by CLI or Jira ticket. The planner turns the request into work items, and the runtime loops through coding, review, testing, and evaluation until those work items are done.

---

## Key concepts

**Jobs park, not poll.** When a job waits for a PR merge or human review, it saves state to Redis and shuts down. When the webhook arrives, it resumes exactly where it left off. Zero CPU while waiting.

**Self-improvement.** Agents record insights during their work. The Evaluator reviews all insights at the end and can propose changes to the Markdown files (memory, skills, agents). Every proposal goes through a PR — humans always approve before changes take effect.

**Language-agnostic.** Supporting a new language means adding one convention skill. No infrastructure changes.

**Two BitBucket accounts.** `@a5-coder-agent` (writes code, opens PRs) and `@a5-reviewer-agent` (reviews, approves, merges). They show up in PRs like normal team members.

**Concurrent jobs.** Multiple developers can run workflows simultaneously. Each job has isolated working directories and state.

---

## Tools available to agents

Agents have access to ~30 domain-specific tools plus standard file/shell operations:

- **BitBucket** — create repos, open PRs, post reviews, merge
- **Observability** — query Loki logs and Tempo traces
- **Jira** — read tickets, post comments, transition issues
- **Testing** — build services, run comparison tests
- **Job control** — manage phases, park/resume, escalate to humans
- **Self-improvement** — record insights, propose changes to agent knowledge

---

## Deployment

- **Local dev:** Docker Compose (Agent Host + Redis + ngrok for webhooks)
- **Production:** Kubernetes with managed Redis, stable ingress URL for webhooks

Moving between environments only requires updating webhook URLs and providing credentials — no code changes.

---

## In one sentence

AI agents — defined entirely in Markdown — autonomously plan, code, test, review, and ship scoped changes through structured workflows, learning and improving from every job they run, with humans always in the approval loop.
