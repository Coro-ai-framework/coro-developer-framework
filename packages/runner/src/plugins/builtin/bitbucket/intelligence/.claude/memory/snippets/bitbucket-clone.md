# BitBucket — Clone, Auth, and Tooling

The BitBucket SCM plugin (`pluginId: bitbucket`) talks to `bitbucket.org`.

## Toolset (note — different from the other built-ins)
After the MCP-first pivot, GitHub / Jira / Linear / GH Issues attached
upstream MCP servers and exposed their tools as `mcp__<plugin>__*`.
**BitBucket is the exception.** No production-quality upstream MCP
server covers it yet, so the plugin stays native — agents call generic
`scm_*` tools and the runner forwards to the plugin's own methods.

There is **no** `mcp__bitbucket__*` tool surface. Always go through the
generic `scm_*` tools when the active SCM is BitBucket.

## Tokens
- **Atlassian API tokens** (start with `ATATT…`): for git over HTTPS the
  username **must** be `x-bitbucket-api-token-auth` (the REST API also
  accepts the user's email, but git does not — this asymmetry is an
  Atlassian quirk, not a coro choice). The runner auto-rewrites the
  username to `x-bitbucket-api-token-auth` for clone URLs when the
  configured username is an email and the token is `ATATT…`.
- **Legacy repository access tokens**: username `x-token-auth`, token in the
  password slot.
- **Legacy app passwords**: workspace member's own username + the app
  password.

`scm_get_clone_info` returns a clean HTTPS URL. Git authenticates through
the job credential helper using the username/password above — do not
paste tokens into remotes.

## Repo identity in `ExternalRef`
A BitBucket pull request lives at `bitbucket.org/<workspace>/<slug>/pull-requests/<n>`,
so the corresponding {@link ExternalRef} is:

```json
{
  "kind": "pull_request",
  "pluginId": "bitbucket",
  "repoKey": "<slug>",
  "externalId": "<n>"
}
```

`repoKey` is the slug only (the workspace is implied by the plugin's tenant
config). PR ids are not globally unique across workspaces — never operate on a
PR id without a `repoKey`.
