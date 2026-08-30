---
display_name: Open-Source Contribution
description: Implement approved retrospective findings in a repository this install does not own, and open the pull request upstream from a fork. Dispatched by a retrospective; not meant to be started by hand.
kind: job

initial_phase: planning
initial_status: queued

phases:
  - name: planning
    agent: agents/oss-planner.md
    tier: planning
    status: planning

  - name: coding
    agent: agents/oss-coder.md
    tier: coding
    status: coding
    interactive_checkpoint: true
    subagents:
      - name: code-reviewer
        agent: agents/code-reviewer.md
        tier: mini
        tools: [Read, Glob, Grep, Bash, mcp__coro__log]

  - name: verification
    agent: agents/oss-verifier.md
    tier: mini
    status: reviewing

  - name: contribution
    agent: agents/oss-contributor.md
    tier: planning
    status: reviewing
---

# Workflow: Open-Source Contribution

## Purpose

Fix defects in a repository **this install does not own**, and offer the
fix upstream as a pull request from a fork.

The work itself is ordinary implementation work on a fork. What differs is
the geography, the agents, and the ending:

- The clone is a **fork**. `params.repo` points at it, and it is the only
  remote the job can push to.
- Planning and coding use contribution-specific agents so they do not run
  the generic job's campaign/lane/merge-gatekeeper procedure.
- `verification` is an out-of-band gate: the test (or wording grep) must
  be true before `contribution` opens the PR.
- The pull request is **cross-repository**: branch on the fork, base on
  `params.upstreamRepo`.
- The job **ends at PR open**. Nobody here can merge.

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
| Generic planner/coder (campaign, lanes, merge) | `oss-planner` / `oss-coder` — contribution only |
| `review` opens the PR, then merges it | `verification` checks the test/wording gate, then `contribution` opens the PR and stops |
| `evaluation` verifies the merged base branch | Verification happens before the PR, against the fork branch |

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
  the coupled subset (or the first finding if none couple) and leave the
  rest out. Do not open a stack of PRs a stranger has to sequence, and do
  not `escalate` the leftovers — that ends the job and loses the PR too.
  Name them in the plan's **Deferred** section instead. The runner
  reconciles `params.findings` against the `findingIds` on the `pr-link`
  artefact at the end of the job and raises whatever never shipped, so a
  deferral reaches a developer without any phase having to hold the job
  open for it.

## Phases

---

### Phase 1: Planning

**Agent:** OSS Planner (`agents/oss-planner.md`)

Follow that agent's procedure. Do not run campaign triage or lane
switching.

---

### Phase 2: Coding

**Agent:** OSS Coder (`agents/oss-coder.md`)
**Subagent:** `code-reviewer` — invoked before handing off

Follow that agent's procedure. The interactive checkpoint here is the
last point at which a human on this install sees the change before it
becomes public. Dispatch sets `params.interactive` true for exactly that
reason, but a developer can switch it off while the job runs — so the
checkpoint is where a human *may* look, never a channel to leave a
message on. Anything that must reach a developer belongs in an artefact.

---

### Phase 3: Verification

**Agent:** OSS Verifier (`agents/oss-verifier.md`)

Out-of-band gate. For `runner-code`, the named test must fail on the base
SHA and pass on the branch. For `base-intelligence`, the neighbouring
wording must be present and leftover copies of the old instruction must
not remain live. Fail closed: `escalate` rather than opening a PR.

---

### Phase 4: Contribution

**Agent:** OSS Contributor (`agents/oss-contributor.md`)

Opens the cross-repository pull request, links the issue, and ends the
job. See the agent file for the exact call and the failure handling.
The PR body must include the predicted metric from the briefing so a
later retrospective can score it.

---

## Error handling

- Push rejected, fork missing, or PR creation refused: `escalate` with the
  provider's message. Do not retry against the upstream repository — this
  job has no write access to it, and trying looks like an attack in the
  audit log.
- Anything that would need a maintainer's decision (API design, breaking
  change, unclear intent): `escalate`. Ask in the issue rather than
  guessing in a PR.
