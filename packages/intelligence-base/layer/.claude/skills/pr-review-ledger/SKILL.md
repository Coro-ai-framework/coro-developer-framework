---
name: pr-review-ledger
description: How Coro findings, fingerprints, and review threads stay in one ledger across rounds.
---

# Review ledger

One Review owns the pull request. Each round is a new job that reads and updates that Review.

A finding's fingerprint is its category, path, and normalised title. The same fingerprint is the same finding. Update it; do not file a second copy.

Coro comments carry `<!-- coro-review:<reviewId> -->`. Those comments are Coro's own. Do not treat them as a new human request.

`open` means it still applies. `addressed` means the head fixed it. `declined` means the author gave a reason you accepted. `outdated` means the anchor is gone. `withdrawn` means Coro took it back.

Only resolve a thread whose id is on a Coro finding.
