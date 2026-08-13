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

The analyst reads the job window through `list_jobs`, `get_job_report`,
and `get_job_log_excerpts`, applies the thresholds in the
`retrospective-analysis` skill, and posts a `retrospective-report`
artefact containing the findings.

This phase carries `interactive_checkpoint: true`, so the runner parks
the job in `awaiting-developer-input` **after** analysis completes and
before `shipping` starts. That park is the load-bearing safety property
of this workflow: findings are drawn from real internal runs, and the
human decides which ones are allowed to leave the machine.

### `shipping`

Resumes with the developer's approval message. The analyst ships only
the approved findings, then posts a `retrospective-outcome` artefact
recording where each one landed.

Where a finding goes depends on which layer owns the fix:

| Category | Destination | Tool |
|----------|-------------|------|
| `tenant-intelligence` | This install's own layers | `propose_change` |
| `base-intelligence` | Upstream issue **and** a markdown PR | `upstream_search` → `upstream_create_issue` / `upstream_comment_issue` → `upstream_open_intelligence_pr` |
| `runner-code` | Upstream issue only | `upstream_search` → `upstream_create_issue` |

`runner-code` stops at the issue because a code change must be built and
tested, and this phase does neither.

## Output

- `working/{job-id}/retrospective-report.md` — the findings, with evidence.
- One `propose_change` PR per writable layer that had approved findings.
- Upstream issues, and one markdown PR per approved `base-intelligence`
  finding, when an upstream destination is configured and enabled.
- `working/{job-id}/retrospective-outcome.md` — where each finding landed.

## Important rules

- **The retrospective proposes; humans merge.** No phase of this
  workflow may merge anything, in any layer. That asymmetry is what
  keeps a self-improving loop from drifting.
- **Nothing public before the checkpoint.** If the `shipping` phase
  starts without an approval message in the prompt, the analyst
  escalates instead of guessing.
- **Evidence or it does not ship.** A finding with fewer than two
  citing jobs is an anecdote; anecdotes stay in the report.
- **Search upstream before filing.** Other installs run this same
  workflow against the same Coro version. A second issue for a known
  problem is worse than no issue at all — add evidence to the existing
  one instead.
- **Aliases only in anything public.** The upstream tools refuse text
  carrying a real repository, org, ticket, or e-mail identifier. That
  refusal is final, not something to phrase around.
