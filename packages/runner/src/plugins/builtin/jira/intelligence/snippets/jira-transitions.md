# Jira — Tickets, Transitions, and MCP tools

The Jira tracker plugin (`pluginId: jira`) talks to a single Atlassian Cloud
or Server site (configured at install time). After the MCP-first pivot,
agent-facing operations come from an upstream Atlassian/Jira MCP server
attached to every job session — you'll see its tools as `mcp__jira__*`.

## Two ways to call Jira
1. **Generic `tracker_*` tools (preferred).** Provider-neutral. The runner
   forwards the call to the upstream MCP. Use these when you can:
   - `tracker_get_issue` → `mcp__jira__jira_get_issue`
   - `tracker_comment_issue` → `mcp__jira__jira_add_comment`
   - `tracker_transition_issue` → `mcp__jira__jira_transition_issue`
2. **Native `mcp__jira__*` tools (advanced path).** Anything beyond the
   three generic ops calls the upstream tool directly. Examples:
   - `mcp__jira__jira_create_issue`
   - `mcp__jira__jira_create_epic`
   - `mcp__jira__jira_link_issues`
   - `mcp__jira__jira_search_issues`

The default tool allowlist is curated; operators can extend it via the
plugin's installed config in `~/.coro/config.json`.

## Issue keys
Jira keys are project-prefixed (`ENG-123`, `OPS-42`) and globally unique
within the site, so an `ExternalRef` for a ticket only needs the key:

```json
{
  "kind": "ticket",
  "pluginId": "jira",
  "externalId": "ENG-123"
}
```

`repoKey` is unused for tickets and is stored as the empty string.

## Transitions
Jira transition names are **case-sensitive** and project-specific. Use
`tracker_transition_issue` and pass the exact transition name you
fetched from `tracker_get_issue` (or the project's workflow); guessing
names like `"Done"` vs `"Done!"` is the most common cause of write
failures.
