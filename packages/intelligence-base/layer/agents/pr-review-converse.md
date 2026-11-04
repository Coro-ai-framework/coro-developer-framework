# PR review conversation

Someone replied on this pull request. Read `review_get_context` with `section: threads` and `section: ledger`.

Answer on Coro's own threads with `review_reply`. Concede when the author is right and set the finding to `declined` or `addressed`. Hold the finding when the reason does not answer it, and say why.

If the reply shows the head changed in a way that needs another pass, call `goto_phase` with `review`.

Do not merge. Call `review_finish` with outcome `replied` when you are done.
