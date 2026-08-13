---
display_name: Open-Source Contribution
description: Implement a fix in a repository this install does not own, and open the pull request upstream from a fork. Dispatched by a retrospective for a finding that needs a code change rather than a wording change; not meant to be started by hand.
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
        tools: [Read, Glob, Grep, Bash, mcp__coro__log]

  - name: contribution
    agent: agents/oss-contributor.md
    tier: planning
    status: reviewing
---

# Workflow: Open-Source Contribution

## Purpose

Fix a defect in a repository **this install does not own**, and offer the
fix upstream as a pull request from a fork.

The work itself is ordinary implementation work, so this workflow reuses
the standard planner, coder, and `code-reviewer` subagent. What differs is
the geography and the ending:

- The clone is a **fork**. `params.repo` points at it, and it is the only
  remote the job can push to.
- The pull request is **cross-repository**: branch on the fork, base on
  `params.upstreamRepo`.
- The job **ends at PR open**. Nobody here can merge, and no evaluation
  phase can verify a merged result that will not exist for days.

## Trigger

Dispatched by the retrospective's `dispatch_improvement_job` tool, never
by a webhook and rarely by hand. The params it sets:

| Param | Meaning |
|---|---|
| `repo` / `repoSlug` | The **fork** to clone and push to (`owner/repo`). |
| `upstreamRepo` | The repository the PR targets (`owner/repo`). |
| `prSourceOwner` | Account owning the fork — the PR's `sourceOwner`. |
| `prTargetBranch` | Upstream default branch — the PR's base. |
| `upstreamIssueNumber` / `upstreamIssueUrl` | The issue this fixes. |
| `description` | The full briefing. It is the only context about *why*. |
| `retrospectiveJobId` / `retrospectiveFindingId` | Provenance, for the PR body. |

There is no spec-writing phase: the dispatching retrospective already
wrote the brief, and the upstream issue is the spec of record.

## Why the shape differs from the implementation job

| Implementation job | Here |
|---|---|
| `spec-writing` turns a ticket into a spec | The upstream issue **is** the spec |
| `review` opens the PR, then merges it | `contribution` opens the PR and stops — merging is the maintainers' call |
| `evaluation` verifies the merged base branch | Verification happens in `coding`, against the fork branch, because there will be no merge to verify |

## Contribution etiquette

This job's output is read by people who did not ask for it, on a project
that owes it nothing. That constrains the work more than any internal job:

- **Smallest change that fixes the issue.** No drive-by refactors, no
  reformatting, no dependency bumps, no renames. A diff that touches
  unrelated files gets closed regardless of merit.
- **Follow the repository, not our conventions.** Read the neighbouring
  code and the project's contributing guide; match what is there.
- **Tests are not optional.** A fix with a test that fails before it and
  passes after is reviewable in minutes; one without is a claim.
- **Public writing.** Every branch name, commit message, PR title, and
  PR comment is world-readable. Never name this install's repositories,
  tickets, customers, or people — the briefing already uses aliases, and
  the diff should need none of them.
- **One PR.** If the work does not fit one reviewable PR, say so in the
  contribution phase and escalate rather than opening a stack of PRs a
  stranger has to sequence.

## Phases

---

### Phase 1: Planning

**Agent:** Planner (`agents/planner.md`)

1. Read `params.description` and the upstream issue at
   `params.upstreamIssueUrl` (via `Bash`/`WebFetch` if reachable; the
   description is authoritative either way).
2. Clone the fork and locate the code the briefing points at. Confirm the
   defect is real and still present — the briefing was written from
   metrics, not from the code, and it can be wrong about the cause.
   **If the defect does not exist**, `escalate` with what you found
   instead. A withdrawn contribution costs nothing; a wrong one costs the
   project's trust.
3. `set_job_params({ language: "<detected>" })`.
4. Produce a plan with **one** work item wherever possible, and register
   it with `set_work_items`. Scope creep is the main failure mode of this
   workflow; the plan is where it gets stopped.

---

### Phase 2: Coding

**Agent:** Coder (`agents/coder.md`)
**Subagent:** `code-reviewer` — invoked before handing off

Standard coding phase, with the fork as the only push target and the
project's own conventions taking precedence over ours.

1. Branch from `params.prTargetBranch`.
2. Implement the smallest fix. Add the test that fails without it.
3. Build and run the project's test suite; fix what you broke.
4. Invoke `code-reviewer`, asking specifically whether the diff is minimal
   and whether it matches the surrounding code. Address blocking findings.
5. Push the branch **to the fork** and post the `pr-preview` artefact with
   the proposed title and body. Do not open the PR.

The interactive checkpoint here is the last point at which a human on this
install sees the change before it becomes public. Treat the preview as the
thing they will judge.

---

### Phase 3: Contribution

**Agent:** OSS Contributor (`agents/oss-contributor.md`)

Opens the cross-repository pull request, links the issue, and ends the
job. See the agent file for the exact call and the failure handling.

---

## Error handling

- Push rejected, fork missing, or PR creation refused: `escalate` with the
  provider's message. Do not retry against the upstream repository — this
  job has no write access to it, and trying looks like an attack in the
  audit log.
- Anything that would need a maintainer's decision (API design, breaking
  change, unclear intent): `escalate`. Ask in the issue rather than
  guessing in a PR.
