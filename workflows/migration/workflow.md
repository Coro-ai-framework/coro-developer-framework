---
initial_phase: init
initial_status: queued

phases:
  - name: init
    agent: ~
    model: coding
    status: initializing

  - name: analysis
    agent: agents/analyzer.md
    model: planning
    status: analyzing

  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning
    interactive_checkpoint: true

  - name: repo-setup
    agent: agents/coder.md
    model: coding
    status: repo-setup

  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
    interactive_checkpoint: true
    subagents:
      - name: code-reviewer
        agent: agents/pr-reviewer.md
        model: coding
        tools: [Read, Glob, Grep, mcp__a5__bb_get_pr_comments, mcp__a5__bb_post_pr_comment, mcp__a5__log]

  - name: review
    agent: agents/pr-reviewer.md
    model: coding
    status: reviewing
    interactive_checkpoint: true

  - name: testing
    agent: agents/tester.md
    model: coding
    status: testing
    interactive_checkpoint: true
    subagents:
      - name: test-runner
        agent: agents/tester.md
        model: coding
        tools: [Bash, Read, mcp__a5__run_go_build, mcp__a5__compare_request, mcp__a5__log]

  - name: evaluation
    agent: agents/evaluator.md
    model: planning
    status: evaluating
    interactive_checkpoint: true

  - name: reporting
    agent: agents/planner.md
    model: coding
    status: reporting
    interactive_checkpoint: true
---

# Workflow: .NET to Go Migration

## Purpose

End-to-end migration of a .NET microservice to Go. Produces a fully functional Go service that is a behavioral replica of the .NET service, with a BitBucket repository, PR history, test results, and a migration report.

## How this workflow runs

This workflow is executed by the **Agent Host Service** — not interactively. The Agent Host:
1. Receives a job request from the `a5` CLI
2. Loads this file and the relevant agent MD files as system prompts
3. Calls the Claude API in a loop, dispatching tool calls, until the workflow reaches `complete`
4. Parks the job and resumes it when BitBucket webhook events arrive (PR merge, comments, approvals)

Developers monitor progress via `a5 status --job {service}-migration` or the live stream in the terminal.

See [docs/architecture.md](../../docs/architecture.md) for the full system design.

## Trigger

The user provides via the CLI:
- `.NET repo slug` (BitBucket)
- `Projects to migrate` (comma-separated list of C# project names)
- `PR reviewers` (BitBucket usernames)
- `Staging base URL` (the .NET service's staging URL)
- `Service name` (used for file paths, repo naming, helm config lookup)

## Language handling

This workflow uses two languages: the **source** language (.NET/C#) for analysis, and the **target** language (Go) for coding. The init phase sets `job.params.language` to the source language. The planner then updates it to the target language (via `set_job_params`) after producing the plan. Agents invoke the relevant language conventions skill (e.g., `golang-conventions`) and domain knowledge skills (e.g., `migration-coding`) on-demand during their phases.

## State

All intermediate state is written to `working/{service-name}/`. This directory persists across sessions so work can be resumed if interrupted.

Feature state is tracked in Redis via the `features[]` array on the Job object. Agents use `get_features`, `update_feature`, and `set_features` to manage feature progress.

## Phases

> **Checkpoint reminder:** Phases flagged `interactive_checkpoint: true` expect you — the agent — to call `await_event({ eventName: "developer-input: <reason>" })` at the end of the phase when `job.interactive` is `true`. The runner does not auto-park. See `.claude/CLAUDE.md` → "Interactive mode — agent-driven checkpoints".

---

### Phase 0: Initialization

1. Call `read_memory` to load `MEMORY.md`, every file it links, and any pending proposals. The system prompt no longer carries memory — you must pull it yourself at job start.
2. Read `config/credentials.md` — verify BitBucket credentials are present; halt if not
3. Read `config/repos.md` — look up the service entry if it exists; create/update it if not
4. Create `working/{service-name}/` directory
5. Write `working/{service-name}/job.md` with the job parameters and start timestamp
6. Clone the .NET repo locally for analysis
7. Set `job.params.language` to the source language (e.g., `dotnet`) via `set_job_params` so the analyzer gets the right conventions

---

### Phase 1: Analysis

**Agent:** Analyzer (`agents/analyzer.md`)
**Skills:** Agent invokes `migration-analysis` for domain knowledge

Run the Analyzer agent with the cloned repo and job parameters.

**Completion check:** All four output files exist and are non-empty:
- `working/{service-name}/service-contract.json`
- `working/{service-name}/dependencies.json`
- `working/{service-name}/traffic-baseline.json` (or a note that Loki was unavailable)
- `working/{service-name}/analysis-notes.md`

---

### Phase 2: Planning

**Agent:** Planner (`agents/planner.md`)
**Skills:** Agent invokes `migration-planning` for domain knowledge

Run the Planner agent with the Analyzer outputs.

The Planner must:
1. Produce `working/{service-name}/migration-plan.md` with at least 1 feature
2. Call `set_features` to register the feature list with the job
3. Call `set_job_params({ language: "golang" })` to switch to the target language for all downstream phases

**Human checkpoint:** This phase is flagged `interactive_checkpoint: true`. If `job.interactive` is `true`, post the plan artefact and then call `await_event({ eventName: "developer-input: approval of migration plan" })` before ending your turn. The runner does NOT auto-park — you must park explicitly. If `job.interactive` is `false`, skip the park and let the runner advance to repo-setup.

---

### Phase 3: Repository Setup

**Agent:** Coder (`agents/coder.md`)
**Skills:** Agent invokes language conventions skill (e.g., `golang-conventions`) for the target language

Before beginning feature implementation:

1. Create the target repository on BitBucket: `{service-name}-go`
2. Initialize with the target language project template
3. Push the initial commit to `main`
4. Update `config/repos.md` with the new repo slug

---

### Phase 4-7: Feature Implementation Loop

The coding → review → testing → evaluation cycle repeats for each feature in the migration plan. This loop is driven by the **Evaluator agent** — not by the runner infrastructure. The runner simply advances linearly through phases; the Evaluator uses `goto_phase` to loop back when needed.

#### How the loop works:

1. **Coder** calls `get_features`, finds the next `pending` feature, calls `update_feature` to mark it `in-progress`, implements it, opens the PR
2. **PR Reviewer** reviews, coordinates fixes, waits for approval, merges
3. **Tester** builds and runs comparison tests, writes results
4. **Evaluator** reads results and decides:
   - **Feature complete:** call `update_feature(name, status: "complete")`. Then call `get_features` — if more features remain, call `request_new_session` (fresh context for the next feature) then `goto_phase("coding")`. If no features remain, finish (runner auto-advances to reporting).
   - **Fix needed:** call `update_feature(name, incrementLoop: true)`. Check `loopCount` — if >= 5, call `escalate`. Otherwise call `goto_phase("coding")` with a fix brief.
   - **Blocked:** call `escalate` with diagnosis.

---

### Phase 8: Migration Report

When all features are `complete` (or `escalated` with user acknowledgment):

Generate `working/{service-name}/migration-report.md` using `workflows/migration/report-template.md`.

The report must include:
- Every endpoint: migrated / with-deviation / escalated
- Test coverage summary per endpoint
- All memory entries created during this migration
- Known deviations from the source contract (with justifications)
- How to validate the service before cutover
- Recommended smoke test suite for the load balancer cutover

---

## Resuming interrupted workflows

If a workflow was interrupted, read `working/{service-name}/job.md` and call `get_features` to determine which phase and feature to resume from. Do not re-run completed phases or features.

## Error handling

- If any agent produces an error it cannot self-resolve, it calls `escalate` with a specific description
- Network failures (BitBucket API, Loki, Tempo) are retried up to 3 times before surfacing
- If staging is unreachable, the Tester skips comparison tests and notes all tests as `skipped` with reason
