# Workflow extension contract

**Audience:** Coro maintainers, contributors adding new workflows
**Status:** Design — adoption is incremental (see §5)
**Last updated:** 2026-05-04

---

## 1. Why this document exists

Coro's design rule is:

> **Markdown files are the intelligence. TypeScript is the tool shell.**

Adding a new workflow (e.g. a release-coordination flow, a security-audit
flow, an SRE on-call triage flow) **must** be possible by shipping
intelligence-only edits — new files under
`packages/intelligence-base/layer/` (or a tenant overlay), with **zero**
diff in `packages/runner` and `packages/dashboard` source.

Today this is **not yet true** for orchestrated multi-issue workflows.
Campaign-specific concepts have leaked into the runner and dashboard
codebases. This document inventories that bleed and specifies the
generic contract that replaces it. The migration is staged behind
feature flags so the existing campaign flow keeps working while the
contract is rolled out.

---

## 2. Audit: where workflow-specific code lives today

The following symbols are workflow-specific (campaign-aware) but live in
generic modules. Each entry names the file, the intent, and what
replaces it under the new contract.

### 2.1 Runner state model

| Location | Symbol | Notes |
|----------|--------|-------|
| [`packages/runner/src/jobs/types.ts`](../packages/runner/src/jobs/types.ts) | `CampaignChild`, `CampaignChildStatus`, `Job.campaignChildren`, `Job.campaignParentId`, `Job.campaignAggregatedInsights`, `STATUS_AWAITING_CHILDREN`, `CAMPAIGN_WORKFLOW_PATH`, `isCampaignJob`, `isTerminalChildStatus` | The orchestration data model is welded to the campaign workflow. |
| [`packages/runner/src/state/sqlite-backend.ts`](../packages/runner/src/state/sqlite-backend.ts) | `campaignParentId` filter, comments referencing `convert_to_campaign` and `campaign-planning` | Storage layer assumes the campaign workflow exists. |
| [`packages/runner/src/state/redis-backend.ts`](../packages/runner/src/state/redis-backend.ts) | `campaignParentId` filter, parent-child set lookups | Same. |
| [`packages/runner/src/cloud/db/schema.ts`](../packages/runner/src/cloud/db/schema.ts) | `campaign_children` (jsonb), `campaign_parent_id` (text), `jobs_campaign_parent_idx` | Schema columns named after the workflow. |
| [`packages/runner/src/cloud/db/postgres-backend.ts`](../packages/runner/src/cloud/db/postgres-backend.ts) | Mapping helpers for the above columns | Same. |

### 2.2 Runner dispatcher / coordinator

| Location | Symbol | Notes |
|----------|--------|-------|
| [`packages/runner/src/jobs/dispatcher.ts`](../packages/runner/src/jobs/dispatcher.ts) | `CAMPAIGN_COORDINATING_PHASE`, `CAMPAIGN_AGGREGATION_PHASE`, `CHILD_WORKFLOW_PATH`, `DEFAULT_MAX_PARALLEL_CHILDREN`, `coordinateCampaign`, `campaignSkipChild`, `campaignRerunChild`, `campaignCancelChild` | The coordinator hook is hard-wired to one workflow. A new workflow that wants to dispatch sub-runs cannot. |

### 2.3 Runner MCP tool surface

| Location | Symbol | Notes |
|----------|--------|-------|
| [`packages/runner/src/tools/campaign.ts`](../packages/runner/src/tools/campaign.ts) | `convertToCampaign`, `campaignRegisterChild`, `campaignFinalize`, `campaignStatus`, `campaignSkipChild`, `campaignRerunChild`, `campaignCancelChild`, `jobStatusToChildStatus`, `reconcileReady` | Workflow-specific MCP tools registered into a generic toolset. |
| [`packages/runner/src/mcp-handlers.ts`](../packages/runner/src/mcp-handlers.ts) | Handlers for every tool above | Same. |
| [`packages/runner/src/mcp-server.ts`](../packages/runner/src/mcp-server.ts) | Tool registration entries | Same. |

### 2.4 Runner HTTP server

| Location | Symbol | Notes |
|----------|--------|-------|
| [`packages/runner/src/runner/server.ts`](../packages/runner/src/runner/server.ts) | `enrichCampaignChildren`, `?campaignParentId` query param, `/jobs/:id/children/:name/{skip,rerun,cancel}` routes | Endpoints named after the workflow. |

### 2.5 Runner config & prompt

| Location | Symbol | Notes |
|----------|--------|-------|
| [`packages/runner/src/config/settings.ts`](../packages/runner/src/config/settings.ts) | `tracker.*` defaulted-for-campaign comments | Documentation-level only; the tracker MCP surface itself is generic. |
| [`packages/runner/src/prompt/builder.ts`](../packages/runner/src/prompt/builder.ts) | `tracker` prompt context block | Same — surfaces workflow-relevant context only when the tracker is configured; not strictly campaign-specific. |

### 2.6 Dashboard

The dashboard now has a centralised label util — see
[`packages/dashboard/src/lib/run-labels.ts`](../packages/dashboard/src/lib/run-labels.ts).
The remaining campaign-aware code is intentionally fenced inside a
single component:

| Location | Symbol | Notes |
|----------|--------|-------|
| [`packages/dashboard/src/components/CampaignView.tsx`](../packages/dashboard/src/components/CampaignView.tsx) | The whole component | Workflow-specific sub-run rendering. Will become a generic `SubRunsView` driven by workflow metadata. |
| [`packages/dashboard/src/lib/jobs.ts`](../packages/dashboard/src/lib/jobs.ts) | `CAMPAIGN_WORKFLOW_PATH`, `isCampaignJob` | Detection helpers. Will become workflow-metadata lookups once `GET /workflows` exists. |
| [`packages/dashboard/src/types.ts`](../packages/dashboard/src/types.ts) | `CampaignChild`, `CampaignChildStatus`, `Job.campaignChildren`, `Job.campaignParentId` | Mirrors the runner state shape. |

---

## 3. Target contract

### 3.1 Generic parent / sub-run model on `Job`

Replace campaign-specific fields with a generic shape. The wire and on-disk
schema use neutral names; the campaign workflow is just one consumer.

```ts
export interface SubRunSpec {
  /** Unique within the parent run. Used as the dependsOn key. */
  name: string
  /** Free-form description handed to the sub-run's planner. */
  description: string
  /**
   * Seed `params` for the dispatched sub-run Job. The dispatcher merges in
   * `parentJobId: <parent>` (and any per-workflow defaults declared in the
   * coordinator metadata) before creation.
   */
  params: Record<string, unknown>
  /** Names of other sub-runs this one is blocked on. */
  dependsOn: string[]
  /** Tracker issue key/url, if the planner created one. */
  trackerRef?: TrackerRef
  /** Job id once dispatched. */
  jobId?: string
  status: SubRunStatus
  startedAt?: string
  completedAt?: string
}

export type SubRunStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'complete'
  | 'failed'
  | 'escalated'
  | 'skipped'

export interface Job {
  // … existing fields …
  /** When this run hosts sub-runs, the registered specs. */
  subRuns?: SubRunSpec[]
  /** When this run was dispatched as a sub-run, the parent's id. */
  parentJobId?: string
  /** Insights forwarded from earlier sibling sub-runs. */
  aggregatedSiblingInsights?: Insight[]
}
```

The status `awaiting-sub-runs` replaces `awaiting-children`.

### 3.2 Coordinator metadata in workflow front matter

Workflows that orchestrate sub-runs declare it in their front matter.
The runner reads this — no per-workflow constants live in the dispatcher.

```yaml
---
initial_phase: campaign-planning
initial_status: campaign-planning

phases:
  - { name: campaign-planning, agent: agents/campaign-planner.md, model: planning, status: campaign-planning, interactive_checkpoint: true }
  - { name: coordinating, agent: null, model: planning, status: awaiting-sub-runs }
  - { name: aggregation, agent: agents/campaign-evaluator.md, model: planning, status: aggregating, interactive_checkpoint: true }

coordinator:
  enabled: true
  # Phase the parent parks in while sub-runs execute.
  parkPhase: coordinating
  parkStatus: awaiting-sub-runs
  # Phase the parent is resumed into once every sub-run reaches a terminal status.
  resumePhase: aggregation
  # Workflow path for dispatched sub-runs.
  subRunWorkflowPath: workflows/job/workflow.md
  # Default seed params merged into every sub-run (e.g. epicAllowed=false).
  subRunParamsDefault:
    epicAllowed: false
  # Concurrency cap; tenants can override via settings.coordination.maxParallelSubRuns.
  maxParallelSubRuns: 1
  # Failure handling when a sub-run reaches `failed` or `escalated`.
  failurePolicy: halt-on-failure   # | continue
  # When true, also forward each sub-run's insights to siblings dispatched after.
  forwardSiblingInsights: true
---
```

Workflows without `coordinator.enabled = true` cannot register sub-runs;
calls to the orchestration MCP tools below fail validation. This keeps
the contract opt-in and keeps simple workflows simple.

### 3.3 Generic orchestration MCP tools

Replace the `campaign_*` family with workflow-neutral tools. Names are
verbs that read naturally from any orchestrating workflow:

| Tool | Replaces | Purpose |
|------|----------|---------|
| `convert_to_workflow({ workflowPath, params? })` | `convert_to_campaign` | In-place promotion: flip the active Job's `workflowPath`, reset phase, seed `subRuns: []`. Validates against the `coordinator.enabled` flag of the target workflow. |
| `register_sub_run({ name, description, params, dependsOn, trackerRef? })` | `campaign_register_child` | Append a sub-run spec to the parent's `subRuns[]`. |
| `finalize_sub_runs()` | `campaign_finalize` | Cycle-detect the dependency graph, mark parent ready to park. |
| `sub_run_status()` | `campaign_status` | Read aggregation used by aggregation-phase agents and the dashboard. |
| `skip_sub_run({ name, reason? })` | `campaign_skip_child` | Live-control mutation (operator + aggregation-phase agent). |
| `rerun_sub_run({ name, reason? })` | `campaign_rerun_child` | Same. |
| `cancel_sub_run({ name, reason? })` | `campaign_cancel_child` | Same. |

Each tool is registered once for **every** Job whose workflow has
`coordinator.enabled = true`; for any other workflow, the tools either
aren't exposed or return a permission error citing the workflow's
declared coordinator config.

The legacy `campaign_*` names are kept as **thin aliases** during the
migration window so existing intelligence keeps working.

### 3.4 Dispatcher coordinator hook driven by workflow metadata

The dispatcher's coordinator hook reads `coordinator: {…}` from the
parent Job's resolved workflow front matter and runs a generic loop:

1. Halt on failure (or continue) per `failurePolicy`.
2. Compute the ready-set from `subRuns[].dependsOn` against the current
   per-sub-run statuses.
3. Dispatch up to `maxParallelSubRuns` ready sub-runs with the merged
   params (`subRunParamsDefault` ∪ per-spec `params` ∪ `parentJobId`).
4. When every sub-run is terminal, park-resume the parent into
   `coordinator.resumePhase`.

The dispatcher has **no** workflow-name constants. Adding a new
orchestrating workflow is a front-matter declaration plus the
agent/skill markdown.

### 3.5 Workflow discovery API

The runner exposes workflow metadata to the dashboard so UI is
dynamically driven.

```http
GET /workflows
```

```json
{
  "workflows": [
    {
      "id": "job",
      "label": "job",
      "description": "Scoped change in an existing repository.",
      "workflowPath": "workflows/job/workflow.md",
      "phases": [{"name": "planning", "status": "planning"}, …],
      "coordinator": null,
      "createParams": {
        "required": ["repo", "description"],
        "optional": ["reviewers", "jiraTicketId", "gitProvider"]
      }
    },
    {
      "id": "campaign",
      "label": "campaign",
      "description": "Multi-issue feature; orchestrates sub-runs.",
      "workflowPath": "workflows/campaign/workflow.md",
      "phases": [{"name": "campaign-planning", "status": "campaign-planning"}, …],
      "coordinator": {
        "subRunWorkflowPath": "workflows/job/workflow.md",
        "maxParallelSubRuns": 1,
        "failurePolicy": "halt-on-failure"
      },
      "createParams": { … }
    }
  ]
}
```

The dashboard renders Run rows with the right workflow tag, builds the
**workflow filter** options, and toggles the sub-run section based on
`coordinator !== null` — all from this metadata. There is no hardcoded
`isCampaignJob` reference in dashboard code once this is wired.

### 3.6 Status taxonomy moves into intelligence

`STATUS_AWAITING_CHILDREN` becomes the generic `STATUS_AWAITING_SUB_RUNS`
that any workflow with `coordinator.enabled = true` can use. Workflows
declare their own statuses in front matter (`phases[].status`); the
runner trusts those declarations. Code paths that today special-case
status names should use signals exposed via workflow metadata
(`coordinator.parkStatus`, `coordinator.resumePhase`) instead.

### 3.7 HTTP shape

The runner's HTTP shape becomes workflow-neutral. New paths:

| Method + path | Purpose |
|---------------|---------|
| `GET /jobs?parentJobId=…` | Sub-runs of a given parent (replaces `?campaignParentId=…`). |
| `POST /jobs/:id/sub-runs/:name/skip` | Replaces `/jobs/:id/children/:name/skip`. |
| `POST /jobs/:id/sub-runs/:name/rerun` | Replaces `/jobs/:id/children/:name/rerun`. |
| `POST /jobs/:id/sub-runs/:name/cancel` | Replaces `/jobs/:id/children/:name/cancel`. |

The legacy `?campaignParentId` and `/children/` paths remain as
aliases until the dashboard cuts over.

---

## 4. Acceptance criterion

Adding `workflows/release/workflow.md` to a tenant overlay (with
appropriate agents and skills) is a tenant or repo-layer PR. **Zero
diff** in `packages/runner` and `packages/dashboard` source for it to:

- dispatch through the standard CLI / dashboard / webhook path,
- park and resume on its declared statuses,
- spawn sub-runs if the workflow declares `coordinator.enabled = true`,
- surface in the unified Runs list with its workflow tag,
- offer the standard detail surface (phases, artifacts, controls).

Any required runner/dashboard change indicates a missing piece of the
extension contract; treat it as a contract gap, not a feature add.

---

## 5. Migration plan

The existing campaign flow keeps working at every step. The dashboard
already routes everything to a unified Runs surface and centralises
labels in [`lib/run-labels.ts`](../packages/dashboard/src/lib/run-labels.ts);
the runner side migration runs in three reversible stages.

### Stage 1 — Generic data shape, alias old names (additive only)

- Add `subRuns`, `parentJobId`, `aggregatedSiblingInsights`,
  `STATUS_AWAITING_SUB_RUNS` to [`packages/runner/src/jobs/types.ts`](../packages/runner/src/jobs/types.ts).
- Mirror campaign fields onto the generic ones at read time
  (`subRuns ??= campaignChildren`, `parentJobId ??= campaignParentId`).
- Add new state-backend filters on `parentJobId` alongside existing
  `campaignParentId` filters in [`sqlite-backend.ts`](../packages/runner/src/state/sqlite-backend.ts), [`redis-backend.ts`](../packages/runner/src/state/redis-backend.ts), and [`cloud/db/postgres-backend.ts`](../packages/runner/src/cloud/db/postgres-backend.ts).
- Cloud schema: add `parent_job_id` text column + `jobs_parent_idx`
  index alongside the existing `campaign_parent_id` column. Both
  populated for compatibility.

No behaviour changes; tests are green.

### Stage 2 — Coordinator hook reads workflow metadata

- Add `coordinator` to the workflow front-matter parser
  ([`packages/runner/src/workflow-parser.ts`](../packages/runner/src/workflow-parser.ts)).
- Refactor [`dispatcher.ts`](../packages/runner/src/jobs/dispatcher.ts):
  `coordinateCampaign` becomes `coordinateSubRuns(parent, coordinator)`.
  All `CAMPAIGN_*` constants are removed in favour of values read from
  the parent's resolved workflow.
- Add the generic MCP tools (`convert_to_workflow`,
  `register_sub_run`, `finalize_sub_runs`, `sub_run_status`,
  `skip_sub_run`, `rerun_sub_run`, `cancel_sub_run`) in a new
  [`packages/runner/src/tools/orchestration.ts`](../packages/runner/src/tools/orchestration.ts).
  Re-export the existing `campaign_*` names as thin aliases that delegate
  to the new tools.
- Add `GET /workflows` to [`runner/server.ts`](../packages/runner/src/runner/server.ts).
  Add `?parentJobId=` and `/jobs/:id/sub-runs/:name/{skip,rerun,cancel}`
  routes; keep legacy paths as aliases.

### Stage 3 — Update intelligence and cut over

- Update the campaign workflow file to declare its `coordinator: { … }`
  block.
- Update the campaign-planner intelligence to call the generic tools
  (`convert_to_workflow`, `register_sub_run`, `finalize_sub_runs`)
  rather than the `campaign_*` aliases.
- Update [`packages/dashboard`](../packages/dashboard) to fetch
  `GET /workflows` once at boot and to use `parentJobId` /
  `subRuns` / coordinator metadata everywhere
  ([`run-labels.ts`](../packages/dashboard/src/lib/run-labels.ts) becomes
  a small adapter over the metadata).

### Stage 4 — Remove aliases

When telemetry confirms no production traffic uses the legacy paths /
fields / tool names:

- Drop the `campaign_*` MCP aliases.
- Drop the `campaignChildren` / `campaignParentId` fields and column
  names (rename in a single migration pass).
- Drop the legacy HTTP routes.
- Delete [`packages/runner/src/tools/campaign.ts`](../packages/runner/src/tools/campaign.ts).

---

## 6. Open questions

- **Memory cycle aggregation for sub-runs.** Today the dispatcher
  forwards completed sub-run insights to siblings via
  `campaignAggregatedInsights`. Is this generic enough as
  `aggregatedSiblingInsights`, or do we need a per-coordinator policy
  in the front matter (e.g. for workflows where insights should not
  cross sub-runs)?
- **Recursion depth.** Today campaigns are flat (depth = 1) because
  `epicAllowed: false` is hard-coded as a sub-run param default.
  Should `coordinator` allow `maxRecursionDepth: N` so future
  workflows could opt into deeper trees safely?
- **`tenantId` propagation.** The current hop from parent to sub-run
  copies `tenantId` implicitly because both Jobs share a runner. A
  team-mode generalisation should make this explicit in the contract.

These are deliberately not answered now; they're the next questions
the implementation surfaces.

---

## 7. User-supplied workflow invariants (sized-lane release)

The base intelligence layer ships three sized job workflows
(`workflows/job-fast/workflow.md`, `workflows/job/workflow.md`,
`workflows/job-deep/workflow.md`) and a planner-driven lane router that
calls `switch_workflow` to move between them. **None of this is
mandatory** for user-supplied workflows. The following invariants
guarantee that a tenant or repo overlay can ignore the lane router,
add new lanes, or define entirely orthogonal workflow trees without
the harness fighting back.

### Invariant 1 — Lane decision is intelligence, not infrastructure

The Planner agent's lane router (the FAST / STANDARD / DEEP /
CAMPAIGN matrix) lives in `agents/planner.md`, not in TypeScript. A
user workflow whose first phase uses a different planner agent — or
whose phase set does not include any planning step — is free to skip
lanes entirely. The runner has no concept of "lane."

### Invariant 2 — `switch_workflow` validates path-existence, never an allowlist

The MCP tool checks that the target `workflowPath` resolves through
the layered intelligence merge, parses as a valid workflow YAML, and
(when `toPhase` is supplied) names a phase that exists in the target.
There is **no** hard-coded list of "blessed" workflows. A user
workflow may target its own files (e.g. `workflows/release-train/workflow.md`)
or another tenant overlay's files.

### Invariant 3 — Workflow paths are stable; merge is last-wins per path

Tenant and repo overlays follow the resolver's last-wins rule for
non-memory, non-CLAUDE.md files. A tenant that wants to override
FAST for one repo can ship a `.coro/workflows/job-fast/workflow.md`
and the resolver will pick it up at the next phase boundary. Phase
names, agent paths, and subagent names inside a workflow are part of
that contract — overlays can replace them, but should preserve the
shape downstream agents expect (or replace those agents too).

### Invariant 4 — `switch_workflow` is a normal MCP tool

It carries the `mcp__coro__` prefix, lives in `mcp-handlers.ts` next
to `convert_to_campaign`, and is callable from any agent in any
workflow. Subagents do not have it (they are scoped narrower by
`tools:`); top-level agents always do. There is no "phase-restricted"
gate — calling it from an unexpected phase just resets the workflow
at the next boundary.

### Invariant 5 — `Job.workflowPathHistory[]` is the audit surface

Every successful switch appends `{ at, from, to, fromPhase, toPhase, reason, by }`
to `Job.workflowPathHistory`. The dashboard surfaces this on the job
detail page so developers can trace why a job moved between
workflows. `by` records whether the switch came from
`switch_workflow` (agent-initiated) or `convert_to_campaign` (the
sugar wrapper). User workflows that introduce their own switching
mechanisms should write through `switch_workflow` so they get the
same audit trail for free.

### Invariant 6 — User workflows opt out of base behaviour by default

The Planner's lane router (in the base `agents/planner.md`) checks
two opt-out conditions before classifying:

1. The active workflow is **not** one of the three sized base job
   workflows. If the active workflow path is anything else, the
   router skips classification entirely and lets the user-supplied
   workflow run as authored.
2. `params.lane` is already set, `params.epicAllowed === false`, or a
   prior switch is recorded in `workflowPathHistory[]`.

The contract a user workflow must keep is small:

- The workflow YAML parses (frontmatter + phases array).
- Each phase's `agent:` path resolves through the layered merge.
- If the workflow expects to be entered via `switch_workflow`, its
  `initial_phase` is reachable.

Everything else — lane classification, register.json discipline,
4-lens reviewer, CI-green precondition — is opt-in. A user workflow
that does not invoke those skills simply does not get those checks,
and that is a deliberate property of the system, not a bug.

### What this means in practice

- A tenant can ship `workflows/security-audit/workflow.md` with a
  five-phase pipeline of its own design and the Planner's lane router
  will leave it alone (Invariant 6.1).
- A repo can override `workflows/job-fast/workflow.md` to add a
  required `compliance-check` phase, and every job classified FAST
  for that repo will pick it up at the next phase boundary
  (Invariants 3 + 4).
- A user workflow can call `switch_workflow` to escalate from its
  own `light` lane to its own `heavy` lane without touching any base
  intelligence (Invariants 2 + 4 + 5).

The base content can grow more opinionated over time — the contract
above bounds how much that opinionation can leak into user workflows.

---

## 8. DEEP-lane and campaign content invariants (v1.1 + v1.2)

The base intelligence layer adds two further opt-in surfaces in v1.1
(the DEEP analyzer + qa pipeline plus tiered testing skills) and v1.2
(the campaign-architecture and campaign-integration phases plus a
file-based cross-child contracts pattern). Both surfaces extend the
same "content, not infrastructure" stance from §7.

### Invariant 7 — DEEP analyzer / qa are content additions only

`workflows/job-deep/workflow.md` rewires its `analysis` and `qa`
phases to `agents/analyzer.md` and `agents/qa.md` respectively. No
new MCP tools, no new state-backend columns, no dispatcher branches.
Tenants and repos that override `job-deep` may use those agents,
ignore them, or replace them outright — the runner does not care.

### Invariant 8 — Tiered testing skills are an index, not a contract

`feature-testing/SKILL.md` is now an index that points at four tier
skills (`feature-testing-unit`, `feature-testing-integration`,
`feature-testing-contract`, `feature-testing-e2e`). The
`tiers_run` field in the testing JSON schema is advisory metadata —
nothing in the runner reads it. A user workflow can invoke any
subset of the tier skills, none of them, or its own testing skill.

### Invariant 9 — Cross-child contracts are file-based, not tool-based

The campaign cross-child contract pattern lives entirely on disk
under `working/{parent-job-id}/contracts/`:

| File | Owner | Schema |
|---|---|---|
| `_index.json` | Campaign Architect (seed) | `{ contracts: [{ id, kind, producer_hint, consumer_hints[], shape, compatibility, ownership }] }` |
| `{producer-child-name}.json` | The producer child's Coder (after merge) | `{ child_name, produces: [{ id, kind, shape, compatibility, test_ref, merged_pr_url, merged_commit_sha }] }` |

Producer / consumer ordering is encoded in the campaign DAG via
`dependsOn` on `campaign_register_child` — the dispatcher already
honours it, so the consumer's working directory always observes the
producer's contract file before the consumer's Coder runs. There is
no MCP tool for "claim" or "publish" a contract; the file's presence
is the publication. Drift is signalled via `add_insight({
category: "contract-drift" })`, surfaced by the Campaign Evaluator
and the Campaign Integrator.

The `campaign-contracts` skill carries the prose for both producer
and consumer flows. Tenants that want a different pattern can ship
their own skill and their own campaign-architect / coder overrides;
the runner does not police the file shape.

### Invariant 10 — Campaign architecture and integration are extra phases, not extra primitives

`workflows/campaign/workflow.md` now has five phases:
`campaign-architecture` → `campaign-planning` → `coordinating` →
`campaign-integration` → `aggregation`. The first and fourth are
new in v1.2 and run `agents/campaign-architect.md` and
`agents/campaign-integrator.md`. They use only existing MCP tools
(`post_artifact`, `add_insight`, `read_memory`, `log`,
`campaign_status`) — there is no `campaign_architect_*` namespace.
A user campaign workflow may keep, drop, or replace either phase by
authoring its own `workflows/<name>/workflow.md`.

### Invariant 11 — Halt-and-remediate stays human-mediated

The Campaign Evaluator may **suggest** in `campaign-report.md` that a
failed/escalated child be re-run, optionally with a different
`params.lane`. It does not call `campaign_rerun_child` /
`campaign_skip_child` / `campaign_cancel_child` itself — those are
human-triggered via the dashboard. When a human reruns a child with
`paramsPatch.lane = "deep"`, the child Planner's lane router (§7,
Invariant 6) detects the mismatch with the active workflow and calls
`switch_workflow` to land on the correct sized workflow.

