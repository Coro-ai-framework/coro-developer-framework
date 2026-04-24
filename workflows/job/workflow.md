---
initial_phase: planning
initial_status: queued

phases:
  - name: spec-writing
    agent: agents/spec-writer.md
    model: planning
    status: spec-writing

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
        agent: agents/pr-reviewer.md
        model: coding
        tools: [Read, Glob, Grep, mcp__a5__bb_get_pr_comments, mcp__a5__bb_post_pr_comment, mcp__a5__gh_get_pr_comments, mcp__a5__gh_post_pr_comment, mcp__a5__log]

  - name: review
    agent: agents/pr-reviewer.md
    model: coding
    status: reviewing
    interactive_checkpoint: true

  - name: testing
    agent: agents/tester.md
    model: coding
    status: testing
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

# Workflow: Generic Implementation Job

## Purpose

Implement a scoped change in an existing service or repository. The change can be a new feature, enhancement, bug fix, or other code change described in the job request. The workflow is fully language-agnostic; the correct conventions and coding standards are loaded dynamically based on the repository's language.

## How this workflow runs

This workflow is executed by the **Agent Host Service**. The Agent Host:
1. Receives a job request from the CLI, UI, or a webhook-driven job source
2. Loads this file and the relevant agent MD files as system prompts
3. Calls the Claude API in a loop, dispatching tool calls, until the workflow reaches `complete`
4. Parks the job and resumes it when git provider webhook events (BitBucket or GitHub) arrive

## Trigger

The caller supplies this workflow path plus a generic job payload. For this workflow, the common params are:
- `repo`
- `serviceName`
- `description`
- `reviewers`
- optional `gitProvider`
- optional `jiraTicketId`

When `jiraTicketId` is present, the spec-writer phase can infer the rest of the implementation context.

## Language handling

The Planner agent detects the repository's language (from `go.mod`, `package.json`, `*.csproj`, etc.) and calls `set_job_params({ language: "<detected-language>" })`. Downstream agents invoke the relevant language conventions skill on-demand when writing or reviewing code. The workflow itself is completely language-neutral.

## Work-item tracking

Work-item state is tracked on the Job object via `workItems[]`. The Planner calls `set_work_items` to register the ordered work-item list. The Evaluator manages the work-item loop — if multiple work items exist, it uses `goto_phase("coding")` and `request_new_session` to cycle through them.

## Phases

> **Checkpoint reminder:** Phases flagged `interactive_checkpoint: true` are enforced by the runner when `job.interactive` is `true`. Finish the phase normally; the runner will park for developer approval before advancing. Use `await_event({ eventName: "developer-input: <reason>" })` only for an additional mid-phase question or clarification.

---

### Phase 0: Spec Writing (Jira-triggered only)

**Agent:** Spec Writer (`agents/spec-writer.md`)

1. Read the Jira ticket: title, description, acceptance criteria, components
2. Infer: repo, affected files/services, reviewers, and test plan
3. Output: `working/{job-id}/feature-spec.md`
4. Post a comment on the Jira ticket confirming receipt

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
**Skills:** Agent invokes the relevant language conventions skill for the target language

1. Call `get_work_items` to find the current work item
2. Call `update_work_item` to mark it `in-progress`
3. Read the implementation plan
4. Create a work-item branch
5. Implement the changes following the injected conventions
6. Write tests
7. Open a PR with a detailed description

---

### Phase 3: Review

**Agent:** PR Reviewer (`agents/pr-reviewer.md`)
**Skills:** Agent invokes the relevant language conventions skill for code review

1. Post a structured code review against conventions and plan
2. Monitor for human reviewer comments
3. Coordinate fixes with the coder agent
4. Wait for human approval and merge

---

### Phase 4: Testing

**Agent:** Tester (`agents/tester.md`)
**Skills:** Agent invokes `feature-testing` for implementation acceptance verification heuristics

1. Build the service
2. Run the test suite
3. Verify acceptance criteria
4. Output test results

---

### Phase 5: Evaluation

**Agent:** Evaluator (`agents/evaluator.md`)

1. Classify any failures
2. Write new knowledge to memory
3. Decision:
   - **Work item complete:** call `update_work_item(name, status: "complete")`. If more work items remain, call `request_new_session` then `goto_phase("coding")`. Otherwise finish.
   - **Fix needed:** call `update_work_item(name, incrementLoop: true)`, check loop count, and `goto_phase("coding")` with a fix brief.
   - **Escalate:** if loop count >= 5 or blocker found.

---

## Error handling

- If any agent produces an error it cannot self-resolve, it calls `escalate` with a specific description
- Network failures are retried up to 3 times before escalating
- On completion, transition the Jira ticket to Done (if Jira-triggered)