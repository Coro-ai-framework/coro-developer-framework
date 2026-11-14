---
display_name: Retrospective
description: Cross-job self-analysis. Mines this install's own job history for systemic agent struggles and ships the findings as intelligence improvements. Dashboard-triggered.
kind: internal

initial_phase: analysis
initial_status: analyzing

phases:
  - name: analysis
    agent: agents/retrospective-analyst.md
    tier: planning
    status: analyzing
    interactive_checkpoint: true
  - name: shipping
    agent: agents/retrospective-analyst.md
    tier: planning
    status: shipping
---

# Workflow: Retrospective

## Purpose

Every other workflow improves a *product*. This one improves *Coro*.

A single job only ever sees itself. The evaluator can tell you that this
run looped three times; it cannot tell you that the coding phase loops
three times on **every** Go job, which is the finding that actually
changes something. This workflow closes that gap: it reads the install's
own job records across a window of past runs, looks for patterns, and
routes each finding to the layer that can fix it.

## Trigger

Dashboard-only, on demand. The runner dispatches a job with
`type: retrospective` and `params`:

| Param | Meaning |
|-------|---------|
| `jobWindow` | How many recent jobs to analyse. |
| `tiers` | Which destinations are permitted this run (`tenant`, `upstreamIntelligence`, `upstreamCode`). |
| `interactive` | Always `true` — the checkpoint below is not optional. |

There is no scheduler. A retrospective costs real tokens and produces
public artefacts, so a human starts it.

## Phases

### `analysis`

The analyst clusters the job window through `cluster_window` first,
then drills in with `list_jobs`, `get_job_report`, and
`get_job_trace_summary`. `get_job_log_excerpts` is for a named failure,
not for grouping. It applies the thresholds in the
`retrospective-analysis` skill, scores prior remedies from the cluster
scorecard, and posts a `retrospective-report` artefact containing the
findings — each with counter-evidence and a `predictedMetric`.

The runner validates that artefact rather than storing it unchecked: a
finding that would be silently dropped, one below the two-job evidence
bar, a metric name the scorer cannot compute, or an overlapping pair with
no declared relation all come back as an error to fix. Findings that share
a `rootCause` are one defect, and ship as one issue and one work item.

Before writing that report it verifies each candidate against the files
it names: `_intelligence/` for the intelligence layer, and — for anything
bound upstream — a read-only snapshot of the upstream default branch that
`upstream_checkout` puts in `_upstream/`. The evidence still comes from
job metrics; the code is only how a remedy stops being a guess. Reading
it also reveals the finding that upstream has already fixed, which is a
finding to drop rather than file.

This phase carries `interactive_checkpoint: true`, so the runner parks
the job in `awaiting-developer-input` **after** analysis completes and
before `shipping` starts. That park is the load-bearing safety property
of this workflow: findings are drawn from real internal runs, and the
human decides which ones are allowed to leave the machine.

### `shipping`

Resumes with the developer's decision quoted in a `[DEVELOPER APPROVAL]`
block at the top of the phase prompt — itemised per finding when it came
from the dashboard ballot. The analyst ships only the approved findings,
records the rest as not shipped, then posts a `retrospective-outcome`
artefact saying where each one landed.

Where a finding goes depends on which layer owns the fix:

| Category | Destination | Tool |
|----------|-------------|------|
| `tenant-intelligence` | This install's own layers | `propose_change` |
| `base-intelligence` | Upstream issue, then a delegated implementation run | `upstream_search` → `upstream_create_issue` / `upstream_comment_issue` → `dispatch_improvement_job` |
| `runner-code` | Upstream issue, then a delegated implementation run | `upstream_search` → `upstream_create_issue` → `dispatch_improvement_job` |

Both upstream categories are delegated rather than written here. The
retrospective has neither a writable checkout nor a review loop, and
whole-file dumps from a metrics context produced bad PRs. Intelligence
markdown and runner code live in the same repository, so
`dispatch_improvement_job` can carry several approved findings in one
call, each with a structured briefing. The child planner keeps them in
one PR when they are one story.
`workflows/oss-contribution/workflow.md` plans, codes, verifies
(out-of-band test/wording gate), then opens the pull request upstream.

## Output

- `working/{job-id}/retrospective-report.md` — the findings, with evidence.
- One `propose_change` PR per writable layer that had approved findings.
- Upstream issues, and one dispatched contribution job covering the
  approved `base-intelligence` and `runner-code` findings that still
  need a fix — when an upstream destination is configured and the
  matching tier is enabled.
- `working/{job-id}/retrospective-outcome.md` — where each finding landed.

## Important rules

- **The retrospective proposes; humans merge.** No phase of this
  workflow may merge anything, in any layer. That asymmetry is what
  keeps a self-improving loop from drifting.
- **Nothing public before the checkpoint.** If the `shipping` phase
  starts with no developer approval in its prompt, the analyst escalates
  instead of guessing. An approval that names no finding ids is still an
  approval — of the whole report; a missing one is not.
- **Evidence or it does not ship.** A finding with fewer than two
  citing jobs is an anecdote; anecdotes stay in the report. The only
  exception is an evidence-pipeline defect (the report or cluster schema
  itself is broken), which may cite one job. Access to the source does
  not change this: something noticed by reading code, with no run behind
  it, is a code review and belongs to a different workflow.
- **Tiers gate where a finding goes, not whether it is reported.** Every
  destination refuses in code when its tier is off — including
  `propose_change` for the local layers. A finding the run cannot ship is
  still reported and still recorded as not shipped, with the tier as the
  reason; that record is how a developer learns a wider run was warranted.
- **Search upstream before filing.** Other installs run this same
  workflow against the same Coro version. A second issue for a known
  problem is worse than no issue at all — add evidence to the existing
  one instead.
- **Aliases only in anything public.** The upstream tools refuse text
  carrying a real repository, org, ticket, or e-mail identifier. That
  refusal is final, not something to phrase around.
