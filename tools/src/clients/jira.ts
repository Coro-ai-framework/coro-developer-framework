import { Settings } from '../config/settings'

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
    customfield_acceptance_criteria?: string   // field key varies by project
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
 * Jira REST API v3 client.
 *
 * **Stubbed** — all methods return `{ available: false }` when `jira.baseUrl`
 * is not configured. This keeps the import chain intact for Phase 3 so that
 * adding full Jira support later only requires filling in method bodies here,
 * not touching any other files.
 */
export class JiraClient {
  private readonly available: boolean
  private readonly authHeader: string

  constructor(private readonly settings: { baseUrl: string; username: string; apiToken: string }) {
    this.available = settings.baseUrl.length > 0 && settings.apiToken.length > 0
    this.authHeader = `Basic ${Buffer.from(`${settings.username}:${settings.apiToken}`).toString('base64')}`
  }

  /**
   * Fetch a Jira issue including summary, description, acceptance criteria,
   * status, components, and labels.
   */
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

  /**
   * Post a comment on a Jira issue (e.g. to report progress or request info).
   */
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

  /**
   * Transition a Jira issue to a new status (e.g. "In Progress", "Done").
   * Use `getTransitions()` first to discover valid transition IDs.
   */
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

  /**
   * List available transitions for an issue.
   * Returns transition IDs and names (e.g. "11" → "In Progress").
   */
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

  /**
   * Find issues assigned to a user with optional JQL filter.
   * Used by the Jira poller to find newly assigned tickets.
   */
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

  // ── Private helpers ─────────────────────────────────────────────────────────

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
