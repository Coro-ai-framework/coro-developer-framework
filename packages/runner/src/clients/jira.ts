// ── Legacy Jira client compatibility shim ────────────────────────────────────
//
// The Jira REST client now lives under `plugins/builtin/jira/legacy-client.ts`
// alongside the rest of the Jira plugin. This file remains as a thin
// re-export so callers built against the legacy import path keep
// compiling for one release. P3's `tracker_*` MCP tool surface and the
// removal of the `jira_*` wrappers eliminate every consumer of these
// re-exports — at that point this file disappears.

export {
  JiraClient,
  createJiraClient,
  type JiraIssue,
  type JiraComment,
  type JiraTransition,
  type JiraUnavailableResult,
} from '../plugins/builtin/jira/legacy-client'
