---
display_name: Implementation Job — Deep Lane
description: Use only for genuinely high-stakes changes that need an explicit architecture step before coding — brand-new public API surface, security/auth changes, irreversible or downtime-risking data migrations, or contracts that span multiple services. Routine refactors, regular bug fixes, scoped feature work, and standard reversible schema changes belong on the default Implementation Job lane. Adds analysis (architecture decisions) and qa (verification) phases either side of coding/review.
kind: job

initial_phase: spec-writing
initial_status: queued

phases:
  - name: spec-writing
    agent: agents/spec-writer.md
    tier: coding
    status: spec-writing
    interactive_checkpoint: true

  - name: analysis
    agent: agents/analyzer.md
    tier: planning
    status: analyzing
    interactive_checkpoint: true

  - name: planning
    agent: agents/planner.md
    tier: planning
    status: planning
    interactive_checkpoint: true

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

  - name: review
    agent: agents/pr-reviewer.md
    tier: mini
    status: reviewing
    interactive_checkpoint: true

  - name: qa
    agent: agents/qa.md
    tier: planning
    status: qa
    interactive_checkpoint: true

  - name: evaluation
    agent: agents/evaluator.md
    tier: planning
    status: evaluating
    interactive_checkpoint: true

# No overrides needed — DEEP always starts at spec-writing for both CLI
# and tracker-triggered jobs.
---

# Workflow: Deep-Lane Implementation Job

## Purpose

Implement a **high-risk or cross-cutting change** that needs explicit
architectural reasoning before any code is written, and explicit QA after
merge. Examples:
- New public API endpoint or breaking change to an existing one
- Schema migration or data-shape change
- Security-sensitive surface (auth, authz, secrets, PII handling)
- Cross-cutting hygiene work (observability, logging, error handling)
- Multi-file refactor that touches a shared abstraction

## Difference vs the standard job workflow

| Phase | STANDARD | DEEP |
|---|---|---|
| `spec-writing` | tracker-triggered only | **always** (CLI too — gives the analysis phase something concrete to react to) |
| `analysis` | _absent_ | **new** — architecture decisions before planning |
| `planning` | as today | as today, but consumes `design-notes.md` from analysis |
| `coding` | reviewer L1+L2+L3+L4 | reviewer L1+L2+L3+L4 (same lens set as STANDARD) |
| `review` | drives per-WI loop (merge → next WI → coding) | drives per-WI loop **identically** (merge → next WI → coding) |
| `qa` | _absent_ | **new** — runs **once** on the fully-merged base, after every work item is `complete` |
| `evaluation` | combined verify + insights + proposals, runs **once** | insights + proposals only (qa already verified), runs **once** |

**Per-work-item loop ownership in DEEP is the merge gatekeeper, not the evaluator.** `qa` and `evaluation` are each end-of-job phases that run a single time against the fully-merged base. If they discover a regression that warrants a fix, they route back to `coding` for that specific work item — the gatekeeper then re-drives the per-WI loop until the fix lands, and `qa` runs again. Running `qa` and `evaluation` per work item is **not** the design: cross-WI contracts can only be verified once the last PR has merged, and per-WI runs would multiply planning-tier cost without buying signal.

## Lane parameter

The Planner (or an explicit `switch_workflow` call) sets
`params.lane = "deep"`. Downstream agents use this to:
- Run the full lens set in the `code-reviewer` subagent (L1-L4).
- Invoke the `cross-cutting-review` skill in the reviewer.
- Split verification (qa) from insight curation (evaluation).

## Phases

### Phase 0: Spec Writing

**Agent:** Spec Writer (`agents/spec-writer.md`)

DEEP runs the spec-writer for **CLI-triggered jobs too**, not only tracker-
triggered ones. The analysis phase that follows needs a concrete spec; the
typical free-form CLI description is not enough.

Output: `working/{job-id}/feature-spec.md`.

### Phase 1: Analysis

**Agent:** Analyzer (`agents/analyzer.md`) — a dedicated agent, **not**
the Planner running in analysis mode.
**Skills:** Analyzer invokes `feature-planning`, `register-convention`,
the relevant language conventions skill, and `cross-cutting-review` at
the design level.

Goal: produce **design notes** before any work item is sequenced. Output:
`working/{job-id}/design-notes.md` containing at minimum:

- Architecture decisions (ADR-style: context, decision, alternatives,
  consequences) for any shared abstraction, public API, or schema being
  introduced or changed.
- Identified contracts (API shapes, message formats, schema deltas)
  with the test that will prove each contract holds.
- Risk register (what can break, blast radius, rollback plan).
- Cross-cutting checklist (security, perf, observability, dep hygiene).

The Analyzer also seeds `register.json`'s `decisions[]` and
`contracts[]` arrays so the Coder and the Code Reviewer treat them as
load-bearing. End the turn after writing design-notes — do **not** call
`set_work_items` here. The next phase (planning) does the decomposition
with design-notes as input.

### Phase 2: Planning

**Agent:** Planner (`agents/planner.md`)

Same as the standard job's planning phase, but the planner reads
`design-notes.md` first and treats its decisions as load-bearing — the
work-item sequence must respect the contracts and risk register that came out
of analysis.

### Phase 3: Coding

**Agent:** Coder (`agents/coder.md`)
**Subagent:** `code-reviewer` (full lens set L1-L4)

Standard coding flow. The reviewer subagent reads `params.lane === "deep"` and
applies all four lenses, including the `cross-cutting-review` skill.

### Phase 4: Review (merge gatekeeper, per work item)

**Agent:** PR Reviewer (`agents/pr-reviewer.md`)

Identical to the standard job workflow's `review` phase: thin gatekeeper
that routes change requests back to coding, waits for approval, merges,
and **drives the per-work-item loop**. After every PR for the current
work item is merged, the gatekeeper closes the work item and either:
- Calls `request_new_session` + `goto_phase("coding")` for the next
  pending work item, OR
- Ends its turn so the runner advances to `qa` — **only when every work
  item is `complete` or `escalated`**.

Running `qa` and `evaluation` per work item is explicitly **not** the
design — the gatekeeper owns the WI loop in DEEP exactly the same way
it does in STANDARD.

### Phase 5: QA (verify the fully-merged result, runs ONCE)

**Agent:** QA (`agents/qa.md`) — a dedicated agent, **not** the Evaluator
running in QA mode.
**Skills:** `feature-testing` (which indexes the unit / integration /
contract / e2e tier sub-skills).

This phase runs **once** per job, after the gatekeeper has driven every
work item to `complete`. It verifies the **whole plan** against the
fully-merged base branch — including cross-work-item contracts that can
only be exercised once every PR has landed.

1. **Precondition guard.** Call `get_work_items` first. If any work
   item is still `pending` or `in-progress`, you arrived prematurely:
   route back to the right phase (`coding` for unstarted work, `review`
   for unmerged PRs) and end the turn without doing verification. Do
   **not** run build/test against a partial merge.
2. Verify the CI pipeline is green on every merged PR. If any is
   pending, await the CI event. If any is red, route back to coding
   without re-running locally.
3. Check out the merged base branch (not the per-WI branch).
4. Run build + the full existing-test suite.
5. Verify each acceptance criterion from `implementation-plan.md`
   across the entire plan, and each architectural commitment from
   `design-notes.md`. Record pass/fail with diffs.
6. Verify each contract in `register.json` introduced this job has the
   test that proves it holds. Cross-WI contracts get explicit
   attention — they are the main reason qa lives in its own phase.
7. Query Loki/Tempo for runtime errors during verification (when
   applicable).
8. Decision:
   - **Pass:** end the turn — the runner advances to `evaluation`.
   - **Fix needed:** identify which work item's contract is broken,
     call `update_work_item(name, incrementLoop: true)` and
     `goto_phase("coding")` with a focused fix brief. The gatekeeper
     will merge the fix PR and `qa` will run again on the new merged
     state.
   - **Escalate:** loop count >= 5 on any work item, or a structural
     blocker.

QA produces `working/{job-id}/qa-report.md` for the dashboard and the
Evaluator.

### Phase 6: Evaluation (insights + proposals, runs ONCE)

**Agent:** Evaluator (`agents/evaluator.md`)

QA already verified the merged result, so this phase is reduced to
insight curation and proposal authoring. It runs **once** at the end of
the job and does **not** drive the per-work-item loop — that's the
gatekeeper's job.

1. **Precondition guard.** Call `get_work_items` first. If any work
   item is still `pending` or `in-progress`, route back to `coding`
   (unstarted work) or `review` (unmerged PRs) per the evaluator
   agent's standard guard. Do not curate insights against an
   incomplete plan.
2. Curate insights collected across all phases.
3. Write up to one `propose_change` per writable layer (tenant, repo)
   for any memory updates, skill updates, or agent updates that the
   evaluator believes warrant human review.

## Error handling

Same as the standard job workflow. Prefer to escalate over silent down-shifting
— the planner picked DEEP for a reason; if a phase fails, that reason needs
human attention.
