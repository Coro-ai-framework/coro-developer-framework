---
display_name: Implementation Job — Fast Lane
description: Use only for tiny, single-touch changes — a doc/comment fix, a dependency bump, a single-file tweak, a one-endpoint change with no design questions. Anything that touches multiple files or needs even a small plan belongs on the default Implementation Job lane. Streamlined 3 phases — skips spec/analysis, runs a single combined review+merge+verify phase.
kind: job
argument-hint: "<what to build, fix, or review>"

initial_phase: planning
initial_status: queued

phases:
  - name: planning
    agent: .claude/agents/planner.md
    tier: planning
    status: planning

  - name: coding
    agent: .claude/agents/coder.md
    tier: coding
    status: coding
    interactive_checkpoint: true
    subagents:
      - name: code-reviewer
        agent: .claude/agents/code-reviewer.md
        tier: mini
        tools: [Read, Glob, Grep, Bash, mcp__coro__scm_get_pr_comments, mcp__coro__scm_post_pr_comment, mcp__coro__log]

  - name: review-and-verify
    agent: .claude/agents/pr-reviewer.md
    tier: mini
    status: reviewing
    interactive_checkpoint: true
---

<!-- standalone:start -->
## Run this workflow in Claude Code

You are the orchestrator. A Claude Code subagent cannot start other subagents or ask the user a question, so you sequence the phases below yourself, delegate each one to the named subagent with the Task tool, and relay any questions a subagent returns to the user. Follow "Running without the Coro runner" in `.claude/CLAUDE.md` for tool substitutions.

Request: $ARGUMENTS

Setup:

1. Pick a short `<run-slug>` for this request and create `.coro-work/<run-slug>/`. Every spec, plan and report goes there.
2. The current repository is the checkout. Do not clone anything.
3. Give each subagent the request text, the work directory path, and the paths of the files earlier phases wrote. Subagents start with no memory of this conversation.
4. A **checkpoint** means: summarise what the phase produced, list the files it wrote, ask the user to approve or to request changes, and wait. If they request changes, re-run the same subagent with their feedback.

Run the phases in this order:

1. **planning**: delegate to `planner`. For this lane it registers a single work item and writes a one-paragraph rationale instead of a long plan. If the change has outgrown the fast lane, stop and ask the user whether to switch to `/coro:job` or `/coro:job-deep`. There is no checkpoint after planning on this lane.
2. **coding**: delegate to `coder` for the work item. It implements, builds and tests on a branch and writes the PR title and description to `.coro-work/<run-slug>/pr-preview-1.md`. Tell it not to push and not to open a pull request.
3. **code review**: run `code-reviewer` on the diff, naming the base branch in its task. On this lane it applies only its own L1 and L2 checklists (conventions, plan, tests, scope); do not start the `review-*` agents. Hand every blocking finding back to `coder`. Checkpoint (pre-PR gate: show the diff and the proposed pull request).
4. **review-and-verify**: with the user's consent only, push the branch and open the pull request, then delegate to `pr-reviewer`. It coordinates review comments, merges only after the user explicitly approves, and then re-runs build and tests on the merged result and checks the acceptance criteria. If verification fails, stop and report; do not fall back to another lane silently. Checkpoint.
<!-- standalone:end -->

# Workflow: Fast-Lane Implementation Job

## Purpose

Ship a **tiny, well-scoped change** — typically 1-3 files in a single service, no
architecture decisions, no cross-service contracts. The Planner classifies the
work and routes to this workflow via `switch_workflow` when the FAST-lane
criteria are met (see `.claude/agents/planner.md`, lane router).

This workflow trades the two intermediate phases of the standard job pipeline
(separate `review` gatekeeping and `evaluation` verification) for one combined
**review-and-verify** phase. It is **not** a license to skip safety steps —
build/test still run, the code-reviewer subagent still runs (a leaner lens
set), and the human reviewer still approves before merge.

## When the planner picks this lane

All of:
- ≤ 3 files changed (best estimate)
- 0 new public API endpoints, 0 schema changes, 0 cross-service contracts
- Risk = low (touched files have existing tests; rollback is trivial)
- No work-item splitting needed

Anything more goes to STANDARD (`.claude/commands/coro/job.md`) or DEEP
(`.claude/commands/coro/job-deep.md`).

## Lane parameter

The Planner sets `params.lane = "fast"` before calling
`switch_workflow({ workflowPath: ".claude/commands/coro/job-fast.md", … })`.
Downstream agents read `params.lane` to:
- Run only the L1 + L2 lenses in the `code-reviewer` subagent.
- Skip the `cross-cutting-review` skill in the reviewer.
- Combine merge + acceptance verification in `review-and-verify`.

## Phases

### Phase 1: Planning

**Agent:** Planner (`.claude/agents/planner.md`)

The planner has already classified this job as FAST before running this
workflow. Its job here is reduced to:

1. Confirm the change still fits the FAST-lane criteria (re-check after reading
   the repo). If it has grown, call `switch_workflow` to move back to STANDARD
   or DEEP and end the turn. When `params.planContextDir` is set, read
   `{planContextDir}/findings.md` first — it is the plan-mode investigation
   this run came from.
2. Detect the language and call `set_job_params({ language })`.
3. Register a single work item via `set_work_items` (no decomposition).
4. Skip the long-form implementation-plan artefact — a one-paragraph rationale
   logged via `mcp__coro__log` is enough for FAST.

### Phase 2: Coding

**Agent:** Coder (`.claude/agents/coder.md`)
**Subagent:** `code-reviewer` (lenses L1 + L2 only, modulated by `params.lane`)

Standard coding flow with a leaner reviewer pass. The coder:

1. Implements the change.
2. Builds + runs tests locally.
3. Invokes `code-reviewer` (which honours `params.lane === "fast"` and runs
   only conventions/plan/tests + scope/traceability lenses).
4. Pushes the branch and posts a `pr-preview` artefact (proposed title +
   description incl. the subagent's verdict). It does **not** open the PR —
   the `review-and-verify` phase opens it after the coding interactive
   checkpoint, so the developer can preview the change first.

### Phase 3: Review-and-Verify (combined gatekeeper + verifier)

**Agent:** PR Reviewer (`.claude/agents/pr-reviewer.md`) — extended for FAST lane

This phase combines the work that STANDARD splits across `review` and
`evaluation`, because for a tiny change the cost of two phases is not paid back
by the extra checks. The agent:

0. **Opens the PR** for the work item from the coder's pushed branch +
   `pr-preview` artefact via `scm_create_pr`, and posts the `pr-link` artefact.
1. Reads PR state and human comments.
2. Routes blocking change requests back to coding via `goto_phase("coding")`.
3. Waits for human approval (`await_event` on `pr:approved`).
4. **Merges** when approval and CI conditions are met.
5. **Verifies** the merged result: re-run build + tests, confirm acceptance
   criteria from the work item.
6. Records cross-PR feedback patterns to memory and consolidates a single
   `propose_change` per layer if any insights warrant it.

If verification fails, escalate — do **not** silently fall back to STANDARD.
That defeats the whole point of having sized the work in advance.

## Error handling

Same as the standard job workflow. On any escalation, log the lane and the
trigger so the planner's classification accuracy can be reviewed.
