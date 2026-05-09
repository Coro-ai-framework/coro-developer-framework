---
name: register-convention
description: >-
  How to maintain `register.json` — the per-job, append-only ledger that tracks
  the lane, the architectural decisions made, the contracts touched, the
  traceability from work items → files → tests, and the rollout plan. Read
  before writing to it; every agent that mutates the repo also appends its row.
---

# Register Convention

`register.json` is the **single shared ledger** for a job. It lives in the job
working directory at `working/{job-id}/register.json` and is **append-only** —
agents add entries, they never rewrite or delete prior ones. The reviewer and
the evaluator read it to check scope and traceability without having to
re-derive the picture from prose.

There is **no MCP tool** for it. Use plain `Read` / `Write` (or `Bash` with
`jq`). The file is a single JSON document; appends are done by reading,
mutating in memory, and writing back.

## Why it exists

Large jobs lose context across phases:
- The Planner picks a lane and decomposes work items.
- The Coder makes a decision four hours later that quietly contradicts the
  plan, and nobody notices until QA.
- The Reviewer reads only the diff and has no way to verify "this PR really
  delivers acceptance criterion #3."
- The Evaluator has to reconstruct what was promised vs what was delivered
  from scattered logs.

`register.json` collapses all of that into one structured surface. Each agent
writes a small, well-typed row when it makes a decision the next agent needs
to know about. By the time the Evaluator runs, the full provenance is
inspectable in O(1) reads.

## File shape

```json
{
  "jobId": "<job-id>",
  "lane": "fast | standard | deep",
  "createdAt": "<iso>",
  "decisions": [
    {
      "id": "D-1",
      "at": "<iso>",
      "by": "planner | coder | spec-writer | reviewer",
      "phase": "<phase-name>",
      "title": "Use cursor-based pagination instead of offset",
      "context": "Why this came up",
      "decision": "What we chose",
      "consequences": "Trade-offs accepted"
    }
  ],
  "contracts": [
    {
      "id": "C-1",
      "kind": "api | schema | message | cli | config",
      "name": "POST /v1/users/:id/limits",
      "shape": "Brief shape description or link to a spec section",
      "introducedBy": "work-item-id-or-name",
      "consumers": ["service-a", "service-b"]
    }
  ],
  "traceability": [
    {
      "workItem": "<work-item-name>",
      "spec": "feature-spec.md#acceptance-criteria-3",
      "plan": "implementation-plan.md#work-item-1",
      "files": ["src/handlers/limits.go", "src/handlers/limits_test.go"],
      "tests": ["TestLimitsHandler_HappyPath", "TestLimitsHandler_RateLimited"],
      "pr": "<pr-url-once-opened>"
    }
  ],
  "rollout": {
    "strategy": "feature-flag | direct | staged | migration-then-cut-over",
    "notes": "How to safely deploy and rollback",
    "owner": "<who pushes the button>"
  }
}
```

All top-level arrays are optional — write what is true at the time you append,
omit what is not yet known.

## Per-agent responsibilities

### Planner

Initialise the register at the end of the planning phase, after
`set_work_items`:

- `lane`: the value of `params.lane` (or `"standard"` when unset).
- `traceability`: one row per work item, with `spec` and `plan` anchors,
  and `files` populated with the **planned** file list (exact paths from the
  plan). Leave `tests` and `pr` empty for now.
- `rollout`: best-effort first cut. The Coder and the Evaluator may revise it
  in subsequent phases via new `decisions[]` entries (never by editing the
  rollout block in place).

Skip on FAST lane unless the job has more than one acceptance criterion —
FAST is meant for changes small enough to live in the PR description.

### Spec Writer

When run (DEEP lane or tracker-triggered jobs), seed `contracts[]` from the
acceptance criteria where each AC implies a public surface change. Do **not**
invent contracts that aren't in the ticket — flag ambiguity in
`feature-spec.md` instead.

### Coder

Each time you finish a work item:

- Append to the matching `traceability[]` row: replace the planned `files`
  with the **actually-touched** list, fill in `tests` with the test names you
  added/touched, and set `pr` to the PR URL after `scm_create_pr`.
- If you made a non-trivial implementation choice that diverges from the
  plan, append a `decisions[]` entry. The bar: would the next agent / a future
  reader regret not knowing this? If yes, write it.
- If you introduced or modified a contract (new endpoint, schema field,
  message format, CLI flag, config key), append a `contracts[]` entry.

### Code-Reviewer subagent

**Read** the register before reviewing. The L2 lens (scope / traceability) is
defined as:

1. Every `traceability[].files` entry should appear in the diff.
2. Every file in the diff should appear in some `traceability[].files`.
3. Every `contracts[]` entry introduced this job must have a test referenced
   in the same `traceability[].tests`.

Discrepancies become **blocking** findings. Do not write to the register —
record observations as `add_insight` instead.

### Evaluator

Read the register during QA / evaluation. The acceptance-criteria check is:
walk every `traceability[]` row, run its `tests`, confirm each row's spec
anchor is satisfied. If a row has no `pr` field, the work item never shipped
and the job cannot pass.

## Append discipline

This is **not** a free-form log. Each entry has a stable `id` and the array it
lives in is append-only. Rules:

- **Never delete** an entry. If a decision is reversed, write a new
  `decisions[]` entry that supersedes it (`"supersedes": "D-3"` in the body
  is fine — but D-3 stays in the file).
- **Never edit** an existing entry's `id`, `at`, `by`, or `phase`. The other
  fields can be amended **only** by the agent that originally wrote the entry,
  in the same phase. Otherwise: append a new entry.
- **Stable IDs**: prefix by section (`D-` decisions, `C-` contracts) and use
  the next free integer. Read the file first to find the next id.
- **No prose dumps**. Each field is short — a sentence or two. If you need to
  explain at length, write the prose in `working/{job-id}/notes/` and link to
  it.

## Storage and visibility

- Lives at `working/{job-id}/register.json`.
- The runner's per-job working directory is preserved long enough for the
  Evaluator to read it; the dashboard surfaces it as an artefact when the
  Coder calls `post_artifact({ kind: "register", title: "Register",
  data: { path: "register.json" } })` (do this after the first non-trivial
  append).
- Tenants may extend this convention via their overlay (`memory/snippets/`)
  with org-specific fields, but **never** rename or repurpose the four
  canonical sections — the reviewer and evaluator read those positionally.
