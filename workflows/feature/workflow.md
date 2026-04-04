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

  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
    subagents:
      - name: code-reviewer
        agent: agents/pr-reviewer.md
        model: coding
        tools: [Read, Glob, Grep, mcp__a5__bb_get_pr_comments, mcp__a5__bb_post_pr_comment, mcp__a5__log]

  - name: review
    agent: agents/pr-reviewer.md
    model: coding
    status: coding

  - name: testing
    agent: agents/tester.md
    model: coding
    status: testing
    subagents:
      - name: test-runner
        agent: agents/tester.md
        model: coding
        tools: [Bash, Read, mcp__a5__run_go_build, mcp__a5__compare_request, mcp__a5__log]

  - name: evaluation
    agent: agents/evaluator.md
    model: planning
    status: evaluating

overrides:
  jira:
    initial_phase: spec-writing
---

# Workflow: Feature Implementation

## Purpose

Implement a new feature in an existing Go service. Can be triggered by the `a5 feature` CLI command or by a Jira ticket assignment.

## How this workflow runs

This workflow is executed by the **Agent Host Service**. The Agent Host:
1. Receives a job request from the `a5` CLI or a Jira webhook
2. Loads this file and the relevant agent MD files as system prompts
3. Calls the Claude API in a loop, dispatching tool calls, until the workflow reaches `complete`
4. Parks the job and resumes it when BitBucket webhook events arrive

## Trigger

**CLI path:** The user provides repo, description, reviewers, and service name.

**Jira path:** A Jira ticket is assigned to the agent. The spec-writer agent reads the ticket and infers repo, reviewers, description, and test plan.

## Phases

---

### Phase 0: Spec Writing (Jira-triggered only)

**Agent:** Spec Writer (`agents/spec-writer.md`)

1. Read the Jira ticket: title, description, acceptance criteria, components
2. Infer: repo, affected files/services, PR reviewers, test plan
3. Output: `working/{job-id}/feature-spec.md`
4. Post a comment on the Jira ticket confirming receipt

CLI-triggered jobs skip this phase — the description is provided directly.

---

### Phase 1: Planning

**Agent:** Planner (`agents/planner.md`)

1. Read the feature spec (or CLI description)
2. Understand the existing Go codebase
3. Produce an implementation plan with feature branches

---

### Phase 2: Coding

**Agent:** Coder (`agents/coder.md`)

1. Read the implementation plan
2. Create a feature branch
3. Implement the changes following `conventions/golang.md`
4. Write tests
5. Open a PR with a detailed description

---

### Phase 3: Review

**Agent:** PR Reviewer (`agents/pr-reviewer.md`)

1. Post a structured code review
2. Monitor for human reviewer comments
3. Coordinate fixes with the coder agent
4. Wait for human approval and merge

---

### Phase 4: Testing

**Agent:** Tester (`agents/tester.md`)

1. Build the service
2. Run comparison tests if a staging URL is available
3. Output test results

---

### Phase 5: Evaluation

**Agent:** Evaluator (`agents/evaluator.md`)

1. Classify any failures
2. Write new knowledge to memory
3. Decision: complete, loop back to coding, or escalate

---

## Error handling

- If any agent produces an error it cannot self-resolve, it calls `escalate` with a specific description
- Network failures are retried up to 3 times before escalating
- On completion, transition the Jira ticket to Done (if Jira-triggered)
