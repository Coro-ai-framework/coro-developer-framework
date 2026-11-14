---
display_name: Self Update Tracking
description: Internal tracker for self-improvement PRs. Created automatically by the runner; not user-launchable.
kind: internal
argument-hint: "<what to build, fix, or review>"
disable-model-invocation: true

initial_phase: tracking
initial_status: awaiting-pr-merge

phases:
  - name: tracking
    agent: null
    tier: mini
    status: awaiting-pr-merge
---

<!-- standalone:start -->
## Needs the Coro runner

This workflow needs the Coro runner: it is a tracker the runner creates for its own self-improvement pull requests. Tell the user to start it from the Coro dashboard or the `coro` CLI, then stop. Do not try to emulate it in this session.
<!-- standalone:end -->

# Workflow: Self Update Tracking

This workflow exists so internally created self-update jobs use the same
workflowPath-driven job model as every other job. These jobs are not executed
by an agent phase loop; they are persisted for PR tracking and visibility only.