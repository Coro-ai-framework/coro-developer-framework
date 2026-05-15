---
display_name: Implementation Job — Fast Lane
description: Streamlined 3-phase workflow for tiny, low-risk changes (single file, single endpoint, doc fix, dependency bump). Skips deep analysis, runs a single combined review+merge+verify phase.
kind: job

initial_phase: planning
initial_status: queued

phases:
  - name: planning
    agent: agents/planner.md
    tier: planning
    status: planning

  - name: coding
    agent: agents/coder.md
    tier: coding
    status: coding
    interactive_checkpoint: true
    subagents:
      - name: code-reviewer
        agent: agents/code-reviewer.md
        tier: mini
        tools: [Read, Glob, Grep, Bash, mcp__coro__scm_get_pr_comments, mcp__coro__scm_post_pr_comment, mcp__coro__log]

  - name: review-and-verify
    agent: agents/pr-reviewer.md
    tier: mini
    status: reviewing
    interactive_checkpoint: true
---

# Workflow: Fast-Lane Implementation Job

## Purpose

Ship a **tiny, well-scoped change** — typically 1-3 files in a single service, no
architecture decisions, no cross-service contracts. The Planner classifies the
work and routes to this workflow via `switch_workflow` when the FAST-lane
criteria are met (see `agents/planner.md`, lane router).

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

Anything more goes to STANDARD (`workflows/job/workflow.md`) or DEEP
(`workflows/job-deep/workflow.md`).

## Lane parameter

The Planner sets `params.lane = "fast"` before calling
`switch_workflow({ workflowPath: "workflows/job-fast/workflow.md", … })`.
Downstream agents read `params.lane` to:
- Run only the L1 + L2 lenses in the `code-reviewer` subagent.
- Skip the `cross-cutting-review` skill in the reviewer.
- Combine merge + acceptance verification in `review-and-verify`.

## Phases

### Phase 1: Planning

**Agent:** Planner (`agents/planner.md`)

The planner has already classified this job as FAST before running this
workflow. Its job here is reduced to:

1. Confirm the change still fits the FAST-lane criteria (re-check after reading
   the repo). If it has grown, call `switch_workflow` to move back to STANDARD
   or DEEP and end the turn.
2. Detect the language and call `set_job_params({ language })`.
3. Register a single work item via `set_work_items` (no decomposition).
4. Skip the long-form implementation-plan artefact — a one-paragraph rationale
   logged via `mcp__coro__log` is enough for FAST.

### Phase 2: Coding

**Agent:** Coder (`agents/coder.md`)
**Subagent:** `code-reviewer` (lenses L1 + L2 only, modulated by `params.lane`)

Standard coding flow with a leaner reviewer pass. The coder:

1. Implements the change.
2. Builds + runs tests locally.
3. Invokes `code-reviewer` (which honours `params.lane === "fast"` and runs
   only conventions/plan/tests + scope/traceability lenses).
4. Opens the PR with the subagent's verdict in the description.

### Phase 3: Review-and-Verify (combined gatekeeper + verifier)

**Agent:** PR Reviewer (`agents/pr-reviewer.md`) — extended for FAST lane

This phase combines the work that STANDARD splits across `review` and
`evaluation`, because for a tiny change the cost of two phases is not paid back
by the extra checks. The agent:

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
