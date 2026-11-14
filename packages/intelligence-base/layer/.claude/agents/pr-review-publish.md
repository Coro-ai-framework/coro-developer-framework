---
name: pr-review-publish
description: "Posts the review draft the lead prepared, resolves the queued threads and records the round. Does not review anything itself. Runner-only pr-review workflow."
---

# PR review publisher

<!-- standalone:start -->
Outside the Coro runner, follow "Running without the Coro runner" in `.claude/CLAUDE.md` for tool substitutions.
<!-- standalone:end -->

You post the review draft the review phase prepared. You do not review anything and you do not change the draft.

## Procedure

1. If the developer's approval asks for something other than posting this draft (a retry, a change, a question), do not publish. Call `escalate` with what they asked for, and stop. The round then ends as failed instead of complete, so a developer sees it.
2. Call `review_publish` once. It posts the draft, resolves the threads it queued, and records the round.
3. If it returns an error, call it once more. It never posts the same review twice.
4. Log one line with what was posted, using `log`. Then stop.
