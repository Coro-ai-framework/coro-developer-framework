---
name: retrospective-analysis
description: >-
  Thresholds and categorisation rules for cross-job self-analysis. Read at the
  start of the retrospective `analysis` phase, before reading any job report.
  Defines what counts as a systemic finding, what evidence each finding needs,
  which intelligence layer owns the fix, and how to verify a remedy against the
  code before naming the files it changes.
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

## 4. Verify against the code — then name every copy

A remedy is worth exactly as much as the file list attached to it, and a
file list is worth nothing if you guessed it.

**The order is not negotiable.** Findings come from job metrics; the code
is where you *check* them. Read the code first and you will start
reporting things that look wrong in a file — with no evidence that they
ever cost anyone anything. That is the failure this whole skill exists to
prevent, and the two-job evidence bar (§2) applies to every finding
regardless of how convincing the code looks.

So: form the candidate from the reports, then verify it, then write it
up.

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

`upstream_checkout` helps here too, and the two trees answer different
questions — keep them straight:

| Tree | Contains | Use it to |
|---|---|---|
| `_intelligence/` | base + tenant + repo, **merged** | See what the agents actually read on this install. |
| `_upstream/packages/intelligence-base/layer/` | the base layer alone, at upstream `main` | See what a PR would change, and whether it is already fixed. |

A phrase present in `_intelligence/` but absent from `_upstream/` is not
a base-layer finding: it came from an overlay, or upstream has already
edited it away.

### `runner-code` findings: read the code before you describe it

Call **`upstream_checkout`**. It puts a read-only snapshot of upstream's
default branch in `_upstream/`, and from there the claim you are about to
publish is checkable:

```
grep -rn "phaseUsage" _upstream/packages/runner/src/tools/job-history.ts
```

Three things that check buys you, all of which have gone wrong without
it:

1. **A wrong premise caught before it is public.** "The report exposes
   only aggregate phase cost" is an observation from the report; "the
   per-run data is not persisted" is a guess about the code — and if the
   data was there all along, a maintainer has to correct your issue
   before they can act on it. Read the type before you claim it lacks a
   field.
2. **A defect already fixed.** The snapshot is upstream's default branch,
   not the version that produced your job history. If the fix is already
   there, the finding is closed, not filed.
3. **The real file list.** Name the files you actually found, and the
   function inside them. `targetPaths` feeds the dedup fingerprint, so
   "paths to be located during implementation" makes your issue fail to
   match the identical issue from another install.

Cite the commit sha the tool returns, so a reader knows what you checked.

If `upstream_checkout` refuses or fails — no contribution destination
enabled for this run, no network — you are back to inferring. Then, and
only then: **label every implementation claim as a hypothesis**, and
still name a module from the map below rather than leaving the paths
vague.

Start looking here:

| Behaviour | Lives in |
|---|---|
| `list_jobs`, `get_job_report`, `get_job_log_excerpts` | `packages/runner/src/tools/job-history.ts` |
| Alias/leak checking of anything public | `packages/runner/src/tools/sanitize.ts` |
| `upstream_*`, `dispatch_improvement_job` | `packages/runner/src/tools/upstream.ts`, `upstream-source.ts` |
| Retrospective dispatch, findings/outcome parsing | `packages/runner/src/jobs/retrospective.ts` |
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

Paths in `targetPaths` are always **repo-relative**: strip the `_upstream/`
prefix from what you grepped. If nothing in that table fits and the
snapshot did not help either, say so and describe the behaviour instead of
inventing a path.

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
  `list_jobs({ scope: "retrospective" })`, and — for anything going
  upstream — check the code itself in `_upstream/`. Your job history is
  older than upstream's `main`.
- **Anything about a specific person.** Reviewer names, commit authors,
  and ticket assignees are out of scope. You analyse the agents.

## 7. Volume

Report **at most 5 findings**, ranked by severity. A retrospective that
proposes twenty changes gets none of them reviewed. Fewer, better-
evidenced findings land; long lists stall.
