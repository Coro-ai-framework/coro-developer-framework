---
display_name: Implementation Job — Deep Lane
description: Use only for genuinely high-stakes changes that need an explicit architecture step before coding — brand-new public API surface, security/auth changes, irreversible or downtime-risking data migrations, or contracts that span multiple services. Routine refactors, regular bug fixes, scoped feature work, and standard reversible schema changes belong on the default Implementation Job lane. Adds analysis (architecture decisions) and qa (verification) phases either side of coding/review.
kind: job
argument-hint: "<what to build, fix, or review>"

initial_phase: spec-writing
initial_status: queued

phases:
  - name: spec-writing
    agent: .claude/agents/spec-writer.md
    tier: coding
    status: spec-writing
    interactive_checkpoint: true

  - name: analysis
    agent: .claude/agents/analyzer.md
    tier: planning
    status: analyzing
    interactive_checkpoint: true

  - name: planning
    agent: .claude/agents/planner.md
    tier: planning
    status: planning
    interactive_checkpoint: true

  - name: coding
    agent: .claude/agents/coder.md
    tier: coding
    status: coding
    interactive_checkpoint: true
    subagents:
      - name: code-reviewer
        agent: .claude/agents/code-reviewer.md
        tier: mini
        tools: [Read, Glob, Grep, Bash, mcp__coro__code_review_lenses, mcp__coro__scm_get_pr_comments, mcp__coro__scm_post_pr_comment, mcp__coro__log]
    # Review lenses the code-reviewer runs on the local diff through
    # `code_review_lenses`, before any pull request exists.
    lenses:
      - name: correctness
        agent: .claude/agents/review-correctness.md
        tier: review-deep
        when: [code]
        tools: [Read, Grep, Glob, Skill, mcp__coro__read_memory]
      - name: security
        agent: .claude/agents/review-security.md
        tier: review-deep
        when: [code, deps, infra, auth]
        tools: [Read, Grep, Glob, Skill, mcp__coro__read_memory]
      - name: tests
        agent: .claude/agents/review-tests.md
        tier: review-fast
        when: [code, tests]
        tools: [Read, Grep, Glob, Skill, mcp__coro__read_memory]
      - name: design
        agent: .claude/agents/review-design.md
        tier: review-fast
        when: [code]
        tools: [Read, Grep, Glob, Skill, mcp__coro__read_memory]
      - name: architecture
        agent: .claude/agents/review-architecture.md
        tier: review-deep
        when: [contracts, migrations, infra, deps, config]
        tools: [Read, Grep, Glob, Skill, mcp__coro__read_memory]
        mcp_servers: ["@architecture"]
        max_turns: 30
      - name: verifier
        agent: .claude/agents/review-verifier.md
        tier: review-deep
        when: [always]
        tools: [Read, Grep, Glob]

  - name: review
    agent: .claude/agents/pr-reviewer.md
    tier: mini
    status: reviewing
    interactive_checkpoint: true

  - name: qa
    agent: .claude/agents/qa.md
    tier: planning
    status: qa
    interactive_checkpoint: true

  - name: evaluation
    agent: .claude/agents/evaluator.md
    tier: planning
    status: evaluating
    interactive_checkpoint: true

# No overrides needed — DEEP always starts at spec-writing for both CLI
# and tracker-triggered jobs.
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

1. **spec-writing**: delegate to `spec-writer`. It writes `.coro-work/<run-slug>/feature-spec.md`. Checkpoint.
2. **analysis**: delegate to `analyzer` with the spec path. It writes the design notes (`.coro-work/<run-slug>/design-notes.md`). Checkpoint.
3. **planning**: delegate to `planner` with the spec and design-notes paths. It writes the implementation plan and the work-item list. Checkpoint.
4. **For each work item, in order:**
   1. **coding**: delegate to `coder` for that one work item. Tell it not to push and not to open a pull request. It writes the PR title and description to `.coro-work/<run-slug>/pr-preview-<n>.md`.
   2. **code review**: the coder cannot call `code-reviewer` itself, so you do. Run `code-reviewer` on the diff, naming the base branch in its task. It asks for the review lenses: run `review-correctness`, `review-security`, `review-tests` and `review-design` in parallel on the diff, plus `review-architecture` when the change touches contracts, migrations, infrastructure, dependencies or configuration, run `review-verifier` on what they found, and call `code-reviewer` again with the verified findings so it can write its verdict. Hand every blocking finding back to `coder` to fix, and repeat until none are left. Then checkpoint: this is the pre-PR gate, so show the diff and the proposed pull request.
   3. **review**: with the user's consent only, push the branch and open the pull request, then delegate to `pr-reviewer`. Route change requests back to `coder`. Never merge without the user's explicit approval. Checkpoint.
5. **qa**: once every work item is merged, delegate to `qa` once, with the plan and design-notes paths. It decides pass, fix-needed or escalate. On fix-needed, go back to step 4 for the work item whose contract is broken, then run `qa` again. Checkpoint.
6. **evaluation**: delegate to `evaluator` for insights and proposed memory updates only (`qa` already verified the result). Apply proposals only after the user approves. Checkpoint.
<!-- standalone:end -->

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
| `coding` | reviewer L1+L2 + review lenses | reviewer L1+L2 + review lenses (STANDARD set plus architecture) |
| `review` | drives per-WI loop (merge → next WI → coding) | drives per-WI loop **identically** (merge → next WI → coding) |
| `qa` | _absent_ | **new** — runs **once** on the fully-merged base, after every work item is `complete` |
| `evaluation` | combined verify + insights + proposals, runs **once** | insights + proposals only (qa already verified), runs **once** |

**Per-work-item loop ownership in DEEP is the merge gatekeeper, not the evaluator.** `qa` and `evaluation` are each end-of-job phases that run a single time against the fully-merged base. If they discover a regression that warrants a fix, they route back to `coding` for that specific work item — the gatekeeper then re-drives the per-WI loop until the fix lands, and `qa` runs again. Running `qa` and `evaluation` per work item is **not** the design: cross-WI contracts can only be verified once the last PR has merged, and per-WI runs would multiply planning-tier cost without buying signal.

## Lane parameter

The Planner (or an explicit `switch_workflow` call) sets
`params.lane = "deep"`. Downstream agents use this to:
- Run the full set in the `code-reviewer` subagent: L1-L2 itself, then the review lenses (including architecture) through `code_review_lenses`.
- Invoke the `cross-cutting-review` skill in the reviewer.
- Split verification (qa) from insight curation (evaluation).

## Phases

### Phase 0: Spec Writing

**Agent:** Spec Writer (`.claude/agents/spec-writer.md`)

DEEP runs the spec-writer for **CLI-triggered jobs too**, not only tracker-
triggered ones. The analysis phase that follows needs a concrete spec, and the
typical free-form CLI description is not enough.

The agent picks its own mode from the inputs (see `.claude/agents/spec-writer.md` step
2): `derive` when the ticket / `params.description` /
`{planContextDir}/findings.md` do not settle scope between them, `verify` when
they do. On DEEP the mode matters less than on STANDARD, because `analysis`
runs next either way and re-reasons the architecture — what analysis cannot do
for itself is discover the repo's own gates, so the Repo contract section is
required in both modes.

Output: `working/{job-id}/feature-spec.md`.

### Phase 1: Analysis

**Agent:** Analyzer (`.claude/agents/analyzer.md`) — a dedicated agent, **not**
the Planner running in analysis mode.
**Skills:** Analyzer invokes `feature-planning`, `register-convention`,
the relevant language conventions skill, and `cross-cutting-review` at
the design level.

Goal: produce **design notes** before any work item is sequenced. When
`params.planContextDir` is set, read `{planContextDir}/findings.md` before
the spec. Output:
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

**Agent:** Planner (`.claude/agents/planner.md`)

Same as the standard job's planning phase, but the planner reads
`design-notes.md` first and treats its decisions as load-bearing — the
work-item sequence must respect the contracts and risk register that came out
of analysis. When `params.planContextDir` is set, also read
`{planContextDir}/findings.md` before the spec.

### Phase 3: Coding

**Agent:** Coder (`.claude/agents/coder.md`)
**Subagent:** `code-reviewer` (L1-L2 itself, plus the correctness, security, tests, design, and architecture review lenses on the local diff)

Standard coding flow. The reviewer subagent reads `params.lane === "deep"` and
applies all four lenses, including the `cross-cutting-review` skill. As in the
standard lane, the coder pushes the branch and posts a `pr-preview` artefact —
it does **not** open the PR; the `review` phase opens it after the coding
interactive checkpoint (the pre-PR preview gate).

### Phase 4: Review (merge gatekeeper, per work item)

**Agent:** PR Reviewer (`.claude/agents/pr-reviewer.md`)

Identical to the standard job workflow's `review` phase: it **opens the PR**
for the work item (from the coder's branch + `pr-preview`), then acts as a thin
gatekeeper that routes change requests back to coding, waits for approval,
merges, and **drives the per-work-item loop**. After every PR for the current
work item is merged, the gatekeeper closes the work item and either:
- Calls `request_new_session` + `goto_phase("coding")` for the next
  pending work item, OR
- Ends its turn so the runner advances to `qa` — **only when every work
  item is `complete` or `escalated`**.

Running `qa` and `evaluation` per work item is explicitly **not** the
design — the gatekeeper owns the WI loop in DEEP exactly the same way
it does in STANDARD.

### Phase 5: QA (verify the fully-merged result, runs ONCE)

**Agent:** QA (`.claude/agents/qa.md`) — a dedicated agent, **not** the Evaluator
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

**Agent:** Evaluator (`.claude/agents/evaluator.md`)

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
