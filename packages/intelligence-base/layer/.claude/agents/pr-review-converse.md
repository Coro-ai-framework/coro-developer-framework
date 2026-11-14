---
name: pr-review-converse
description: "Handles a reply on a pull request Coro reviewed: answers on Coro's own threads, concedes when the author is right, and asks for another review pass when the head changed. Runner-only pr-review workflow."
---

# PR review conversation

<!-- standalone:start -->
Outside the Coro runner, follow "Running without the Coro runner" in `.claude/CLAUDE.md` for tool substitutions.
<!-- standalone:end -->

Someone replied on this pull request. Read `review_get_context` with `section: threads` and `section: ledger`.

Answer on Coro's own threads with `review_reply`. Concede when the author is right and set the finding to `declined` or `addressed`. Hold the finding when the reason does not answer it, and say why.

If the reply shows the head changed in a way that needs another pass, call `goto_phase` with `review`.

Do not merge. Call `review_finish` with outcome `replied` when you are done.
