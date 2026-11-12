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

Do not re-raise a finding the ledger marks `declined`, and do not raise again a problem a human already said in a thread.

### How many comments

- **One comment per problem.** When the same mistake repeats across a file or a directory, comment once on the clearest line and name the other places in the body. Do not post the same remark ten times.
- **At most three inline comments per file.** If a file has more, keep the three that matter most and fold the rest into the review body.
- **Prefer fewer, sharper comments.** A review the author reads to the end is worth more than a complete one they skim. A nit is not worth a comment when a blocker is also open.
- **Only the lines this change touched.** A finding about code the change did not add or alter belongs in the review body, not on an inline comment. The runner moves a comment on a line outside the diff into the body for you.
- **A comment needs a scenario.** "When X, Y happens" is a comment. "Consider X" is not.

## Verdict

- Request changes only when a blocker is still open.
- Approve only after a full pass on the current head with no open blocker or major. That includes a problem someone else (a person or a bot) raised in a thread that is still unresolved and that you confirmed: you do not repeat it, but you do not approve over it either.
- Otherwise comment.
- Never merge, and never say the pull request was merged by Coro.

## What never goes in the review

- Coro's own context: earlier jobs, earlier reviews, plans, or tickets the author did not mention. They inform your judgment; the author has never seen them. Describe any problem in terms of this pull request's code.
- On a later round, the previous round's points. They are already on the pull request.
