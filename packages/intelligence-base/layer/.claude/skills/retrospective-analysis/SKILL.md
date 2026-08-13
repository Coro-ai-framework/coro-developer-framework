---
name: retrospective-analysis
description: >-
  Thresholds and categorisation rules for cross-job self-analysis. Read at the
  start of the retrospective `analysis` phase, before reading any job report.
  Defines what counts as a systemic finding, what evidence each finding needs,
  and which intelligence layer owns the fix.
---

# Retrospective analysis

Turning many job records into a short list of things worth fixing. The
failure mode this skill guards against is a report full of true but
useless observations ("job X cost $4.10"). A finding earns its place
only when it names a **repeatable** problem and a layer that can fix it.

## 1. What you are looking for

Six signals, in rough order of how often they turn out to be real.

### Phase loops

`get_job_report` returns `phases[]` with a `runs` count and a convenience
`loopedPhases[]`. A phase with `runs > 1` was re-entered — usually the
evaluator sending work back to the coder.

**Threshold:** the same phase loops in **≥ 30% of the window** (minimum
2 jobs). One job looping four times is a bad day; a third of jobs
looping is a missing instruction.

Cost of the finding = sum of `costUsd` for the runs beyond the first.
Quote it — "$11 of avoidable rework across 4 jobs" is what makes a
maintainer act.

### Escalation clusters

Group `escalationMessage` values by root cause, not by wording. Three
jobs escalating on "could not resolve reviewer" is one finding.

**Threshold:** ≥ 2 jobs with the same root cause.

### Recurring tool or build failures

`get_job_log_excerpts` defaults to error-ish lines. Normalise each line
before grouping: strip timestamps, ids, paths, and line numbers, then
compare. `scm_get_pr_status failed: 404` in six jobs is a finding;
six differently-worded one-off errors are not.

**Threshold:** same normalised error in ≥ 3 jobs.

### Cost and turn outliers

Compare each job's `costUsd` against the **median** of jobs on the same
`workflowPath` (median, not mean — one campaign distorts a mean badly).

**Threshold:** ≥ 2× the median, and the excess traceable to a specific
phase in `phases[]`. Without that attribution you have a number, not a
finding.

### Work-item rework

`workItems[].loopCount` and the report's `maxLoopCount`. High loop
counts concentrated on one *kind* of work item (tests, migrations,
config) point at a missing convention rather than a bad run.

**Threshold:** `loopCount ≥ 3` on similar work items in ≥ 2 jobs.

### Repeated insights

The same insight recorded independently by agents across different jobs
is the strongest signal in the whole set — several agents hit the same
wall unprompted. Treat a repeat as high severity even at 2 jobs.

## 2. Evidence requirements

Every finding carries `evidence[]` with **at least two entries**, each
naming a real `jobId` and a concrete number pulled from a report. No
number, no finding.

Write evidence so a reader who cannot see your tool output can still
check it: "coding phase ran 5 times, $3.40 beyond the first run" — not
"looped a lot".

## 3. Categorisation

Each finding gets exactly one category. Ask: **what file would fix
this?**

| Category | Fix lives in | Typical finding |
|---|---|---|
| `tenant-intelligence` | this install's `memory/`, `.coro/` | A fact true of *this company*: an internal registry needs a flag, a service has a quirk, a reviewer alias. |
| `base-intelligence` | agent, workflow, or skill markdown in the base layer | A generic procedure gap: an agent's instructions do not cover a situation any install would hit. |
| `runner-code` | runner TypeScript | Behaviour no markdown can fix: a tool errors, a state transition is wrong, a capability is missing. |

Two tests that resolve most ambiguity:

- **Would another company hit this?** No → `tenant-intelligence`.
- **Could a markdown edit fix it?** No → `runner-code`.

When a finding could plausibly be either intelligence or code, prefer
intelligence. A markdown change is cheaper to review, faster to land,
and reversible.

## 4. Severity

| Severity | Meaning |
|---|---|
| `high` | Blocks or escalates jobs, or wastes > $10 across the window. |
| `medium` | Measurable rework or repeated friction; nothing blocked. |
| `low` | Real but cheap; worth recording, easy to defer. |

## 5. What is not a finding

- **A single job's bad luck.** One rate-limit park, one flaky test.
- **A restatement of a metric.** "Jobs average 12 turns" answers
  nothing on its own.
- **A remedy you cannot name.** If you cannot say which file changes
  and roughly how, you have a symptom. Log it and move on.
- **Something already fixed.** Check past retrospectives with
  `list_jobs({ scope: "retrospective" })` before writing anything up.
- **Anything about a specific person.** Reviewer names, commit authors,
  and ticket assignees are out of scope. You analyse the agents.

## 6. Volume

Report **at most 5 findings**, ranked by severity. A retrospective that
proposes twenty changes gets none of them reviewed. Fewer, better-
evidenced findings land; long lists stall.
