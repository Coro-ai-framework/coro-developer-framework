// ── Legacy Jira REST client ──────────────────────────────────────────────────
//
// This is the legacy spec-writer / mcp-handler path that predates the
// `TrackerPluginRuntime`. It lived at `clients/jira.ts` historically;
// P2 moved it under the Jira plugin so the plugin owns its full
// surface area. The standalone `clients/jira.ts` re-exports from
// here for one release so external callers (and the back-compat MCP
// wrappers in P3) compile unchanged.
//
// Once P3's `tracker_*` MCP tools land and the `jira_*` wrappers are
// removed, this file disappears. The plugin's `JiraTrackerClient`
// (a different file under `clients/tracker/jira.ts`) covers all
// production tracker writes; this one is read-skewed and used only
// by the legacy spec-writer flow.

import { Settings } from '../../../config/settings'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JiraIssue {
  key: string
  fields: {
    summary: string
    description: string | null
    status: { name: string }
    assignee: { displayName: string; emailAddress: string } | null
    reporter: { displayName: string } | null
    priority: { name: string } | null
    labels: string[]
    components: { name: string }[]
    customfield_acceptance_criteria?: string
    comment?: { comments: JiraComment[] }
  }
}

export interface JiraComment {
  id: string
  author: { displayName: string }
  body: string
  created: string
  updated: string
}

export interface JiraTransition {
  id: string
  name: string
  to: { name: string }
}

export interface JiraUnavailableResult {
  available: false
  reason: string
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * Jira REST API v3 client used by the spec-writer and the legacy
 * `jira_*` MCP tool surface. Returns `{ available: false }` when
 * `jira.baseUrl` is unset so callers can degrade gracefully on
 * deployments without Jira configured.
 */
export class JiraClient {
  private readonly available: boolean
  private readonly authHeader: string

  constructor(private readonly settings: { baseUrl: string; username: string; apiToken: string }) {
    this.available = settings.baseUrl.length > 0 && settings.apiToken.length > 0
    this.authHeader = `Basic ${Buffer.from(`${settings.username}:${settings.apiToken}`).toString('base64')}`
  }

  async getIssue(ticketId: string): Promise<JiraIssue | JiraUnavailableResult> {
    if (!this.available) return this.unavailable()

    const res = await fetch(
      `${this.settings.baseUrl}/rest/api/3/issue/${ticketId}?expand=renderedFields,names`,
      { headers: this.headers() },
    )

    if (!res.ok) {
      const text = await res.text()
      return { available: false, reason: `Jira getIssue failed (${res.status}): ${text}` }
    }

    return res.json() as Promise<JiraIssue>
  }

  async postComment(ticketId: string, body: string): Promise<{ id: string } | JiraUnavailableResult> {
    if (!this.available) return this.unavailable()

    const res = await fetch(`${this.settings.baseUrl}/rest/api/3/issue/${ticketId}/comment`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
        },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      return { available: false, reason: `Jira postComment failed (${res.status}): ${text}` }
    }

    return res.json() as Promise<{ id: string }>
  }

  async transitionIssue(ticketId: string, transitionId: string): Promise<void | JiraUnavailableResult> {
    if (!this.available) return this.unavailable()

    const res = await fetch(`${this.settings.baseUrl}/rest/api/3/issue/${ticketId}/transitions`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: transitionId } }),
    })

    if (!res.ok) {
      const text = await res.text()
      return { available: false, reason: `Jira transitionIssue failed (${res.status}): ${text}` }
    }
  }

  async getTransitions(ticketId: string): Promise<JiraTransition[] | JiraUnavailableResult> {
    if (!this.available) return this.unavailable()

    const res = await fetch(
      `${this.settings.baseUrl}/rest/api/3/issue/${ticketId}/transitions`,
      { headers: this.headers() },
    )

    if (!res.ok) return []

    const body = await res.json() as { transitions: JiraTransition[] }
    return body.transitions
  }

  async getAssignedIssues(
    username: string,
    additionalJql = '',
  ): Promise<JiraIssue[] | JiraUnavailableResult> {
    if (!this.available) return this.unavailable()

    const jql = [`assignee = "${username}"`, additionalJql].filter(Boolean).join(' AND ')
    const params = new URLSearchParams({ jql, maxResults: '50' })

    const res = await fetch(`${this.settings.baseUrl}/rest/api/3/search?${params}`, {
      headers: this.headers(),
    })

    if (!res.ok) {
      const text = await res.text()
      return { available: false, reason: `Jira search failed (${res.status}): ${text}` }
    }

    const body = await res.json() as { issues: JiraIssue[] }
    return body.issues
  }

  private unavailable(): JiraUnavailableResult {
    return {
      available: false,
      reason: 'Jira not configured (jira.baseUrl or jira.apiToken is empty)',
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      Accept: 'application/json',
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createJiraClient(settings: Settings): JiraClient {
  return new JiraClient(settings.jira)
}
