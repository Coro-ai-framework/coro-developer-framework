---
display_name: Campaign
description: Plan and coordinate a multi-job campaign across one or more repositories. Spawns child implementation jobs and aggregates their results.
kind: campaign

initial_phase: campaign-planning
initial_status: campaign-planning

phases:
  - name: campaign-planning
    agent: agents/campaign-planner.md
    model: planning
    status: campaign-planning
    interactive_checkpoint: true

  - name: coordinating
    agent: null
    model: planning
    status: awaiting-children

  - name: aggregation
    agent: agents/campaign-evaluator.md
    model: planning
    status: aggregating
    interactive_checkpoint: true
---

# Workflow: Campaign

## Purpose

A campaign coordinates a large feature that decomposes into multiple
self-contained tracker issues. Each issue runs as a normal `job` workflow
in its own session, against its own branch and PR. The campaign job
itself is a thin record on top of the existing job machinery — it owns
an issue-list (`campaignChildren[]`), a tracker epic, and the dependency
graph between issues.

This workflow is reached automatically when the standard `planning`
phase of `workflows/job/workflow.md` decides the work is too large for
a single job and calls `mcp__coro__convert_to_campaign`. The runner
switches the same job's `workflowPath` to this file and resumes here at
`campaign-planning`. Children dispatched from a campaign always run
`workflows/job/workflow.md` with `params.epicAllowed = false`, so they
cannot recursively become campaigns.

## How this workflow runs

1. **`campaign-planning`** — the campaign-planner agent (a) opens a
   tracker epic, (b) breaks the feature into a small set of issues,
   (c) creates each as a tracker child issue with explicit `dependsOn`
   relations, (d) registers each child on the job via
   `mcp__coro__campaign_register_child`, (e) calls
   `mcp__coro__campaign_finalize` to commit the plan and park the job.
   The runner enforces an interactive checkpoint here so a human can
   approve the breakdown before any child dispatches.
2. **`coordinating`** — agentless. The job is parked at status
   `awaiting-children`. The runner's dispatcher coordinator hook
   spawns each ready child (one whose `dependsOn` is satisfied) as a
   normal `job` job and watches for terminal child status to advance
   the next ready child. When every child reaches a terminal status,
   the dispatcher resumes the parent into `aggregation`.
3. **`aggregation`** — the campaign-evaluator agent (a) reads
   `mcp__coro__campaign_status`, (b) summarises outcomes, (c) updates
   the tracker epic, (d) optionally proposes memory updates capturing
   cross-child insights via `propose_change`. The interactive
   checkpoint lets a human review before the campaign closes.

## Trigger

This workflow is never triggered directly by the CLI. It is entered via
`mcp__coro__convert_to_campaign` from the regular `planning` phase, or
by the dispatcher when a parent job is created with the campaign
workflow path explicitly (advanced operators).

## Failure handling

The dispatcher's coordinator stops dispatching new children as soon as
one child reaches `failed` or `escalated` (default `halt-on-failure`
policy). The campaign job parks at `awaiting-developer-input`. A human
or the campaign-evaluator can then call `campaign_skip_child`,
`campaign_rerun_child`, or `campaign_cancel_child` and resume the
campaign. The policy is configurable via
`settings.coordination.failurePolicy` in the future; today the default
is the only mode.

## Recursion guard

Children are dispatched with `params.epicAllowed = false`. The planner
agent honours this flag and refuses to call `convert_to_campaign` on a
child, which keeps campaign trees flat (depth = 1).
