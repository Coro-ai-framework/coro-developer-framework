# GitHub — Clone, Auth & MCP tools

The GitHub SCM plugin (`pluginId: github`) talks to `github.com`. After the
MCP-first pivot it is backed by the upstream
`@modelcontextprotocol/server-github` MCP server, attached to every job
session by the runner. You'll see its tools as `mcp__github__*`.

## Two ways to call GitHub
1. **Generic `scm_*` tools (preferred for the common path).** The runner
   resolves the active SCM plugin and forwards the call through the
   upstream MCP. Example: `scm_create_pr` → `mcp__github__create_pull_request`.
   The five generic ops (`scm_create_pr`, `scm_get_pr_status`,
   `scm_list_pr_comments`, `scm_post_pr_comment`, `scm_merge_pr`) keep
   workflow markdown provider-neutral.
2. **Native `mcp__github__*` tools (advanced path).** Anything beyond the
   five generic ops calls the upstream tool directly. Examples:
   - `mcp__github__create_repository`
   - `mcp__github__create_pull_request_review`
   - `mcp__github__add_pull_request_review_comment`
   - `mcp__github__list_branches`
   - `mcp__github__search_code`

The default tool allowlist is curated (~15 tools); operators can extend
it via `~/.coro/config.json` if a workflow needs a tool not on the list.

## Tokens
- Personal access tokens (classic or fine-grained) are sent as the password
  with `x-access-token` as the username when cloning.
- The `scm_get_clone_info` MCP tool returns a fully-credentialed HTTPS URL.
  Prefer that over hand-rolling URLs in agent prompts.

## Repo identity in `ExternalRef`
A GitHub pull request is identified globally by `<owner>/<repo>#<n>`. The
plugin's `ExternalRef` keeps `owner` in the plugin config (`owner`) and stores
`repo` in `repoKey`:

```json
{
  "kind": "pull_request",
  "pluginId": "github",
  "repoKey": "<repo>",
  "externalId": "<n>"
}
```

PR numbers are repo-scoped. Never operate on a PR number without `repoKey`.

## Reviews
GitHub PRs distinguish "review comments" from "issue comments" — `scm_*`
tools normalise both into `pr_comment` events; the underlying type is
preserved in the raw payload.
