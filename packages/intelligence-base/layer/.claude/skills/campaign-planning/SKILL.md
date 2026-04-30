---
name: campaign-planning
description: >-
  Heuristics for breaking a large feature into a coordinated campaign of
  child issues. Covers child sizing, dependency declaration, naming,
  branch-per-child strategy, and tracker hygiene. Use when running the
  campaign-planning phase or whenever the regular Planner is on the verge
  of calling convert_to_campaign.
---

# Campaign Planning Guide

The companion skill to the campaign-planner agent. The agent file describes the *procedure*; this skill describes the *judgement* — how to decide what counts as a child, how to declare dependencies, and what good campaigns look like.

## When a campaign is the right shape

The triage step in `agents/planner.md` already gates the campaign promotion. By the time you read this skill the decision has been made; your only remaining choice is **how** to break the work down. If, while drafting the breakdown, you realize the work actually does fit in a single job after all, abort the campaign:

- Don't call `campaign_finalize`.
- Call `escalate` with the reason ("triage was wrong; this is a single task"). A human will close the campaign and rerun as a regular job.

## Child sizing

A child must be:

1. **A single PR's worth of work.** If a child reasonably needs more than one PR, split it.
2. **Independently mergeable.** A child must not require another child's PR to be open for its tests to pass.
3. **Reviewable by one engineer in one sitting.** Roughly 200–500 lines of diff, including tests. Hard ceiling: 1000.
4. **Owned by one Coder pass.** The Coder agent runs once per child; if the work needs multiple coding sessions, the workflow's loop will cover one or two iterations but not five.

If two children would touch identical files and one of them is small (≤ 50 lines), fold the small one into the larger child. Friction over the merge order is rarely worth keeping them separate.

## Dependency declaration

Dependencies (`dependsOn`) should be **real**, not aspirational:

- Declare a dependency only when the dependent child cannot compile, test, or pass review without the upstream child's code being merged.
- Soft ordering ("we'd like to ship A first") is **not** a dependency. The dispatcher dispatches dependencies sequentially; padding the graph with soft edges costs throughput.
- A child should depend on the smallest possible upstream set. If `C` only really needs `B`, do not also list `A` even if `B` depends on `A` — transitivity is implicit.

The dispatcher detects cycles at `campaign_finalize` time and rejects the breakdown with the offending path. Treat that error as a hint that you have overspecified dependencies; the fix is usually to drop one of the edges, not invent a new node.

## Naming

`campaign_register_child({ name })` and tracker issue keys are different namespaces:

- **Child name** — slug-like, ≤ 64 chars, `[a-zA-Z0-9._-]`. Used as the dependsOn key and the suggested branch suffix. Examples: `db-schema`, `api-routes`, `migration-runner`.
- **Tracker key** — provider-native (e.g. Jira's `PROJ-123`). Recorded in `trackerRef` so the dashboard and campaign-evaluator can correlate.

Pick child names that read well in `dependsOn: ["api-routes"]`. Avoid free-form descriptions in the name — those go in the `description` field.

## Branch-per-child strategy

Each child runs as its own job and produces its own PR off `main`. Recommend a branch name in `params.branchName` that incorporates:

- The campaign title (slugged) — keeps multiple campaigns' branches distinguishable.
- The child name — keeps siblings distinguishable.

Example: campaign `payments-v2` → child `db-schema` → branch `coro/payments-v2/db-schema`. The child's Coder agent honours `params.branchName` if set.

## Tracker hygiene

When the tracker is configured:

- Always create an epic first; every child issue is `parentKey`-linked to it. Otherwise the epic's child list is empty in the tracker UI.
- Reflect every `dependsOn` in the tracker via `tracker_link_issues` with `relation: "Blocks"`. The link reads "fromKey is blocked by toKey", which matches the dispatcher's dependsOn semantics.
- Use a consistent label (`coro-campaign`, `coro-campaign-child`) so a JQL query can find every Coro-managed campaign at a glance.

When the tracker reports `available: false`, **do not call any other tracker tools** in that turn. Continue without a tracker; the campaign still works, you just lose tracker correlation. Note the absence in the campaign plan markdown so the human reader isn't surprised.

## Failure handling expectations

The dispatcher uses a `halt-on-failure` policy: a single child reaching `failed` or `escalated` parks the campaign for human review. Plan accordingly:

- **Make children resilient on their own.** Don't rely on the campaign harness to retry — if a child needs retry semantics, build them into the child's spec (e.g. flaky integration tests should be retried inside the test phase).
- **Order risky children early.** A halt on a child early in the dependency graph is cheaper to recover from than a halt on a leaf node that already had every other child shipping behind it.
- **Don't overcouple.** If two children have a hard dependency on each other passing, prefer to fold them.

## Output format

The campaign plan markdown (saved as `campaign-report-md` artifact) should include:

```
# Campaign: <title>

## Goal
<one-paragraph user-facing description>

## Breakdown rationale
<why these children, why these dependencies>

## Children
### <child-name>
- **Description:** …
- **Depends on:** …
- **Tracker:** <key + url, or "no tracker">
- **Branch suggestion:** …
- **Risk:** low / medium / high
- **Acceptance criteria:** …

(repeat for each child)

## Dependency graph
<ASCII or mermaid graph>
```

The campaign-evaluator reads this artifact at aggregation time, so keep it accurate — if you discover an issue after `campaign_finalize` and add a child later, also update the markdown so the report has full provenance.
