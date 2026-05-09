---
name: spec-quality
description: >-
  Quality bar for feature specs produced by the Spec Writer agent. Defines the
  minimum content per section, the ambiguity-flagging discipline, and the
  self-checklist the spec-writer runs before handing off to the Planner. Read
  before writing the spec; re-read after writing it to self-audit.
---

# Spec Quality

A spec is the contract between human intent and the agent pipeline. Every
downstream phase — planning, coding, reviewing, evaluating — assumes the spec
is the source of truth. A vague spec doesn't just slow planning; it produces
wrong code that passes review and fails QA, costing far more than the time it
would have taken to push back on the ticket.

This skill defines the quality bar.

## Two modes

The Spec Writer runs in two modes today:

1. **Tracker-triggered**: a Jira / Linear / GitHub Issues ticket fired the job.
   Read the ticket via `tracker_get_issue` and translate it into the spec.
2. **CLI-triggered (STANDARD or DEEP lane)**: a developer ran `coro job` with
   a free-form description. There is no ticket; the spec is built from the
   description, the repo, and the lane router's reasoning.

The quality bar is the same in both modes. The work to **reach** that bar
differs: tracker mode is a translation pass; CLI mode is closer to a short
PRD-writing pass.

## Mandatory sections

Every spec must have, at minimum:

| Section | Bar |
|---|---|
| Title | One sentence, action-verb led. |
| Description | A reader who has never seen the ticket understands what is changing and why in 30 seconds. |
| Acceptance criteria | Numbered, **independently testable**, no compound criteria (`and` is a smell). |
| Test plan | At least one test idea per acceptance criterion. |
| Affected areas | Concrete module / service / file paths where possible. |
| Risk & rollout notes | One sentence each. "Low risk, deploy directly" is fine when true. |
| Notes / open questions | Use this **liberally**. Empty Notes on a non-trivial spec is suspicious. |

Tracker mode adds: Tracker reference, suggested reviewers (from assignee /
reporter / component owners), linked tickets.

## Acceptance-criteria rules

The most failure-prone section. The rules:

1. Each criterion is a complete sentence in the form
   "When X, the system Y." or "Given X, doing Y produces Z."
2. Each criterion is testable with a single observation. If you cannot
   describe the test in one sentence, split the criterion.
3. Vague verbs are banned: `support`, `handle`, `improve`, `optimise` —
   replace with the observable behaviour they imply.
4. Quantified targets must be present where the request implies them.
   `<200ms p95 latency on /v1/x`, not `fast enough`.
5. Negative criteria (what the change must **not** do) belong here too —
   regressions, security boundaries, scope cuts.

## Ambiguity discipline

When the source material is unclear, you have two options:

- **Flag in Notes** with a specific question: "Ticket says 'soft delete' —
  does that mean a `deleted_at` column on the existing table, or moving
  rows to a `<table>_archive`? The two have very different migration
  costs." This is the default.
- **Decide and record**: only when the decision is genuinely
  uncontroversial AND the cost of waiting outweighs the cost of being
  wrong. Record both the decision and the discarded alternatives in Notes
  so reviewers can challenge it.

**Never silently assume.** A spec with an unstated assumption is worse than
a spec that says "I don't know."

## Self-audit checklist (run before handing off)

Tick every box. Any unticked box → fix the spec, do not hand off.

- [ ] Every acceptance criterion is one sentence and one observation.
- [ ] No vague verbs (`support`, `handle`, `improve`).
- [ ] Each criterion has at least one test idea in the Test plan.
- [ ] Affected areas names actual paths, not abstract concepts.
- [ ] If the work touches a public surface (API, schema, message format,
      CLI flag, config key), the new shape is explicit in the description
      or in a contract sub-section.
- [ ] If the work touches a security-sensitive surface, the security
      requirements are explicit (authn / authz / PII / audit).
- [ ] If the work has any quantitative target, that target is in the
      criteria, not just the description.
- [ ] Notes contains every open question; nothing was silently decided.
- [ ] Suggested reviewers exist (tracker mode) or the spec invites the
      Planner to suggest them (CLI mode).

## When the source is unsalvageable

If the ticket / description is so vague that even with aggressive
ambiguity-flagging the spec would mislead the Planner, **do not write a
speculative spec**. Call `mcp__coro__escalate` with a concise list of the
specific gaps. The cost of pausing for human input is bounded; the cost of
shipping the wrong feature is not.
