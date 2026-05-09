---
display_name: Implementation Job — Deep Lane
description: Extended workflow for high-risk or cross-cutting changes (new public API, schema migration, security-sensitive surface, multi-service contract). Adds explicit analysis (architecture decisions) and qa (verification) phases on either side of standard coding/review.
kind: job

initial_phase: planning
initial_status: queued

phases:
  - name: spec-writing
    agent: agents/spec-writer.md
    model: planning
    status: spec-writing

  - name: analysis
    agent: agents/planner.md
    model: planning
    status: analyzing
    interactive_checkpoint: true

  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning
    interactive_checkpoint: true

  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
    interactive_checkpoint: true
    subagents:
      - name: code-reviewer
        agent: agents/code-reviewer.md
        model: coding
        tools: [Read, Glob, Grep, Bash, mcp__coro__scm_get_pr_comments, mcp__coro__scm_post_pr_comment, mcp__coro__log]

  - name: review
    agent: agents/pr-reviewer.md
    model: coding
    status: reviewing
    interactive_checkpoint: true

  - name: qa
    agent: agents/evaluator.md
    model: planning
    status: qa
    interactive_checkpoint: true

  - name: evaluation
    agent: agents/evaluator.md
    model: planning
    status: evaluating
    interactive_checkpoint: true

overrides:
  jira:
    initial_phase: spec-writing
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
| `review` | as today | as today |
| `qa` | _absent_ | **new** — focused build/test/acceptance verification |
| `evaluation` | combined verify + insights + proposals | insights + proposals only (qa already verified) |

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

**Agent:** Planner (`agents/planner.md`) running in analysis mode
**Skills:** Agent should invoke `feature-planning` for system-level reasoning;
when available, `cross-cutting-review` for security/perf/observability prompts.

Goal: produce **design notes** before any work item is sequenced. Output:
`working/{job-id}/design-notes.md` containing at minimum:

- Architecture decisions (ADR-style: context, decision, consequences) for any
  shared abstraction, public API, or schema being introduced or changed
- Identified contracts (API shapes, message formats, schema deltas)
- Risk register (what can break, blast radius, rollback plan)
- Cross-cutting checklist (security, perf, observability, dependency hygiene)

Also call `post_artifact({ kind: "design-notes-md", title, data: { path: "design-notes.md" } })`.

End the turn after writing design-notes — do **not** also call
`set_work_items` here. The next phase (planning) does the decomposition with
design-notes as input.

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

### Phase 4: Review (merge gatekeeper)

**Agent:** PR Reviewer (`agents/pr-reviewer.md`)

Identical to the standard job workflow's `review` phase: thin gatekeeper that
routes change requests back to coding, waits for approval, merges.

### Phase 5: QA (verify the merged result)

**Agent:** Evaluator (`agents/evaluator.md`) running in QA mode
**Skills:** `feature-testing` for verification heuristics

1. Check out the merged branch.
2. Re-run build + the full test suite (`build_status`, `existing_tests_status`).
3. **Verify the CI pipeline is green** on the merged commit (call
   `mcp__coro__scm_get_pr_status` or the upstream CI tool — do not re-run tests
   to substitute for missing CI signal).
4. Verify each acceptance criterion from `implementation-plan.md` and each
   architectural commitment from `design-notes.md`. Record pass/fail with
   diffs.
5. Query Loki/Tempo for runtime errors during verification (when applicable).
6. Decision:
   - **Pass:** end the turn — the runner advances to `evaluation`.
   - **Fix needed:** call `update_work_item(name, incrementLoop: true)` and
     `goto_phase("coding")` with a focused fix brief.
   - **Escalate:** loop count >= 5 or blocker found.

### Phase 6: Evaluation (insights + proposals)

**Agent:** Evaluator (`agents/evaluator.md`)

QA already did the verification, so this phase is reduced to:

1. Manage the work-item loop. If more work items remain, call
   `request_new_session` and `goto_phase("coding")`.
2. Curate insights collected across all phases.
3. Write up to one `propose_change` per writable layer (tenant, repo) for any
   memory updates, skill updates, or agent updates that the evaluator believes
   warrant human review.

## Error handling

Same as the standard job workflow. Prefer to escalate over silent down-shifting
— the planner picked DEEP for a reason; if a phase fails, that reason needs
human attention.
