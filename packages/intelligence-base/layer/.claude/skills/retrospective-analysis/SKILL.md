---
name: retrospective-analysis
description: >-
  Thresholds and categorisation rules for cross-job self-analysis. Read at the
  start of the retrospective `analysis` phase, before reading any job report.
  Defines what counts as a systemic finding, what evidence each finding needs,
  which intelligence layer owns the fix, and which files a remedy must name.
---

# Retrospective analysis

Turning many job records into a short list of things worth fixing. The
failure mode this skill guards against is a report full of true but
useless observations ("job X cost $4.10"). A finding earns its place
only when it names a **repeatable** problem and a layer that can fix it.

## 1. What you are looking for

Six signals, in rough order of how often they turn out to be real.

### Phase rework

**A repeated phase is not a loop.** `coding → review → coding` is the
required path for every work item, so a job with four work items runs
`coding` four times by design; and when a developer approves a
checkpoint, the runner re-enters that phase so the agent can finish its
turn, adding one more run per approval. Counting raw runs as rework makes
a well-behaved job look pathological.

The report does that subtraction for you. Use `reworkRuns` and
`reworkCostUsd` from `phases[]` (or the `reworkPhases[]` shortlist);
`phaseRuns[]` names each individual execution and its attribution —
`work-item`, `checkpoint-resume`, or `rework` — when you need to show your
arithmetic. Never build a rework claim out of `runs` alone.

**Threshold:** `reworkRuns ≥ 1` on the same phase in **≥ 30% of the
window** (minimum 2 jobs). One job looping four times is a bad day; a
third of jobs reworking the same phase is a missing instruction.

Cost of the finding = sum of `reworkCostUsd` across the citing jobs.
Quote it — "$11 of avoidable rework across 4 jobs" is what makes a
maintainer act. If that sum is what puts the finding over the `high`
severity bar, say the number in the finding, not just in your reasoning.

The attributions are derived, not recorded, and they are tuned to
undercount: a run is only `rework` when nothing structural explains it.
So treat `reworkRuns` as a floor. If a phase shows zero rework but still
looks expensive, the finding is about cost, not loops.

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
check it: "coding reworked 3 times beyond its per-work-item runs, $3.40"
— not "looped a lot".

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

## 4. Target paths — name every copy

A remedy is worth exactly as much as the file list attached to it. Two
rules, because the two categories fail differently.

### Intelligence findings: search before you list

The intelligence layer states important things in several places on
purpose — the always-loaded `CLAUDE.md`, the agent that does the work, the
skill that carries the detail, and the workflow that sequences it. So a
procedure gap is rarely in one file, and a proposal that fixes one of four
copies leaves the defect live and gets it re-filed next month.

The merged tree you are running against is right there in your working
directory, so check instead of guessing:

```
grep -rn "cd <repoCheckoutDir>" _intelligence/
```

Then map each hit back to a repository path before writing `targetPaths`:
`_intelligence/<path>` → `packages/intelligence-base/layer/<path>`.

Two traps in that mapping:

- `_intelligence/` is **merged**, so a hit may come from a tenant or repo
  overlay rather than the base layer. Appended content is banner-marked
  (`<!-- ─── coro layer: tenant:… ─── -->`). A phrase that exists only
  below such a banner is a `tenant-intelligence` finding.
- Sibling files often carry the same line by copy (every
  `*-conventions` skill, every agent that runs commands). List them all,
  or say explicitly which you are leaving alone and why.

### `runner-code` findings: name the module, mark the hypothesis

You have no checkout of the runner, so you cannot read the code you are
describing. Two consequences, both mandatory:

1. **Lead with observed behaviour**, and label any claim about the
   implementation as a hypothesis. "The report exposes only aggregate
   phase cost" is an observation; "the data is not persisted" is a guess —
   and a wrong guess turns a good report into one a maintainer has to
   correct before they can act.
2. **Still name a module.** `targetPaths` feeds the dedup fingerprint, so
   "paths to be located during implementation" makes your issue fail to
   match the identical issue filed by another install. Use this map:

| Behaviour | Lives in |
|---|---|
| `list_jobs`, `get_job_report`, `get_job_log_excerpts` | `packages/runner/src/tools/job-history.ts` |
| Alias/leak checking of anything public | `packages/runner/src/tools/sanitize.ts` |
| `upstream_*`, `dispatch_improvement_job` | `packages/runner/src/tools/upstream.ts` |
| `propose_change`, `list_proposals`, `add_insight` | `packages/runner/src/tools/self-improvement.ts` |
| Proposal branches, commits, PRs | `packages/runner/src/intelligence/writer.ts` |
| Layer merge, per-job materialisation | `packages/runner/src/intelligence/resolver.ts`, `merge.ts` |
| Phase loop, advance, checkpoint parks, completion gate | `packages/runner/src/jobs/runner.ts`, `completion-gate.ts` |
| Resumes, developer messages, child jobs | `packages/runner/src/jobs/dispatcher.ts` |
| The per-phase kickoff prompt | `packages/runner/src/jobs/phase-kickoff.ts` |
| The system prompt | `packages/runner/src/prompt/builder.ts` |
| Workflow front-matter parsing | `packages/runner/src/workflow-parser.ts` |
| Tool registration, schemas, descriptions | `packages/runner/src/mcp-server.ts`, `mcp-handlers.ts` |
| SCM / tracker behaviour | `packages/runner/src/plugins/`, `packages/runner/src/clients/` |
| Job persistence | `packages/runner/src/state/` |
| The `Job` shape and lifecycle statuses | `packages/cloud-protocol/src/job-types.ts` |
| HTTP API the dashboard and CLI use | `packages/runner/src/runner/server.ts` |

If nothing in that table fits, say so and describe the behaviour instead
of inventing a path.

## 5. Severity

| Severity | Meaning |
|---|---|
| `high` | Blocks or escalates jobs, or wastes > $10 across the window. |
| `medium` | Measurable rework or repeated friction; nothing blocked. |
| `low` | Real but cheap; worth recording, easy to defer. |

## 6. What is not a finding

- **A single job's bad luck.** One rate-limit park, one flaky test.
- **A restatement of a metric.** "Jobs average 12 turns" answers
  nothing on its own.
- **A remedy you cannot name.** If you cannot say which files change
  (all of them — see §4) and roughly how, you have a symptom. Log it and
  move on.
- **Something already fixed.** Check past retrospectives with
  `list_jobs({ scope: "retrospective" })` before writing anything up.
- **Anything about a specific person.** Reviewer names, commit authors,
  and ticket assignees are out of scope. You analyse the agents.

## 7. Volume

Report **at most 5 findings**, ranked by severity. A retrospective that
proposes twenty changes gets none of them reviewed. Fewer, better-
evidenced findings land; long lists stall.
