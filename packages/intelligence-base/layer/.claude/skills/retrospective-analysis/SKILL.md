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
window** (minimum 2 jobs), counting only the runs that survive the check
below. One job looping four times is a bad day; a third of jobs reworking
the same phase is a missing instruction.

Cost of the finding = sum of `reworkCostUsd` across the citing jobs.
Quote it — "$11 of avoidable rework across 4 jobs" is what makes a
maintainer act. If that sum is what puts the finding over the `high`
severity bar, say the number in the finding, not just in your reasoning.

**The attributions may be recorded or derived.** New snapshots carry
`attribution` and `parkReason` stamped at append time (`attributionSource:
"recorded"`). Older jobs still derive. Prefer recorded values. A
`parkReason` on a zero-cost run is a park, not a loop — you no longer
need to grep logs to see that when the field is present.

Where a derived run still looks wrong, confirm in the log before you write
the finding:

```
get_job_log_excerpts({ jobId, pattern: "parked|phase advanced" })
```

One `Job parked — waiting for:` per repeat is a structural cause, and the
run is not rework however the report labelled it. A run that survives the
check is still only a floor: a phase with no rework that nevertheless
looks expensive is a cost finding, not a loop finding.

### Escalation clusters

Group `escalationMessage` values by root cause, not by wording. Three
jobs escalating on "could not resolve reviewer" is one finding.

**Threshold:** ≥ 2 jobs with the same root cause.

### Recurring tool or build failures

`cluster_window` groups tool-ledger failures and normalised error classes
for you. Do not group errors by eyeballing log tails. Use
`get_job_log_excerpts` only as drill-down after the cluster names a class.

**Threshold:** same cluster key in ≥ 3 jobs.

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

Call **`cluster_window`** before forming any finding. It is the grouping
step; your job is to name the behaviour and pick a layer. Findings that
were not visible in the cluster (or in a `get_job_trace_summary` follow-up)
are code review, not retrospective.

Every finding carries `evidence[]` with **at least two entries**, each
naming a real `jobId` and a concrete number pulled from a report or
cluster. No number, no finding.

**Exception — evidence-pipeline defects.** If the report, ledger, or
cluster schema itself is broken, one citing job is enough and severity is
`high`. That is the only one-job finding.

Every finding also carries:

- `counterEvidence[]` — jobs in the window that did **not** show it. Empty
  is allowed only when every job in the window hit it; say so.
- `verification`: `verified` after a grep against `_intelligence/` /
  `_upstream/`, otherwise `hypothesis`.
- `predictedMetric` — `{ name, direction, baseline }` so the next
  retrospective can score the remedy. Use names like `coding.reworkRuns`,
  `costUsd`, `escalationCount`.

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

When a tool error, state transition, or missing capability is involved,
categorise **`runner-code` first** and name the test that should fail
today. Intelligence changes are for procedure gaps, and they are
section-level patches — not a rewritten `coder.md`. A markdown bandaid
that leaves the bug live will be scored `still-firing` next month.

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
2. **A defect already fixed — if the direction of time works out.** The
   snapshot is upstream's default branch, not the version that produced
   your job history, so a remedy you find there may postdate your
   evidence. It may equally have been in place the whole time, and then it
   is not a remedy at all. See §6 before clearing anything on this basis.
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

That table measures wasted money and blocked jobs, which is what most
findings are about. Two kinds are `high` whatever they cost:

- **A defect in the evidence you reason from.** If a metric, a report
  field, or a log view is wrong, every finding measured through it is
  unsafe — yours, and every future run's. Dollars are the wrong yardstick
  here; state instead what it made you unable to conclude.
- **A defect that cost you another finding.** If you dropped or
  downgraded a candidate because you could not trust the data behind it,
  the defect outranks the candidate.

## 6. What is not a finding

- **A single job's bad luck.** One rate-limit park, one flaky test.
- **A restatement of a metric.** "Jobs average 12 turns" answers
  nothing on its own.
- **A remedy you cannot name.** If you cannot say which files change
  (all of them — see §4) and roughly how, you have a symptom. Log it and
  move on.
- **Something already fixed — and you can show it.** Check past
  retrospectives with `list_jobs({ scope: "retrospective" })`, and, for
  anything going upstream, the code in `_upstream/`.

  Seeing the remedy in the code is **not** enough to clear a finding. Two
  things have to hold as well, and both have been got wrong:

  - **The runs have to predate it.** The snapshot cannot tell you when a
    line landed — it is a depth-1 tree with no history — so unless a past
    retrospective or a memory entry dates the change, you do not know.
    Jobs that hit the behaviour *after* a remedy was in place make the
    finding stronger, not weaker.
  - **It has to address the same mechanism.** A setting that governs the
    model SDK's permission prompts does not affect a denial from Coro's
    own tool hooks, however similar the agent's description of the two
    sounds. Match the remedy to the failure, not to the wording.

  When you cannot establish both, report it with the contradiction stated
  — "the guard is on `main` at `<sha>` and three runs still hit this, so
  either it misses this case or the installed build predates it". That is
  a better issue than the symptom alone. What this failure mode eats is
  precisely the loudest signals, because those are the ones whose remedy
  looks obvious enough to assume.
- **Anything about a specific person.** Reviewer names, commit authors,
  and ticket assignees are out of scope. You analyse the agents.

## 7. Report it even when it cannot ship

"Checked and cleared" is for signals that did not clear the bar. It is not
a drawer for real problems that have nowhere to go, and two things must
never end up there.

- **A finding whose destination is disabled for this run.**
  `params.tiers` decides where a finding may travel, not whether it
  exists. Report it as a finding, with its real category and evidence, and
  say in the remedy that its destination is not enabled — `shipping` will
  record it as not shipped for that reason, which is exactly the note a
  developer needs to decide whether to re-run with the tier on. Clearing
  it instead makes a three-job problem invisible because of a launch
  toggle.
- **A candidate you dropped because you could not trust the data.** Name
  the finding that blocked it, by id. "Not enough evidence" and "the
  evidence is unreliable, and finding-1 is about that" are different
  statements, and only the second one ever gets fixed.
- **A signal you believe is already fixed but cannot date.** §6 has the
  two conditions and the wording to use. If you find yourself writing
  "the remedy appears to be present" plus an action for the developer to
  go and check, you have written a finding, not a clearance.

## 8. Volume

Report **at most 5 findings**, ranked by severity. A retrospective that
proposes twenty changes gets none of them reviewed. Fewer, better-
evidenced findings land; long lists stall.
