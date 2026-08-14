---
display_name: Open-Source Contribution
description: Implement approved retrospective findings in a repository this install does not own, and open the pull request upstream from a fork. Dispatched by a retrospective; not meant to be started by hand.
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

Fix defects in a repository **this install does not own**, and offer the
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

`params.findings` is the work. Each entry is an approved retrospective
finding with its upstream issue and a briefing. Intelligence markdown and
runner TypeScript live in the same repository; a runner change plus the
agent text that describes it is one story, and this job exists so they
can share a PR. The retrospective does not write those files itself.

## Trigger

Dispatched by the retrospective's `dispatch_improvement_job` tool, never
by a webhook and rarely by hand. The params it sets:

| Param | Meaning |
|---|---|
| `repo` / `repoSlug` | The **fork** to clone and push to (`owner/repo`). |
| `upstreamRepo` | The repository the PR targets (`owner/repo`). |
| `prSourceOwner` | Account owning the fork — the PR's `sourceOwner`. |
| `prTargetBranch` | Upstream default branch — the PR's base. |
| `findings` | Approved findings to implement. Each has `id`, `category` (`base-intelligence` or `runner-code`), `issueNumber` / `issueUrl`, `title`, and `description`. This is the source of truth. |
| `upstreamIssueNumber` / `upstreamIssueUrl` | The first finding's issue — a mirror, not a second list. |
| `description` | Assembled briefing covering every finding. It is the only context about *why*. |
| `retrospectiveJobId` / `retrospectiveFindingId` | Provenance. `retrospectiveFindingId` is the first finding; the full set is `findings`. |

There is no spec-writing phase: the dispatching retrospective already
wrote the brief, and the upstream issues are the spec of record.

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
- **Tests are not optional for code.** A runner-code fix with a test that
  fails before it and passes after is reviewable in minutes; one without
  is a claim. A `base-intelligence` finding is a markdown edit: the
  review is the diff, and you do not invent a test harness for a skill
  file. Mixed jobs still need the test for the code part.
- **Public writing.** Every branch name, commit message, PR title, and
  PR comment is world-readable. Never name this install's repositories,
  tickets, customers, or people — the briefing already uses aliases, and
  the diff should need none of them.
- **One PR.** If the findings do not fit one reviewable story, implement
  the coupled subset (or the first finding if none couple) and escalate
  the rest. Do not open a stack of PRs a stranger has to sequence.

## Phases

---

### Phase 1: Planning

**Agent:** Planner (`agents/planner.md`)

1. Read `params.findings` and the assembled briefing in
   `params.description`. Each finding's upstream issue is the spec of
   record; the description is authoritative if the issue is unreachable.
2. Clone the fork and locate the code or markdown each briefing points
   at. Confirm each defect is real and still present — the briefing was
   written from metrics, not from a coding session, and it can be wrong
   about the cause. **If a defect does not exist**, drop that finding
   from the plan and say so; if none exist, `escalate` with what you
   found instead. A withdrawn contribution costs nothing; a wrong one
   costs the project's trust.
3. `set_job_params({ language: "<detected>" })`.
4. Decide what fits **one** reviewable PR. Findings that share files, or
   where one is the instruction side of the other, belong together.
   Unrelated findings do not. Register only the in-scope set with
   `set_work_items` — one work item per finding you will actually ship.
   Log (and later escalate) any finding you left out, so a human can
   dispatch it separately. Scope creep is the main failure mode of this
   workflow; the plan is where it gets stopped.

---

### Phase 2: Coding

**Agent:** Coder (`agents/coder.md`)
**Subagent:** `code-reviewer` — invoked before handing off

Standard coding phase, with the fork as the only push target and the
project's own conventions taking precedence over ours.

1. Branch from `params.prTargetBranch`.
2. Implement the smallest fix. For `runner-code` work items, add the
   test that fails without it. For `base-intelligence` work items, edit
   the named markdown surgically — do not rewrite the rest of the file.
3. Build and run the project's test suite when you touched TypeScript (or
   any other compiled/tested tree); fix what you broke. A markdown-only
   change does not need a green lie from an unrelated suite, but it does
   need the `code-reviewer` pass below.
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
