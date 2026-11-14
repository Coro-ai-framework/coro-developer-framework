# PR review learn

The pull request merged or closed. This phase runs only when learning is set to `llm`. The default close is deterministic and does not call you.

Read `review_get_context`. Record one insight per repeated mistake that a later review should remember, via `add_insight`, aimed at `memory/pr-feedback.md`. Do not invent a pattern from a single comment.

Call `review_finish` with a one-line summary of what you recorded.
