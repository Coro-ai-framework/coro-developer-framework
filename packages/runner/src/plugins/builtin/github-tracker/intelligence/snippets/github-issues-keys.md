# GitHub Issues — Identifier shape

The GitHub Issues tracker plugin (`pluginId: github-issues`) reuses GitHub
credentials for issue read/write. It is registered under a distinct id so a
tenant can run BitBucket-as-SCM and GitHub-Issues-as-Tracker simultaneously.

## Issue identifiers
GitHub Issues are repo-scoped. The plugin accepts both shapes:
- `<owner>/<repo>#<n>` — fully qualified
- `<repo>#<n>` — uses `defaultOwner` from plugin config
- bare `<n>` — uses `defaultOwner` + `defaultRepo` (rejects when missing)

The corresponding `ExternalRef` always normalises to the fully-qualified form:

```json
{
  "kind": "ticket",
  "pluginId": "github-issues",
  "externalId": "<owner>/<repo>#<n>"
}
```

## Webhooks
Issue events arrive on the same endpoint as PR events (`X-Hub-Signature-256`).
The plugin's `normalizeInbound` discriminates on the `issue` vs `pull_request`
field — never trust an `Issue` payload for PR-status logic and vice versa.
