// ── Jira tracker client ──────────────────────────────────────────────────────
//
// Implements `TrackerClient` against Jira REST API v3. We deliberately keep
// this distinct from `clients/jira.ts` (which is the read-skewed
// spec-writer client) so adding write paths here does not alter that
// established contract. The two clients share auth shape but not state.
//
// All write methods are idempotent at the provider level: re-running a
// create returns a new issue (Jira does not de-dup), so callers should
// guard against double-invocation themselves. The campaign-planner agent
// is expected to keep a working list of created issue keys to avoid
// re-creation if a turn is retried.

import type {
  CommentIssueArgs,
  CreateEpicArgs,
  CreateIssueArgs,
  LinkIssuesArgs,
  TrackerClient,
  TrackerIssue,
  TrackerNotConfigured,
  TrackerResult,
  TransitionIssueArgs,
} from './types'

export interface JiraTrackerSettings {
  baseUrl: string
  username: string
  apiToken: string
}

interface JiraIssueResponse {
  key: string
  self: string
  fields?: {
    summary?: string
    status?: { name?: string }
    issuetype?: { name?: string }
    parent?: { key?: string }
    description?: unknown
  }
}

interface JiraCreateIssueResponse {
  id: string
  key: string
  self: string
}

interface JiraSearchResponse {
  issues: JiraIssueResponse[]
}

interface JiraTransitionsResponse {
  transitions: Array<{ id: string; name: string; to?: { name?: string } }>
}

const DEFAULT_TASK_ISSUETYPE = 'Task'
const DEFAULT_EPIC_ISSUETYPE = 'Epic'

/**
 * Map a provider-native Jira issue payload to the abstraction's `TrackerIssue`.
 * Defensive about partial fields because Jira can elide `fields` when only the
 * thin "create" response is returned; we do best-effort population from the
 * raw response and let callers refresh via `getIssue` if more detail is
 * needed.
 */
function toTrackerIssue(self: string, raw: JiraIssueResponse, baseUrl: string): TrackerIssue {
  const browseUrl = self
    ? self.replace(/\/rest\/api\/3\/issue\/.*$/, `/browse/${raw.key}`)
    : `${baseUrl.replace(/\/$/, '')}/browse/${raw.key}`
  return {
    key: raw.key,
    url: browseUrl,
    summary: raw.fields?.summary ?? '',
    status: raw.fields?.status?.name ?? '',
    ...(raw.fields?.issuetype?.name ? { issueType: raw.fields.issuetype.name } : {}),
    ...(raw.fields?.parent?.key ? { parentKey: raw.fields.parent.key } : {}),
  }
}

export class JiraTrackerClient implements TrackerClient {
  readonly provider = 'jira' as const
  private readonly authHeader: string
  private readonly available: boolean

  constructor(private readonly settings: JiraTrackerSettings) {
    this.available =
      settings.baseUrl.length > 0 &&
      settings.username.length > 0 &&
      settings.apiToken.length > 0
    this.authHeader = `Basic ${Buffer.from(`${settings.username}:${settings.apiToken}`).toString('base64')}`
  }

  isAvailable(): boolean {
    return this.available
  }

  async createEpic(args: CreateEpicArgs): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    return this.doCreate({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      issueType: DEFAULT_EPIC_ISSUETYPE,
      ...(args.labels ? { labels: args.labels } : {}),
    })
  }

  async createIssue(args: CreateIssueArgs): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    return this.doCreate({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      issueType: args.issueType ?? DEFAULT_TASK_ISSUETYPE,
      ...(args.parentKey ? { parentKey: args.parentKey } : {}),
      ...(args.labels ? { labels: args.labels } : {}),
    })
  }

  async linkIssues(args: LinkIssuesArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    // Jira's issueLink API accepts the link type by name. We pass `fromKey`
    // as `inwardIssue` so the resulting "is blocked by" reads naturally on
    // fromKey's UI ("PROJ-1 is blocked by PROJ-2"), matching the
    // campaign's `dependsOn` semantics.
    const res = await fetch(`${this.baseUrl()}/rest/api/3/issueLink`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: { name: args.relation },
        inwardIssue: { key: args.fromKey },
        outwardIssue: { key: args.toKey },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Jira linkIssues failed (${res.status}): ${text}`)
    }
    return { ok: true }
  }

  async getIssue(key: string): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    const res = await fetch(
      `${this.baseUrl()}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,description,issuetype,parent`,
      { headers: this.headers() },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Jira getIssue failed (${res.status}): ${text}`)
    }
    const raw = (await res.json()) as JiraIssueResponse
    const issue = toTrackerIssue(raw.self, raw, this.settings.baseUrl)
    const description = extractJiraDescription(raw.fields?.description)
    return description ? { ...issue, description } : issue
  }

  async searchIssues(query: string, limit = 10): Promise<TrackerResult<TrackerIssue[]>> {
    if (!this.available) return this.unavailable()
    const safe = query.replace(/"/g, '\\"')
    const jql = `text ~ "${safe}" OR summary ~ "${safe}" ORDER BY updated DESC`
    const params = new URLSearchParams({
      jql,
      maxResults: String(Math.min(Math.max(limit, 1), 20)),
      fields: 'summary,status,description',
    })
    const res = await fetch(`${this.baseUrl()}/rest/api/3/search?${params.toString()}`, {
      headers: this.headers(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Jira searchIssues failed (${res.status}): ${text}`)
    }
    const body = (await res.json()) as JiraSearchResponse
    return body.issues.map(i => {
      const issue = toTrackerIssue(i.self, i, this.settings.baseUrl)
      const description = extractJiraDescription(i.fields?.description)
      return description ? { ...issue, description } : issue
    })
  }

  async listChildren(parentKey: string): Promise<TrackerResult<TrackerIssue[]>> {
    if (!this.available) return this.unavailable()
    // Jira represents epic→child via `parent = <key>` for next-gen projects;
    // we use that JQL because it works in both classic-with-epics and
    // next-gen configurations. Older "epic link" custom field setups will
    // need a tenant-specific override — we do NOT try to infer the field
    // here.
    const params = new URLSearchParams({ jql: `parent = "${parentKey}"`, maxResults: '50' })
    const res = await fetch(`${this.baseUrl()}/rest/api/3/search?${params.toString()}`, {
      headers: this.headers(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Jira search failed (${res.status}): ${text}`)
    }
    const body = (await res.json()) as JiraSearchResponse
    return body.issues.map(i => toTrackerIssue(i.self, i, this.settings.baseUrl))
  }

  async transitionIssue(args: TransitionIssueArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    // Jira requires a transition ID (not a status name); we look it up first.
    const transRes = await fetch(
      `${this.baseUrl()}/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`,
      { headers: this.headers() },
    )
    if (!transRes.ok) {
      const text = await transRes.text()
      throw new Error(`Jira getTransitions failed (${transRes.status}): ${text}`)
    }
    const transitions = ((await transRes.json()) as JiraTransitionsResponse).transitions
    const target = transitions.find(t =>
      t.name.toLowerCase() === args.status.toLowerCase() ||
      (t.to?.name ?? '').toLowerCase() === args.status.toLowerCase(),
    )
    if (!target) {
      throw new Error(
        `No Jira transition reaches "${args.status}" from issue ${args.key}'s ` +
          `current state. Available: ${transitions.map(t => t.name).join(', ')}.`,
      )
    }
    const res = await fetch(
      `${this.baseUrl()}/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition: { id: target.id } }),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Jira transitionIssue failed (${res.status}): ${text}`)
    }
    return { ok: true }
  }

  async commentIssue(args: CommentIssueArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    const res = await fetch(`${this.baseUrl()}/rest/api/3/issue/${encodeURIComponent(args.key)}/comment`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: args.body }] }],
        },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Jira commentIssue failed (${res.status}): ${text}`)
    }
    return { ok: true }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async doCreate(args: {
    projectKey: string
    summary: string
    description: string
    issueType: string
    parentKey?: string
    labels?: string[]
  }): Promise<TrackerResult<TrackerIssue>> {
    const fields: Record<string, unknown> = {
      project: { key: args.projectKey },
      summary: args.summary,
      issuetype: { name: args.issueType },
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description }] }],
      },
    }
    if (args.parentKey) fields['parent'] = { key: args.parentKey }
    if (args.labels && args.labels.length > 0) fields['labels'] = args.labels

    const res = await fetch(`${this.baseUrl()}/rest/api/3/issue`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Jira createIssue failed (${res.status}): ${text}`)
    }
    const raw = (await res.json()) as JiraCreateIssueResponse

    // Re-fetch the issue to populate `summary` / `status` / `issuetype` so
    // the returned TrackerIssue is comparable to whatever `getIssue` returns
    // for an existing key.
    const refreshed = await this.getIssue(raw.key)
    if ('available' in refreshed && refreshed.available === false) {
      // Tracker became unavailable between create and read — return what we
      // have so the campaign planner still gets a valid TrackerRef.
      return {
        key: raw.key,
        url: `${this.settings.baseUrl.replace(/\/$/, '')}/browse/${raw.key}`,
        summary: args.summary,
        status: '',
        issueType: args.issueType,
        ...(args.parentKey ? { parentKey: args.parentKey } : {}),
      }
    }
    return refreshed
  }

  private baseUrl(): string {
    return this.settings.baseUrl.replace(/\/$/, '')
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      Accept: 'application/json',
    }
  }

  private unavailable(): TrackerNotConfigured {
    return {
      available: false,
      reason: 'Jira tracker is not configured (baseUrl/username/apiToken missing)',
    }
  }
}

function extractJiraDescription(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object') return undefined
  const doc = value as { content?: unknown[] }
  if (!Array.isArray(doc.content)) return undefined
  const parts: string[] = []
  for (const block of doc.content) {
    if (!block || typeof block !== 'object') continue
    const content = (block as { content?: unknown[] }).content
    if (!Array.isArray(content)) continue
    for (const inline of content) {
      if (inline && typeof inline === 'object' && typeof (inline as { text?: unknown }).text === 'string') {
        parts.push((inline as { text: string }).text)
      }
    }
  }
  const joined = parts.join('').trim()
  return joined || undefined
}
