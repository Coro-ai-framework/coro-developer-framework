---
display_name: Memory Curator
description: Internal workflow that grooms the tenant memory bundle. Not user-launchable.
kind: internal

initial_phase: curating
initial_status: queued

phases:
  - name: curating
    agent: agents/memory-curator.md
    model: planning
    status: curating
    interactive_checkpoint: true
---

# Workflow: Memory Curator

## Purpose

Bound the size of the tenant's memory bundle. Coro's memory grows
monotonically — every job appends — and `read_memory({})` returns the
full bundle on every job, so verbose or duplicated entries tax every
future run forever. This workflow is the **only** path that is allowed
to **overwrite or delete** memory entries. It runs on demand (operator-
or evaluator-triggered) when a memory file blows past its token budget,
or when periodic audits find a critical mass of duplicates.

The curator does **not** add new findings. Adding new entries is the
evaluator's job, governed by the per-entry length budgets in
[`agents/evaluator.md`](../../agents/evaluator.md). The curator's job
is **subtractive**: merge duplicates, trim verbose entries to the
budget, drop stale entries, and re-emit the affected files in canonical
short-form layout.

## Trigger

This workflow is dispatched as a normal Run. Typical triggers:

1. **Operator-initiated** — the dashboard or CLI runs
   `coro job --workflow memory-curator --description "Trim
   known-pitfalls.md"` when memory feels heavy.
2. **Evaluator-initiated** — the evaluator records an
   `intelligence-gap` insight when it observes that a target memory
   file exceeds the tenant's configured token budget. A periodic job
   may aggregate those signals into a single curator Run.

Tenants may add policy (e.g. "auto-dispatch a curator when
`known-pitfalls.md` exceeds 800 lines") via their own automation. The
base layer ships only the workflow contract.

## Phases

### `curating`

The `memory-curator` agent reads the memory bundle, identifies
candidates for merge / trim / removal, and ships **one** consolidated
`propose_change` per affected layer. The runtime constraint that
limits an evaluator to one proposal per `(jobId, layer)` applies here
too: the curator must batch all of its edits into a single PR per
layer.

The phase is interactive by default — the proposed PR replaces existing
human-authored notes, so a developer must approve before the change
takes effect.

## Output

- One PR per writable layer with the trimmed, canonicalised memory
  files.
- An evaluation-style report at
  `working/{job-id}/curator-report.md` summarising what was merged,
  trimmed, or dropped, and why.

## Important rules

- This workflow is **subtractive**. Never use it to add net-new
  findings; that path is the standard implementation workflow's
  evaluator phase.
- The curator must respect the per-entry length budgets defined in
  [`agents/evaluator.md`](../../agents/evaluator.md) §8. Anything that
  would land outside the budgets is a bug in the curator's logic, not
  the budget.
- `MEMORY.md`'s index must be regenerated when entries are merged or
  removed so future jobs do not chase dangling references.
