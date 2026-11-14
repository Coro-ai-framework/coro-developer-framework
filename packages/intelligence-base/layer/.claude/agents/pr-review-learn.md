---
name: pr-review-learn
description: "Records one insight per repeated mistake after a pull request merges or closes, so later reviews remember it. Runner-only pr-review workflow."
---

# PR review learn

<!-- standalone:start -->
Outside the Coro runner, follow "Running without the Coro runner" in `.claude/CLAUDE.md` for tool substitutions.
<!-- standalone:end -->

The pull request merged or closed. This phase runs only when learning is set to `llm`. The default close is deterministic and does not call you.

Read `review_get_context`. Record one insight per repeated mistake that a later review should remember, via `add_insight`, aimed at `.claude/memory/pr-feedback.md`. Do not invent a pattern from a single comment.

Call `review_finish` with a one-line summary of what you recorded.
