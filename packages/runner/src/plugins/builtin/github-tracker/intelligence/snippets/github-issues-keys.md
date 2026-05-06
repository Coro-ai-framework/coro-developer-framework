# GitHub Issues — Identifiers and MCP tools

The GitHub Issues tracker plugin (`pluginId: github-issues`) reuses GitHub
credentials for issue read/write. It is registered under a distinct id so a
tenant can run BitBucket-as-SCM and GitHub-Issues-as-Tracker simultaneously.

After the MCP-first pivot, the plugin attaches its own dedicated instance
of `@modelcontextprotocol/server-github` (separate from the `github` SCM
plugin's instance) — you'll see its tools as `mcp__github-issues__*`. The
two instances exist so each side curates its own tool allowlist (issues
on the tracker side, PRs on the SCM side).

## Two ways to call GitHub Issues
1. **Generic `tracker_*` tools (preferred).** Forwarded through the upstream
   MCP:
   - `tracker_get_issue` → `mcp__github-issues__get_issue`
   - `tracker_comment_issue` → `mcp__github-issues__add_issue_comment`
2. **Native `mcp__github-issues__*` tools (advanced path).** Examples:
   - `mcp__github-issues__create_issue`
   - `mcp__github-issues__list_issues`
   - `mcp__github-issues__update_issue`
   - `mcp__github-issues__search_issues`

## Issue identifiers
GitHub Issues are repo-scoped. The plugin accepts both shapes:
- `<owner>/<repo>#<n>` — fully qualified
- `<repo>#<n>` — uses `defaultOwner` from plugin config
- bare `<n>` — uses `defaultOwner` + `defaultRepo` (rejects when missing)

The corresponding `ExternalRef` always normalises to the fully-qualified
form:

```json
{
  "kind": "ticket",
  "pluginId": "github-issues",
  "externalId": "<owner>/<repo>#<n>"
}
```

## Webhooks
Issue events arrive on the same endpoint as PR events (`X-Hub-Signature-256`).
The plugin's `normalizeInbound` skips PR-side `issue_comment` payloads — the
SCM plugin claims those — and surfaces only true issue events.
