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
- **Atlassian API tokens** (start with `ATATT…`): the git username **must** be
  `x-token-auth` and the token goes in the password slot.
- **Legacy app passwords**: use the workspace member's own username + the
  app password.

The `scm_get_clone_info` MCP tool returns a fully-credentialed HTTPS URL —
prefer that over hand-rolling URLs in agent prompts.

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
