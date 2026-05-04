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
