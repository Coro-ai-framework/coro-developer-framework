---
name: campaign-contracts
description: >-
  Cross-child contract authoring & verification pattern for campaigns.
  Used by the Campaign Architect (seed), the Campaign Planner (forward
  to children via params), the per-child Coder (record producer
  contract), the per-child Planner (consume), and the Campaign
  Integrator (verify cross-child).
---

# Campaign Contracts

When a campaign is decomposed into children, some children produce
public surface that other children consume — an event, an endpoint, a
schema, a shared type. Those producer / consumer relationships are
**contracts**. If they drift between when the producer ships and when
the consumer ships, you get a class of bug that is exceptionally hard
to root-cause: each PR looked fine in isolation; the integration is
broken at runtime.

This skill defines the **file-based contract pattern** used across the
campaign workflow. It is intentionally simple: plain JSON files alongside
other campaign markdown/json artefacts.

## File layout (parent campaign job)

Tenants choose directory and file names. A common layout:

```
contracts/
  _index.json                  ← seeded by Campaign Architect
  {producer-child-name}.json   ← written by the producer child's Coder
```

## Campaign child jobs — `params.campaignContextDir`

When the runner dispatches a campaign child, it copies the parent
campaign's markdown/json files into `{child-job-root}/{campaignContextDir}/`
(preserving relative paths) and rewrites path refs in `params` to point
there. Children **read and write campaign artefacts only under
`params.campaignContextDir`** — never under the parent job id path.
When the child finishes, the runner syncs that folder back to the
parent campaign working directory.

## `_index.json` shape (Campaign Architect writes this)

```json
{
  "contracts": [
    {
      "id": "order-created-event",
      "kind": "event",
      "owning_child_hint": "events-publisher",
      "consumer_child_hints": ["analytics-consumer", "audit-consumer"],
      "shape": { "...": "..." },
      "compatibility": "new"
    }
  ]
}
```

- `id`: short stable identifier. Children reference this id when
  recording or consuming.
- `kind`: `endpoint | event | schema | type | config | cli`.
- `owning_child_hint` / `consumer_child_hints[]`: names from the
  Architect's analysis. The Campaign Planner may rename children
  during decomposition; the producer's actual contract file uses the
  final child name.
- `shape`: the canonical shape (request / response / payload / type
  signature / DDL — whatever the kind requires). The Architect writes
  the design-time shape; the Coder writes the as-shipped shape.
- `compatibility`: `new | breaking | additive | internal`.

## Producer child contract file (one per producer child)

The Campaign Planner injects params into the producer child (paths
are rewritten under `params.campaignContextDir` at dispatch):

```
params.campaignDecisionsRef = "<path under campaignContextDir>"
params.campaignContracts = ["order-created-event"]   // ids the producer owns
```

The producer child's Coder, in step 1 of `agents/coder.md`:

1. Read the contracts index under `params.campaignContextDir` for each id in `params.campaignContracts`.
2. Treat the recorded shape as the canonical contract — the
   implementation must match it exactly.
3. Write the contract test (see `feature-testing-contract`).
4. After the implementation lands, write the producer contract JSON under
   `params.campaignContextDir` (see your tenant layout — typically
   `contracts/{params.campaignChildName}.json`):

```json
{
  "child_name": "events-publisher",
  "produces": [
    {
      "id": "order-created-event",
      "kind": "event",
      "shape": { "...": "..." },          // as-shipped, must match _index unless an ADR says otherwise
      "compatibility": "new",
      "test_ref": "tests/contract/order_created_event_test.go",
      "merged_pr_url": "https://...",
      "merged_commit_sha": "abc123"
    }
  ]
}
```

If the as-shipped shape **must** deviate from the Architect's design-
time shape (e.g. the Architect did not anticipate a required field),
the Coder also calls `add_insight({ category: "contract-drift", ... })`
so the Campaign Evaluator surfaces it. The Coder does **not** silently
diverge.

## Consumer child reads the producer contract

The Campaign Planner injects (paths rewritten under `campaignContextDir` at dispatch):

```
params.campaignDecisionsRef = "<path under campaignContextDir>"
params.campaignConsumesContracts = [
  { "id": "order-created-event", "producer": "events-publisher" }
]
```

The consumer child's Planner / Coder, when planning the work item:

1. Wait for the producer child to be terminal **before** the consumer
   child dispatches. This is encoded as `dependsOn: ["events-publisher"]`
   on the consumer child at registration time. The Campaign Planner
   sets this; the dispatcher honours it.
2. Read the producer's contract JSON under `params.campaignContextDir`.
3. Treat the as-shipped shape as canonical for the consumer side.
4. Write the consumer-side contract test (`feature-testing-contract`).

If the producer's contract file is missing when the consumer is
dispatched, the parent copy was not synced yet — escalate. If the producer's recorded shape differs from
the index and the consumer's plan was based on the index, treat
the producer as the source of truth and re-plan; flag the drift via
`add_insight`.

## Campaign Integrator verifies cross-child contracts

The Campaign Integrator, in step 5 of `agents/campaign-integrator.md`:

1. Read `_index.json` and every per-child contract file.
2. For each contract:
   - Confirm the producer's recorded shape matches the producer's
     contract test output (run the test if needed).
   - Confirm each consumer's contract test parses the producer's
     recorded shape.
   - Confirm the integration-level test (when one exists) passes
     against the merged producer + consumer code.
3. Report cross-child drift in the integration report's "Cross-child
   contracts" table. Drift is **blocking**.

## Tenants and overrides

Tenants commonly add stricter contract requirements (signed schemas,
generated stubs, registry pinning). Override this skill at the tenant
layer when the project has stronger conventions; the file-based pattern
above is the minimum viable contract surface.

## Why this is file-based, not a tool

File-based contracts under `params.campaignContextDir`:

- Need no new MCP tool.
- Survive runner restarts (parent canonical copy + per-child snapshot at dispatch).
- Are auditable in the parent campaign working dir alongside every other
  campaign artefact.
- Compose with the existing `register.json` per child (each child still
  records its `contracts[]` rows locally; the campaign-level contracts
  file is the cross-child view).
