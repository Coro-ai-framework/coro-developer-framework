# GitHub — Clone & Auth

The GitHub SCM plugin (`pluginId: github`) talks to `github.com`.

## Tokens
- Personal access tokens (classic or fine-grained) are sent as the password
  with `x-access-token` as the username.
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
