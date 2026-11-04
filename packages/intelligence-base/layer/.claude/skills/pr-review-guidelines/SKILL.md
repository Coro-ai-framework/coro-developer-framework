---
name: pr-review-guidelines
description: Severity rubric, comment voice, and verdict rules for Coro pull-request review.
---

# PR review guidelines

## Severity

- **blocker** — incorrect behavior, a security hole, or a contract break with known consumers. The pull request should not merge as-is.
- **major** — a real defect or a design problem a maintainer would ask to change, including a contract break with no known consumers.
- **minor** — worth fixing, not worth blocking.
- **nit** — voice or formatting. Do not emit these when the floor is higher.

## Comment

State the problem, why it matters, and a concrete fix. A suggestion block is optional. Do not restate the diff. Do not praise.

Do not re-raise a finding the ledger marks `declined`.

## Verdict

- Request changes only when a blocker is still open.
- Approve only after a full pass on the current head with no open blocker or major.
- Otherwise comment.
- Never merge, and never say the pull request was merged by Coro.
