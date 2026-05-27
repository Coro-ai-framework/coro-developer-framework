// ── GitHub Issues tracker client ─────────────────────────────────────────────
//
// Implements `TrackerClient` against the GitHub REST API v3 (issues + labels +
// comments). GitHub Issues has no native epic / parent concept, so we model:
//
//   Epic     → a regular issue tagged with the `epic` label whose body is a
//              GFM task list referencing the children. The campaign-planner
//              treats the parent issue's number as the `parentKey` for
//              `createIssue` calls.
//   Child    → a regular issue. When a `parentKey` is supplied we append a
//              checkbox line `- [ ] #<child>` to the parent's body so the
//              GitHub UI shows the same hierarchy that Jira does natively.
//   Link     → a comment on `fromKey` of the form `<relation> #<toKey>`.
//              GitHub renders these as cross-references on both issues; we
//              do NOT use the experimental `subIssues` GraphQL API to keep
//              the integration on stable REST.
//
// `projectKey` is `owner/repo`. The factory sets a sensible default but
// agents can override per call (e.g. when the campaign spans multiple
// repos within the same org).

import type {
  CommentIssueArgs,
  CreateEpicArgs,
  CreateIssueArgs,
  LinkIssuesArgs,
  TrackerIssue,
  TrackerNotConfigured,
  TrackerResult,
  TransitionIssueArgs,
} from './types'

function isUnavailable<T>(r: TrackerResult<T>): r is TrackerNotConfigured {
  return typeof r === 'object' && r !== null && 'available' in r && (r as { available?: unknown }).available === false
}

export interface GitHubTrackerSettings {
  /** Personal access token or fine-grained token with `issues:write` + `repo` scopes. */
  token: string
  /** Default `<owner>` for `projectKey`s passed as bare repo names. */
  defaultOwner: string
  /**
   * Optional default repo suffix. Combined with `defaultOwner` to form a
   * fallback `projectKey` when the agent calls a method without one.
   */
  defaultRepo?: string
  /** Override for GitHub Enterprise Server. Defaults to `https://api.github.com`. */
  apiBaseUrl?: string
}

interface GithubIssueResponse {
  number: number
  html_url: string
  title: string
  body?: string | null
  state: 'open' | 'closed'
  state_reason?: string | null
  labels?: Array<string | { name?: string }>
}

const EPIC_LABEL = 'epic'
const DEFAULT_API_BASE = 'https://api.github.com'

/** Parse `owner/repo` (with bare-repo fallback to the default owner). */
function parseProjectKey(projectKey: string, defaults: { owner: string; repo?: string }): { owner: string; repo: string } {
  if (projectKey.includes('/')) {
    const [owner, repo] = projectKey.split('/', 2)
    if (owner && repo) return { owner, repo }
  }
  if (projectKey.length > 0) {
    return { owner: defaults.owner, repo: projectKey }
  }
  if (!defaults.repo) {
    throw new Error(
      'GitHub tracker projectKey must be "owner/repo" — pass it explicitly or configure github.repo.',
    )
  }
  return { owner: defaults.owner, repo: defaults.repo }
}

function toTrackerIssue(raw: GithubIssueResponse, projectKey: string): TrackerIssue {
  const labels = (raw.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean)
  return {
    key: `${projectKey}#${raw.number}`,
    url: raw.html_url,
    summary: raw.title,
    status: raw.state === 'closed' ? (raw.state_reason ?? 'closed') : 'open',
    ...(raw.body?.trim() ? { description: raw.body.trim() } : {}),
    ...(labels.includes(EPIC_LABEL) ? { issueType: 'Epic' } : {}),
  }
}

/**
 * Split a `key` of either form `owner/repo#42` or `42` into the addressing
 * triple. Bare `42` falls back to the default project — agents are expected
 * to pass full keys when working across repos.
 */
function parseIssueKey(key: string, defaults: { owner: string; repo?: string }): { owner: string; repo: string; number: number; projectKey: string } {
  const hashIdx = key.indexOf('#')
  if (hashIdx === -1) {
    const number = Number(key)
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`GitHub issue key must be "owner/repo#<number>" or a numeric id; got "${key}".`)
    }
    if (!defaults.repo) {
      throw new Error(
        `GitHub tracker key "${key}" missing owner/repo prefix and no default repo configured.`,
      )
    }
    return { owner: defaults.owner, repo: defaults.repo, number, projectKey: `${defaults.owner}/${defaults.repo}` }
  }
  const projectKey = key.slice(0, hashIdx)
  const numStr = key.slice(hashIdx + 1)
  const number = Number(numStr)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`GitHub issue key has non-numeric issue number: "${key}".`)
  }
  const { owner, repo } = parseProjectKey(projectKey, defaults)
  return { owner, repo, number, projectKey: `${owner}/${repo}` }
}

export class GitHubTrackerClient {
  readonly provider = 'github' as const
  private readonly available: boolean
  private readonly apiBaseUrl: string

  constructor(private readonly settings: GitHubTrackerSettings) {
    this.available = settings.token.length > 0 && settings.defaultOwner.length > 0
    this.apiBaseUrl = (settings.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  }

  isAvailable(): boolean {
    return this.available
  }

  async createEpic(args: CreateEpicArgs): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    const labels = Array.from(new Set([EPIC_LABEL, ...(args.labels ?? [])]))
    return this.createIssueRaw({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      labels,
    })
  }

  async createIssue(args: CreateIssueArgs): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    const issue = await this.createIssueRaw({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      ...(args.labels ? { labels: args.labels } : {}),
    })
    if (isUnavailable(issue)) return issue

    if (args.parentKey) {
      // Best-effort: append a task-list reference on the parent so the GitHub
      // UI shows the parent → child relation. Failures are swallowed —
      // an unlinked child is still a valid TrackerIssue and the campaign
      // coordinator owns dependency state independently.
      try {
        await this.appendTaskItem(args.parentKey, issue.key)
      } catch {
        // see comment above
      }
    }
    return issue
  }

  async linkIssues(args: LinkIssuesArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    // GitHub does not have a native typed-link API on REST. We fall back to
    // a referencing comment, which renders as a cross-reference on both
    // issues. Not as rich as Jira's blocked-by, but sufficient for
    // post-hoc tracing — the dispatcher's `dependsOn` is the source of truth
    // for execution order.
    const verb = args.relation.toLowerCase().includes('block') ? 'Blocked by' : args.relation
    return this.commentIssue({ key: args.fromKey, body: `${verb} ${this.toIssueRef(args.toKey)}` })
  }

  async getIssue(key: string): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    const { owner, repo, number, projectKey } = parseIssueKey(key, this.defaults())
    const res = await this.fetch(`/repos/${owner}/${repo}/issues/${number}`)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub getIssue failed (${res.status}): ${text}`)
    }
    const raw = (await res.json()) as GithubIssueResponse
    return toTrackerIssue(raw, projectKey)
  }

  async searchIssues(query: string, limit = 10): Promise<TrackerResult<TrackerIssue[]>> {
    if (!this.available) return this.unavailable()
    const defaults = this.defaults()
    const repoScope = defaults.repo ? ` repo:${defaults.owner}/${defaults.repo}` : ` user:${defaults.owner}`
    const q = encodeURIComponent(`${query}${repoScope} is:issue`)
    const res = await this.fetch(`/search/issues?q=${q}&per_page=${Math.min(Math.max(limit, 1), 20)}`)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub searchIssues failed (${res.status}): ${text}`)
    }
    const body = (await res.json()) as { items: GithubIssueResponse[] }
    return (body.items ?? []).map(item => {
      const match = item.html_url.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)
      const projectKey = match?.[1] ?? `${defaults.owner}/${defaults.repo ?? 'unknown'}`
      return toTrackerIssue(item, projectKey)
    })
  }

  async listChildren(parentKey: string): Promise<TrackerResult<TrackerIssue[]>> {
    if (!this.available) return this.unavailable()
    const parent = await this.getIssue(parentKey)
    if (isUnavailable(parent)) return parent

    const { owner, repo, number, projectKey } = parseIssueKey(parentKey, this.defaults())
    const parentBody = await this.fetchParentBody(owner, repo, number)
    const refs = extractTaskListRefs(parentBody, projectKey)
    if (refs.length === 0) return []

    // Resolve each reference. Parallelism is fine — small N, idempotent reads.
    const issues = await Promise.all(refs.map(ref => this.getIssue(ref)))
    const resolved: TrackerIssue[] = []
    for (const i of issues) {
      if (!isUnavailable(i)) resolved.push(i)
    }
    return resolved
  }

  async transitionIssue(args: TransitionIssueArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    const { owner, repo, number } = parseIssueKey(args.key, this.defaults())
    const lower = args.status.toLowerCase()
    const targetState = lower.includes('done') || lower.includes('closed') || lower === 'complete'
      ? 'closed' as const
      : 'open' as const
    const stateReason = targetState === 'closed'
      ? (lower.includes('not planned') || lower.includes('cancel') ? 'not_planned' : 'completed')
      : 'reopened'

    const res = await this.fetch(`/repos/${owner}/${repo}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: targetState, state_reason: stateReason }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub transitionIssue failed (${res.status}): ${text}`)
    }
    return { ok: true }
  }

  async commentIssue(args: CommentIssueArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    const { owner, repo, number } = parseIssueKey(args.key, this.defaults())
    const res = await this.fetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: args.body }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub commentIssue failed (${res.status}): ${text}`)
    }
    return { ok: true }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private defaults(): { owner: string; repo?: string } {
    return this.settings.defaultRepo
      ? { owner: this.settings.defaultOwner, repo: this.settings.defaultRepo }
      : { owner: this.settings.defaultOwner }
  }

  private async createIssueRaw(args: {
    projectKey: string
    summary: string
    description: string
    labels?: string[]
  }): Promise<TrackerResult<TrackerIssue>> {
    const { owner, repo } = parseProjectKey(args.projectKey, this.defaults())
    const body: Record<string, unknown> = {
      title: args.summary,
      body: args.description,
    }
    if (args.labels && args.labels.length > 0) body['labels'] = args.labels

    const res = await this.fetch(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub createIssue failed (${res.status}): ${text}`)
    }
    const raw = (await res.json()) as GithubIssueResponse
    return toTrackerIssue(raw, `${owner}/${repo}`)
  }

  private async appendTaskItem(parentKey: string, childKey: string): Promise<void> {
    const { owner, repo, number } = parseIssueKey(parentKey, this.defaults())
    const parentBody = await this.fetchParentBody(owner, repo, number)
    const ref = this.toIssueRef(childKey)
    const taskLine = `- [ ] ${ref}`
    if (parentBody.includes(taskLine)) return
    const sep = parentBody.endsWith('\n') || parentBody.length === 0 ? '' : '\n'
    const next = `${parentBody}${sep}\n${taskLine}\n`
    const res = await this.fetch(`/repos/${owner}/${repo}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: next }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub updateIssueBody failed (${res.status}): ${text}`)
    }
  }

  private async fetchParentBody(owner: string, repo: string, number: number): Promise<string> {
    const res = await this.fetch(`/repos/${owner}/${repo}/issues/${number}`)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub fetchParent failed (${res.status}): ${text}`)
    }
    const raw = (await res.json()) as GithubIssueResponse
    return raw.body ?? ''
  }

  /**
   * Format a child reference. We use the cross-repo `owner/repo#number`
   * form when the child sits in a different repo from the parent;
   * otherwise the bare `#number` reference renders cleaner in the GitHub
   * task-list UI. The campaign view stores fully-qualified keys
   * regardless.
   */
  private toIssueRef(key: string): string {
    return key.includes('#') ? key : `#${key}`
  }

  private async fetch(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    return fetch(`${this.apiBaseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `token ${this.settings.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    })
  }

  private unavailable(): TrackerNotConfigured {
    return {
      available: false,
      reason: 'GitHub Issues tracker is not configured (token/owner missing)',
    }
  }
}

/**
 * Pull `owner/repo#N` (or bare `#N`) references out of a GFM task-list body.
 * We accept both checked and unchecked items so we can list dependencies on
 * an in-progress epic without losing already-completed children. Anything
 * that doesn't match the expected shape is dropped silently — the parent
 * body is markdown that humans may have edited freely.
 */
function extractTaskListRefs(body: string, fallbackProjectKey: string): string[] {
  const refs: string[] = []
  const lineRe = /^\s*-\s*\[[ xX]\]\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gm
  for (const match of body.matchAll(lineRe)) {
    const projectKey = match[1] ?? fallbackProjectKey
    refs.push(`${projectKey}#${match[2]}`)
  }
  return Array.from(new Set(refs))
}
