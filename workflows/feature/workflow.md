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
    status: reviewing

  - name: testing
    agent: agents/tester.md
    model: coding
    status: testing

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

Implement a new feature in an existing service. The service can be written in any language — Go, .NET, TypeScript, or any other supported language. The workflow is fully language-agnostic; the correct conventions and coding standards are loaded dynamically based on the repository's language.

## How this workflow runs

This workflow is executed by the **Agent Host Service**. The Agent Host:
1. Receives a job request from the `a5` CLI or a Jira webhook
2. Loads this file and the relevant agent MD files as system prompts
3. Calls the Claude API in a loop, dispatching tool calls, until the workflow reaches `complete`
4. Parks the job and resumes it when BitBucket webhook events arrive

## Trigger

**CLI path:** The user provides repo, description, reviewers, and service name.

**Jira path:** A Jira ticket is assigned to the agent. The spec-writer agent reads the ticket and infers repo, reviewers, description, and test plan.

## Language handling

The Planner agent detects the repository's language (from `go.mod`, `package.json`, `*.csproj`, etc.) and calls `set_job_params({ language: "<detected-language>" })`. Downstream agents invoke the relevant language conventions skill (e.g., `golang-conventions`, `dotnet-conventions`) on-demand when writing or reviewing code. The workflow itself is completely language-neutral.

## Feature tracking

Feature state is tracked in Redis via the `features[]` array on the Job object. The Planner calls `set_features` to register the feature list. The Evaluator manages the feature loop — if multiple features exist, it uses `goto_phase("coding")` and `request_new_session` to cycle through them.

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
**Skills:** Agent invokes `feature-planning` for domain knowledge

1. Read the feature spec (or CLI description)
2. Analyze the existing codebase to understand language, structure, and patterns
3. Call `set_job_params({ language: "<detected-language>" })` to set the language
4. Produce an implementation plan with features and acceptance criteria
5. Call `set_features` to register the feature list

---

### Phase 2: Coding

**Agent:** Coder (`agents/coder.md`)
**Skills:** Agent invokes language conventions skill for the target language

1. Call `get_features` to find the current feature
2. Call `update_feature` to mark it `in-progress`
3. Read the implementation plan
4. Create a feature branch
5. Implement the changes following the injected conventions
6. Write tests
7. Open a PR with a detailed description

---

### Phase 3: Review

**Agent:** PR Reviewer (`agents/pr-reviewer.md`)
**Skills:** Agent invokes language conventions skill for code review

1. Post a structured code review against conventions and plan
2. Monitor for human reviewer comments
3. Coordinate fixes with the coder agent
4. Wait for human approval and merge

---

### Phase 4: Testing

**Agent:** Tester (`agents/tester.md`)
**Skills:** Agent invokes `feature-testing` for domain knowledge

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
   - **Feature complete:** call `update_feature(name, status: "complete")`. If more features remain, call `request_new_session` then `goto_phase("coding")`. Otherwise finish.
   - **Fix needed:** call `update_feature(name, incrementLoop: true)`, check loop count, and `goto_phase("coding")` with fix brief.
   - **Escalate:** if loop count >= 5 or blocker found.

---

## Error handling

- If any agent produces an error it cannot self-resolve, it calls `escalate` with a specific description
- Network failures are retried up to 3 times before escalating
- On completion, transition the Jira ticket to Done (if Jira-triggered)
