---
initial_phase: init
initial_status: queued

phases:
  - name: init
    agent: ~
    model: planning
    status: initializing

  - name: analysis
    agent: agents/analyzer.md
    model: planning
    status: analyzing

  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning

  - name: repo-setup
    agent: agents/coder.md
    model: coding
    status: repo-setup

  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
    subagents:
      - name: code-reviewer
        agent: agents/pr-reviewer.md
        model: coding
        tools: [Read, Glob, Grep, mcp__a5__bb_get_pr_comments, mcp__a5__bb_post_pr_comment, mcp__a5__log]

  - name: review
    agent: agents/pr-reviewer.md
    model: coding
    status: coding

  - name: testing
    agent: agents/tester.md
    model: coding
    status: testing
    subagents:
      - name: test-runner
        agent: agents/tester.md
        model: coding
        tools: [Bash, Read, mcp__a5__run_go_build, mcp__a5__compare_request, mcp__a5__log]

  - name: evaluation
    agent: agents/evaluator.md
    model: planning
    status: evaluating

  - name: reporting
    agent: agents/planner.md
    model: planning
    status: reporting
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

## State

All intermediate state is written to `working/{service-name}/`. This directory persists across sessions so work can be resumed if interrupted.

## Phases

---

### Phase 0: Initialization

1. Read `memory/MEMORY.md` and all referenced memory files
2. Read `config/credentials.md` — verify BitBucket credentials are present; halt if not
3. Read `config/repos.md` — look up the service entry if it exists; create/update it if not
4. Create `working/{service-name}/` directory
5. Write `working/{service-name}/job.md` with the job parameters and start timestamp
6. Clone the .NET repo locally for analysis

---

### Phase 1: Analysis

**Agent:** Analyzer (`agents/analyzer.md`)

Run the Analyzer agent with the cloned repo and job parameters.

**Completion check:** All four output files exist and are non-empty:
- `working/{service-name}/service-contract.json`
- `working/{service-name}/dependencies.json`
- `working/{service-name}/traffic-baseline.json` (or a note that Loki was unavailable)
- `working/{service-name}/analysis-notes.md`

---

### Phase 2: Planning

**Agent:** Planner (`agents/planner.md`)

Run the Planner agent with the Analyzer outputs.

**Completion check:** `working/{service-name}/migration-plan.md` exists and contains at least 1 feature.

**Human checkpoint (optional):** Present the migration plan to the user for review before proceeding. Ask: "Does this plan look right? Should any features be reordered, split, or merged?"

---

### Phase 3: Go Repository Setup

Before beginning feature implementation:

1. Create the Go repository on BitBucket: `{service-name}-go`
2. Initialize with the Go project template from `tools/src/` scaffolding
3. Push the initial commit to `main`
4. Update `config/repos.md` with the new Go repo slug

---

### Phase 4: Feature Implementation Loop

For each feature in `working/{service-name}/migration-plan.md` (in order):

#### 4a. Code

**Agent:** Coder (`agents/coder.md`)

- Check that all dependency features are in `merged` status before starting
- Run the Coder agent for this feature
- Coder creates the branch and opens the PR

#### 4b. Review

**Agent:** PR Reviewer (`agents/pr-reviewer.md`)

- Activate the PR Reviewer agent with the PR URL
- PR Reviewer monitors the PR, coordinates with Coder on feedback, and waits for human approval
- This phase completes when the PR is merged

#### 4c. Test

**Agent:** Tester (`agents/tester.md`)

- Run the Tester agent after merge
- Tester builds the service, runs comparison tests against staging
- Outputs `working/{service-name}/test-results/{feature-name}.json`

#### 4d. Evaluate

**Agent:** Evaluator (`agents/evaluator.md`)

- Run the Evaluator on the test results
- Evaluator updates memory and writes `working/{service-name}/evaluations/{feature-name}.md`
- **Decision:**
  - If `complete`: mark feature as complete in migration plan, proceed to next feature
  - If `loop-back`: run Coder again with the fix brief, then Tester, then Evaluator (max 5 loops)
  - If `escalate` (5 loops exceeded): pause workflow and present diagnosis to user

#### 4e. Feature status tracking

Update the feature status in `working/{service-name}/migration-plan.md`:
- `pending` → `in-progress` → `merged` → `tested` → `complete` | `escalated`

---

### Phase 5: Migration Report

When all features are `complete` (or `escalated` with user acknowledgment):

Generate `working/{service-name}/migration-report.md` using `workflows/migration/report-template.md`.

The report must include:
- Every endpoint: migrated / with-deviation / escalated
- Test coverage summary per endpoint
- All memory entries created during this migration
- Known deviations from the .NET contract (with justifications)
- How to validate the service before cutover
- Recommended smoke test suite for the load balancer cutover

---

## Resuming interrupted workflows

If a workflow was interrupted, read `working/{service-name}/job.md` and `working/{service-name}/migration-plan.md` to determine which phase and feature to resume from. Do not re-run completed phases.

## Error handling

- If any agent produces an error it cannot self-resolve, it writes the error to `working/{service-name}/errors.md` and surfaces it to the user
- Network failures (BitBucket API, Loki, Tempo) are retried up to 3 times before surfacing
- If staging is unreachable, the Tester skips comparison tests and notes all tests as `skipped` with reason
