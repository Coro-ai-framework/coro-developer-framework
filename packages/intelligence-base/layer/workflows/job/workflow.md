---
display_name: Implementation Job
description: General-purpose work-item workflow for scoped changes in an existing repository. Coro plans, codes, reviews, and ships a pull request.
kind: job

initial_phase: spec-writing
initial_status: queued

phases:
  - name: spec-writing
    agent: agents/spec-writer.md
    tier: mini
    status: spec-writing
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

  - name: evaluation
    agent: agents/evaluator.md
    tier: planning
    status: evaluating
    interactive_checkpoint: true

overrides:
  # `triggerSource` matches the value the runner stamps on inbound jobs.
  # The base initial_phase is `spec-writing` so CLI and tracker-triggered
  # jobs both produce a structured spec before planning. Tenants that
  # want to skip spec-writing for free-form CLI jobs can override here.
  jira:
    initial_phase: spec-writing
---

# Workflow: Generic Implementation Job

## Purpose

Implement a scoped change in an existing service or repository. The change can be a new feature, enhancement, bug fix, or other code change described in the job request. The workflow is fully language-agnostic; the correct conventions and coding standards are loaded dynamically based on the repository's language.

## How this workflow runs

This workflow is executed by the **Coro Runner Service**. The Coro Runner:
1. Receives a job request from the CLI, UI, or a webhook-driven job source
2. Loads this file and the relevant agent MD files as system prompts
3. Calls the configured LLM in a loop, dispatching tool calls, until the workflow reaches `complete`
4. Parks the job and resumes it when SCM webhooks (delivered via the active SCM plugin) arrive

## Trigger

The caller supplies this workflow path plus a generic job payload. For this workflow, the common params are:
- `repo`
- `serviceName`
- `description`
- `reviewers`
- optional `scm` — id of the SCM plugin to use (overrides the tenant default)
- optional `tracker` — id of the Tracker plugin to use (overrides the tenant default)
- optional `trackerRef` — `{ kind: 'ticket', pluginId, externalId, url? }` when the job is triggered from a tracker (e.g. a Jira/Linear/GitHub Issues ticket assigned to the agent). Legacy callers may still pass `jiraTicketId` (a bare Jira key) and the runner will translate it for backward compatibility.

When `trackerRef` is present, the spec-writer phase can infer the rest of the implementation context from the ticket.

## Language handling

The Planner agent detects the repository's language (from `go.mod`, `package.json`, `*.csproj`, etc.) and calls `set_job_params({ language: "<detected-language>" })`. Downstream agents invoke the relevant language conventions skill on-demand when writing or reviewing code. The workflow itself is completely language-neutral.

## Work-item tracking

Work-item state is tracked on the Job object via `workItems[]`. The Planner calls `set_work_items` to register the ordered work-item list. The Evaluator manages the work-item loop — if multiple work items exist, it uses `goto_phase("coding")` and `request_new_session` to cycle through them.

## Workflow shape

The job pipeline is intentionally tight: each phase has a distinct decision to make, and we avoid running the same checks in two places.

| Phase | Who | What is unique to this phase |
|---|---|---|
| `spec-writing` (tracker-triggered) | spec-writer | Translate the ticket into a concrete spec |
| `planning` | planner | Decide scope, sequence, language; produce work items |
| `coding` | coder + `code-reviewer` subagent | Implement, build, test locally, self-review the diff against conventions/plan, open the PR |
| `review` | pr-reviewer (merge gatekeeper) | Coordinate with humans, route fix requests back to coder, merge when approved |
| `evaluation` | evaluator | Verify the merged result against acceptance criteria, manage the work-item loop, capture memory and self-improvement proposals |

The convention/plan/test-coverage review happens **once**, inside the coding phase, via the `code-reviewer` subagent. The standalone `review` phase does **not** re-review the diff — it focuses on the human-coordination and merge actions that the coder must not perform on its own work. Acceptance-criteria verification, build/test re-run on the merged commit, and Loki/Tempo error scans live in `evaluation`.

## Phases

> **Checkpoint reminder:** Phases flagged `interactive_checkpoint: true` are enforced by the runner when `job.interactive` is `true`. Finish the phase normally; the runner will park for developer approval before advancing. Use `await_event({ eventName: "developer-input: <reason>" })` only for an additional mid-phase question or clarification.

---

### Phase 0: Spec Writing (tracker-triggered only)

**Agent:** Spec Writer (`agents/spec-writer.md`)

1. Read the tracker ticket via `tracker_get_issue({ trackerRef: params.trackerRef })`: title, description, acceptance criteria, components
2. Infer: repo, affected files/services, reviewers, and test plan
3. Output: `working/{job-id}/feature-spec.md`
4. Post a comment on the tracker ticket confirming receipt

CLI-triggered jobs skip this phase — the description is provided directly.

---

### Phase 1: Planning

**Agent:** Planner (`agents/planner.md`)
**Skills:** Agent invokes `feature-planning` for domain heuristics that translate a prose change request into a sequenced implementation plan

1. Read the job spec (or CLI description)
2. Analyze the existing codebase to understand language, structure, and patterns
3. Call `set_job_params({ language: "<detected-language>" })` to set the language
4. Produce an implementation plan with work items and acceptance criteria
5. Call `set_work_items` to register the work-item list

---

### Phase 2: Coding

**Agent:** Coder (`agents/coder.md`)
**Subagent:** `code-reviewer` (`agents/code-reviewer.md`) — invoked by the coder before opening the PR
**Skills:** Agent invokes the relevant language conventions skill for the target language

1. Call `get_work_items` to find the current work item
2. Call `update_work_item` to mark it `in-progress`
3. Read the implementation plan
4. Create a work-item branch
5. Implement the changes following the injected conventions
6. Write tests
7. Build, run the test suite, and fix any failures locally
8. Invoke the `code-reviewer` subagent on the staged diff. Address any blocking findings before pushing. Carry the subagent's verdict into the PR description so human reviewers can see it.
9. Open the PR with a detailed description that includes the subagent's review summary

---

### Phase 3: Review (merge gatekeeper)

**Agent:** PR Reviewer (`agents/pr-reviewer.md`)

This phase does **not** re-review the diff — that already happened in coding via the `code-reviewer` subagent. The agent here is a thin merge gatekeeper that:

1. Reads the latest PR state and any human comments
2. Routes blocking human change requests back to the coder via `goto_phase("coding")`
3. Waits for human approval (`await_event` on `pr:approved`)
4. Merges the PR when approval and CI conditions are met
5. Records cross-PR feedback patterns to memory

---

### Phase 4: Evaluation (verify + loop control)

**Agent:** Evaluator (`agents/evaluator.md`)
**Skills:** Agent invokes `feature-testing` for acceptance verification heuristics

1. Check out the merged branch and confirm the build/test suite still passes (`build_status`, `existing_tests_status`)
2. Verify each acceptance criterion from the implementation plan and record pass/fail with diffs
3. Query Loki for runtime errors logged during verification (when applicable)
4. Triage failures, classify root causes, write to memory for new findings
5. Decision:
   - **Work item complete:** call `update_work_item(name, status: "complete")`. If more work items remain, call `request_new_session` then `goto_phase("coding")`. Otherwise finish.
   - **Fix needed:** call `update_work_item(name, incrementLoop: true)`, check loop count, and `goto_phase("coding")` with a fix brief.
   - **Escalate:** if loop count >= 5 or blocker found.
6. Review upstream insights and consolidate self-improvement proposals (one `propose_change` per target layer)

---

## Error handling

- If any agent produces an error it cannot self-resolve, it calls `escalate` with a specific description
- Network failures are retried up to 3 times before escalating
- On completion, transition the tracker ticket to Done via `tracker_transition_issue` (when the job was tracker-triggered)
