# Linear — Issue identifiers and MCP tools

The Linear tracker plugin (`pluginId: linear`) talks to a single Linear
workspace. After the MCP-first pivot, agent-facing operations come from
Linear's official MCP server (`@linear/mcp-server`), attached to every
job session — you'll see its tools as `mcp__linear__*`.

## Two ways to call Linear
1. **Generic `tracker_*` tools (preferred).** The runner forwards through
   the upstream MCP:
   - `tracker_get_issue` → `mcp__linear__get_issue`
   - `tracker_get_comments` — reads the comment thread on an issue
     (served natively by the runner's Linear client). Comments are
     **not** included in `tracker_get_issue` — call this explicitly to
     read discussion left on an issue.
   - `tracker_comment_issue` → `mcp__linear__create_comment`
   - `tracker_transition_issue` → `mcp__linear__update_issue` (state field)
2. **Native `mcp__linear__*` tools (advanced path).** Examples:
   - `mcp__linear__list_issues`
   - `mcp__linear__create_issue`
   - `mcp__linear__list_projects`
   - `mcp__linear__list_teams`

## Identifier shape
Linear issue identifiers look like `<TEAM>-<n>` (e.g. `ENG-12`, `OPS-7`).
They are unique within the workspace, so the `ExternalRef` for a ticket is
just the identifier:

```json
{
  "kind": "ticket",
  "pluginId": "linear",
  "externalId": "ENG-12"
}
```

The `teamKey` from plugin config is the default team for new issues; the
agent can override per-call by passing `team` in the upstream MCP tool
arguments.

## Webhooks
v1 ships read-only — Linear webhook normalisation will arrive in a
follow-up. For now, `tracker_*` polling is the only way to react to
ticket transitions.
