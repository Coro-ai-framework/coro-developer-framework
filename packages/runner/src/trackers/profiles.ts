// ── Tracker MCP profiles ─────────────────────────────────────────────────────
//
// A tracker does not have to be a Coro plugin. Any MCP server that exposes
// issue reads and writes can serve, provided Coro knows which of its tools
// does what. A profile is that mapping for one well-known server family,
// plus how to recognise it among the servers a session sees.
//
// Tool names here are bare; the binding prefixes them with the server's
// own `mcp__<name>__`. Names were taken from the servers themselves
// (`mcpServerStatus()` for the Atlassian connector) — a profile is only as
// good as that, so prefer adding a profile to guessing in agent markdown.

import type { ExecutorMcpServerInfo } from '@coro-ai/plugin-sdk'

export const TRACKER_OPS = [
  'getIssue',
  'searchIssues',
  'getComments',
  'comment',
  'getTransitions',
  'transition',
  'createIssue',
  'updateIssue',
  'linkIssues',
  'lookupUser',
  'listProjects',
  'issueTypes',
  'resources',
] as const
export type TrackerOp = typeof TRACKER_OPS[number]

const READ_OPS: ReadonlySet<TrackerOp> = new Set([
  'getIssue',
  'searchIssues',
  'getComments',
  'getTransitions',
  'lookupUser',
  'listProjects',
  'issueTypes',
  'resources',
])

export function isReadOp(op: TrackerOp): boolean {
  return READ_OPS.has(op)
}

export interface TrackerMcpProfile {
  id: string
  provider: 'jira' | 'linear' | 'github-issues'
  displayName: string
  /**
   * Whether `tracker: "auto"` may pick this server. False for servers that
   * are usually attached for another reason (a GitHub MCP is mostly there
   * for code), so they only become the tracker when named explicitly.
   */
  autoSelect: boolean
  tools: Partial<Record<TrackerOp, string>>
  /**
   * Argument shape for the ops the generic `tracker_*` tools redirect to.
   * Values the runner cannot know (Atlassian's cloudId, a transition id)
   * are left as `<placeholders>` the agent fills in.
   */
  args?: Partial<Record<RedirectOp, (a: RedirectArgs) => Record<string, unknown>>>
  /** Provider quirks the agent needs before its first call. */
  notes: string[]
  matches(server: ExecutorMcpServerInfo): boolean
}

export type RedirectOp = 'getIssue' | 'getComments' | 'comment' | 'transition'
export interface RedirectArgs {
  key: string
  body?: string
  status?: string
}

function githubIssueParts(key: string): { owner: string; repo: string; issue_number: number | string } {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(key)
  if (!m) return { owner: '<owner>', repo: '<repo>', issue_number: key }
  return { owner: m[1]!, repo: m[2]!, issue_number: Number(m[3]) }
}

function host(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

function hasTools(server: ExecutorMcpServerInfo, names: string[]): boolean {
  const have = new Set(server.tools.map(t => t.name))
  return names.every(n => have.has(n))
}

export const ATLASSIAN_ROVO_PROFILE: TrackerMcpProfile = {
  id: 'atlassian-rovo',
  provider: 'jira',
  displayName: 'Atlassian (Jira)',
  autoSelect: true,
  tools: {
    getIssue: 'getJiraIssue',
    searchIssues: 'searchJiraIssuesUsingJql',
    getComments: 'getJiraIssue',
    comment: 'addCommentToJiraIssue',
    getTransitions: 'getTransitionsForJiraIssue',
    transition: 'transitionJiraIssue',
    createIssue: 'createJiraIssue',
    updateIssue: 'editJiraIssue',
    linkIssues: 'createIssueLink',
    lookupUser: 'lookupJiraAccountId',
    listProjects: 'getVisibleJiraProjects',
    issueTypes: 'getJiraProjectIssueTypesMetadata',
    resources: 'getAccessibleAtlassianResources',
  },
  args: {
    getIssue: a => ({ cloudId: '<cloudId>', issueIdOrKey: a.key }),
    getComments: a => ({ cloudId: '<cloudId>', issueIdOrKey: a.key, fields: ['comment'] }),
    comment: a => ({ cloudId: '<cloudId>', issueIdOrKey: a.key, commentBody: a.body, contentFormat: 'markdown' }),
    transition: a => ({ cloudId: '<cloudId>', issueIdOrKey: a.key, transition: { id: `<id of the transition to "${a.status}">` } }),
  },
  notes: [
    'Every Jira call needs `cloudId`. Get it once from the resources tool (match the site in the ticket URL) and reuse it.',
    'Comments come back on the issue read; there is no separate comments tool.',
    'Transitions are by id: read the available transitions for the issue first and pick one whose target status matches.',
    'Pass `contentFormat: "markdown"` when writing comments or descriptions.',
    'A Sub-task cannot have children. Check the parent\'s issue type before creating sub-tickets under it.',
  ],
  matches: server =>
    host(server.url) === 'mcp.atlassian.com' ||
    hasTools(server, ['getJiraIssue', 'searchJiraIssuesUsingJql']),
}

export const MCP_ATLASSIAN_PROFILE: TrackerMcpProfile = {
  id: 'mcp-atlassian',
  provider: 'jira',
  displayName: 'Jira (mcp-atlassian)',
  autoSelect: true,
  tools: {
    getIssue: 'jira_get_issue',
    searchIssues: 'jira_search',
    getComments: 'jira_get_issue',
    comment: 'jira_add_comment',
    getTransitions: 'jira_get_transitions',
    transition: 'jira_transition_issue',
    createIssue: 'jira_create_issue',
    updateIssue: 'jira_update_issue',
    linkIssues: 'jira_create_issue_link',
    lookupUser: 'jira_get_user_profile',
    listProjects: 'jira_get_all_projects',
  },
  args: {
    getIssue: a => ({ issue_key: a.key }),
    getComments: a => ({ issue_key: a.key, comment_limit: 50 }),
    comment: a => ({ issue_key: a.key, comment: a.body }),
    transition: a => ({ issue_key: a.key, transition_id: `<id of the transition to "${a.status}">` }),
  },
  notes: [
    'Transitions are by id: read the available transitions for the issue first.',
    'A Sub-task cannot have children. Check the parent\'s issue type before creating sub-tickets under it.',
  ],
  matches: server => hasTools(server, ['jira_get_issue', 'jira_transition_issue']),
}

export const LINEAR_PROFILE: TrackerMcpProfile = {
  id: 'linear',
  provider: 'linear',
  displayName: 'Linear',
  autoSelect: true,
  tools: {
    getIssue: 'get_issue',
    searchIssues: 'list_issues',
    getComments: 'list_comments',
    comment: 'create_comment',
    getTransitions: 'list_issue_statuses',
    transition: 'update_issue',
    createIssue: 'create_issue',
    updateIssue: 'update_issue',
    lookupUser: 'list_users',
    listProjects: 'list_teams',
  },
  args: {
    getIssue: a => ({ id: a.key }),
    getComments: a => ({ issueId: a.key }),
    comment: a => ({ issueId: a.key, body: a.body }),
    transition: a => ({ id: a.key, state: a.status }),
  },
  notes: [
    'Status changes go through the update tool with a `state`; list the team\'s statuses first.',
    'Sub-issues are created with `parentId` set to the parent issue id.',
  ],
  matches: server =>
    host(server.url) === 'mcp.linear.app' ||
    hasTools(server, ['get_issue', 'list_issue_statuses', 'create_comment']),
}

export const GITHUB_PROFILE: TrackerMcpProfile = {
  id: 'github',
  provider: 'github-issues',
  displayName: 'GitHub Issues',
  autoSelect: false,
  tools: {
    getIssue: 'issue_read',
    searchIssues: 'search_issues',
    getComments: 'issue_read',
    comment: 'add_issue_comment',
    transition: 'issue_write',
    createIssue: 'issue_write',
    updateIssue: 'issue_write',
    linkIssues: 'sub_issue_write',
  },
  args: {
    getIssue: a => ({ method: 'get', ...githubIssueParts(a.key) }),
    getComments: a => ({ method: 'get_comments', ...githubIssueParts(a.key) }),
    comment: a => ({ ...githubIssueParts(a.key), body: a.body }),
    transition: a => ({
      method: 'update',
      ...githubIssueParts(a.key),
      state: /^(done|closed?|resolved)$/i.test(a.status ?? '') ? 'closed' : 'open',
    }),
  },
  notes: [
    'GitHub issues only have open/closed: "done" means closed, every other category means open.',
    'Sub-issues are linked with the sub-issue tool after both issues exist.',
  ],
  matches: server =>
    host(server.url) === 'api.githubcopilot.com' ||
    hasTools(server, ['add_issue_comment', 'issue_read']) ||
    hasTools(server, ['add_issue_comment', 'get_issue']),
}

export const TRACKER_MCP_PROFILES: ReadonlyArray<TrackerMcpProfile> = [
  ATLASSIAN_ROVO_PROFILE,
  MCP_ATLASSIAN_PROFILE,
  LINEAR_PROFILE,
  GITHUB_PROFILE,
]

export function matchTrackerProfile(server: ExecutorMcpServerInfo): TrackerMcpProfile | undefined {
  return TRACKER_MCP_PROFILES.find(p => p.matches(server))
}
