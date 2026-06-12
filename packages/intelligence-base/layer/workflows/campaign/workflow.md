---
display_name: Campaign
description: Plan and coordinate a multi-job campaign across one or more repositories. Spawns child implementation jobs and aggregates their results.
kind: campaign

initial_phase: campaign-architecture
initial_status: campaign-architecture

phases:
  - name: campaign-architecture
    agent: agents/campaign-architect.md
    tier: planning
    status: campaign-architecture
    interactive_checkpoint: true

  - name: campaign-planning
    agent: agents/campaign-planner.md
    tier: planning
    status: campaign-planning
    interactive_checkpoint: true

  - name: coordinating
    agent: null
    # Agentless phase — the dispatcher parks the job here and no model is
    # ever invoked, so the tier is informational only.
    tier: mini
    status: awaiting-children

  - name: campaign-integration
    agent: agents/campaign-integrator.md
    tier: planning
    status: integrating
    interactive_checkpoint: true

  - name: aggregation
    agent: agents/campaign-evaluator.md
    # Aggregation synthesises the whole campaign: campaign_status over N
    # children, the integration report, per-child insights, tracker epic
    # updates, and multi-file memory proposals. On large campaigns this
    # demands top-tier judgment — `mini` (haiku) proved not up to it.
    tier: planning
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

1. **`campaign-architecture`** — the campaign-architect agent reads
   the campaign description, explores the affected repositories, and
   produces `campaign-architecture.md` (shared decisions, cross-child
   contracts, module ownership, cross-cutting conventions, rollout
   plan) plus a seed `contracts/_index.json`. The interactive
   checkpoint lets a human review the architecture before any
   decomposition.
2. **`campaign-planning`** — the campaign-planner agent reads the
   architecture document, then (a) opens a tracker epic, (b) breaks
   the feature into a small set of issues that **cite** the
   architecture's ADRs, (c) creates each as a tracker child issue with
   explicit `dependsOn` relations, (d) registers each child with
   `params.lane` (FAST / STANDARD / DEEP per the lane sizing matrix in
   the planner agent), `params.campaignDecisionsRef`, and
   `params.campaignContracts` / `params.campaignConsumesContracts`,
   (e) calls `campaign_finalize`. The runner enforces an interactive
   checkpoint here so a human can approve the breakdown before any
   child dispatches.
3. **`coordinating`** — agentless. The job is parked at status
   `awaiting-children`. The runner's dispatcher coordinator hook
   spawns each ready child (one whose `dependsOn` is satisfied) as a
   normal `job` job and watches for terminal child status to advance
   the next ready child. When every child reaches a terminal status,
   the dispatcher resumes the parent into `campaign-integration`.
4. **`campaign-integration`** — the campaign-integrator agent verifies
   the merged children together: every cross-child contract holds at
   integration, the campaign-level happy path runs, and the rollout
   plan from `campaign-architecture.md` is applicable. Outputs
   `integration-report.md` and decides pass / fix-needed /
   inconclusive. fix-needed escalates so a human (or the
   campaign-evaluator) decides between rerun, skip, or rollback.
5. **`aggregation`** — the campaign-evaluator agent reads
   `campaign_status`, the integration report, and per-child insights;
   summarises outcomes; updates the tracker epic; and optionally
   proposes memory updates capturing cross-child insights via
   `propose_change`. The interactive checkpoint lets a human review
   before the campaign closes.

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
