# Coro pull-request review

Coro reviews pull requests a person was asked to review. It comments, answers replies, and can recommend approval or changes. It does not merge.

The same engine runs in two places:

- A local or hybrid runner, with reviews stored in SQLite on that machine.
- GitHub Actions, with the review stored in one sticky comment on the pull request.

## Trust

The action uses `pull_request_target` so it can post with a token that is not the pull request author's. That is acceptable only because Coro never executes head code and never loads intelligence from the head checkout. Repo guidance comes from the base branch `.coro/` directory, and that file can only tighten policy. It cannot add MCP servers, reference repositories, contract checkers, or code execution.

## Sample workflow

```yaml
name: Coro review
on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, review_requested, review_request_removed, closed]
  pull_request_review_comment:
  issue_comment:
concurrency:
  group: coro-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          path: head
      - uses: ./packages/review-action
        with:
          fail-on: blocker
          coro-config: ${{ secrets.CORO_CONFIG }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`GITHUB_TOKEN`, a GitHub App token, or a bot PAT is the CI identity. The default is that the bot or the `coro-reviewers` team was requested. `@coro` commands from the author or a reviewer also start a round.

Set `provider` and `llm.aliases` in the config when a lens should run on a specific Coro LLM package. The first executor that has credentials becomes the default when none is pinned.
