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

The mode is decided by **how much the inputs already settle**, not by what
triggered the job. The Spec Writer picks it in step 2 of its procedure by
testing whether the ticket, `params.description`, and
`{planContextDir}/findings.md` — taken together — settle the target repo, a
concrete change, criteria-shaped conditions, and every open question that
changes what gets built.

1. **`derive`** — they do not. A bare `coro job` one-liner, a thin ticket, or
   a plan-mode investigation that stalled before reaching a conclusion. This
   is a short PRD-writing pass: the spec has to *construct* the scope.
2. **`verify`** — they do. A plan-mode investigation that reached `ready`, or
   a brief detailed enough to stand on its own. Scope is established, so the
   spec must not re-derive or restate it. The work moves to the repository:
   what will reject this change, and what proves each criterion.

The quality bar is the same in both. What differs is where the budget goes —
and in `verify` mode, restating the brief is a **failure**, not thoroughness.
A `verify` spec is usually shorter than the brief it builds on.

## Mandatory sections

Every spec must have, at minimum:

| Section | Bar | Mode |
|---|---|---|
| Title | One sentence, action-verb led. | both |
| Scope source | Which inputs settled scope, and whether it was established or derived here. | both |
| Description | `derive`: a reader who has never seen the ticket understands what is changing and why in 30 seconds. `verify`: two to four sentences plus a pointer to the brief — **not** a copy of it. | both |
| Repo contract | The gates, conventions, and out-of-repo prerequisites found by reading the clone. Each item cites the file or precedent it came from; machine-checked ones give the command. "Nothing found in the tree" is a valid entry; an invented rule is not. | both |
| Acceptance criteria | Numbered, **independently testable**, no compound criteria (`and` is a smell). Each ends in the check that proves it. | both |
| Test plan | At least one concrete check per acceptance criterion — a command, a grep, a test name, an exit code. | both |
| Affected areas | Concrete module / service / file paths where possible. | both |
| Corrections to the brief | Where the repo contradicts the inputs, or answers a question the investigation left open. One line saying you found no divergence is fine; omitting the heading is not. | `verify` |
| Risk & rollout notes | One sentence each. "Low risk, deploy directly" is fine when true. | both |
| Notes / open questions | Use this **liberally**. Empty Notes on a non-trivial spec is suspicious. | both |

Tracker-triggered jobs add: tracker reference, suggested reviewers (from
assignee / reporter / component owners), linked tickets.

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
- [ ] Repo contract exists, and every line of it came from a file you read in
      the clone — no rule asserted from habit or from another repo.
- [ ] Every gate that can fail the change is named with its command, or its
      absence is stated explicitly.
- [ ] **`verify` mode:** the spec cites `plan/findings.md` /
      `params.description` rather than reproducing their content. No schema
      dump, endpoint list, or file quote copied across.
- [ ] **`verify` mode:** the spec is shorter than the brief it builds on. If
      not, find the restatement and cut it.
- [ ] **`verify` mode:** "reproduce the brief faithfully" is one criterion,
      not one criterion per fact in the brief.
- [ ] **`verify` mode:** Corrections to the brief is present, even if it says
      only that nothing diverged.
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
