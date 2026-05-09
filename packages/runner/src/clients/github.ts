import type { Settings } from '../config/settings'

// ── Errors ────────────────────────────────────────────────────────────────────

export class GitHubError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`GitHub ${statusCode}: ${message}`)
    this.name = 'GitHubError'
  }
}

// ── Types (matching BB types for interop) ─────────────────────────────────────

export interface CreateRepoOptions {
  repoSlug: string
  isPrivate?: boolean
  description?: string
}

export interface CreatePrOptions {
  repoSlug: string
  title: string
  description?: string
  sourceBranch: string
  targetBranch?: string
  reviewerUsernames?: string[]
}

export interface PrComment {
  id: number
  content: { raw: string }
  created_on: string
  updated_on: string
  parent?: { id: number }
  inline?: { path: string; from?: number; to?: number }
}

export interface PullRequest {
  id: number
  title: string
  description: string
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'
  source: { branch: { name: string } }
  destination: { branch: { name: string } }
  author: { display_name: string }
  created_on: string
  updated_on: string
  links: { html: { href: string } }
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * GitHub REST API client. Mirrors the BitBucketClient interface so MCP
 * handlers can use either client interchangeably.
 *
 * Auth: Personal Access Token (fine-grained or classic) via Bearer header.
 */
export class GitHubClient {
  private readonly token: string
  private readonly baseUrl: string

  constructor(
    private readonly owner: string,
    token: string,
    baseUrl = 'https://api.github.com',
  ) {
    this.token = token
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  /**
   * Coerce any of these input shapes into a bare repo slug:
   *   - `repo`
   *   - `owner/repo`
   *   - `https://github.com/owner/repo`
   *   - `https://github.com/owner/repo.git`
   *   - `git@github.com:owner/repo.git`
   *
   * Agents (and historic prMappings) sometimes hand us a URL or `owner/repo`
   * pair instead of just `repo`. Without this, the API path becomes
   * `/repos/<configuredOwner>/<the-whole-url>/pulls/<id>` which 404s.
   */
  private slug(repoSlug: string): string {
    let s = String(repoSlug ?? '').trim()
    // Strip protocol + host (https://, git@github.com:)
    s = s.replace(/^https?:\/\/[^/]+\//, '')
    s = s.replace(/^git@[^:]+:/, '')
    // Strip a leading owner/ prefix
    const lastSlash = s.lastIndexOf('/')
    if (lastSlash >= 0) s = s.slice(lastSlash + 1)
    // Strip trailing .git or trailing slash
    s = s.replace(/\.git$/, '').replace(/\/$/, '')
    return s
  }

  // ── Repositories ────────────────────────────────────────────────────────────

  async createRepo(opts: CreateRepoOptions): Promise<{ full_name: string }> {
    const body = {
      name: opts.repoSlug,
      private: opts.isPrivate ?? true,
      description: opts.description ?? '',
      auto_init: false,
    }
    const data = await this.request<{ full_name: string }>('POST', `/user/repos`, body)
    return { full_name: data.full_name }
  }

  // ── Pull requests ────────────────────────────────────────────────────────────

  async createPr(opts: CreatePrOptions): Promise<PullRequest> {
    const body = {
      title: opts.title,
      body: opts.description ?? '',
      head: opts.sourceBranch,
      base: opts.targetBranch ?? 'main',
    }

    const ghPr = await this.request<GhPullRequest>(
      'POST',
      `/repos/${this.owner}/${opts.repoSlug}/pulls`,
      body,
    )

    // Request reviewers if provided
    if (opts.reviewerUsernames && opts.reviewerUsernames.length > 0) {
      try {
        await this.request(
          'POST',
          `/repos/${this.owner}/${opts.repoSlug}/pulls/${ghPr.number}/requested_reviewers`,
          { reviewers: opts.reviewerUsernames },
        )
      } catch {
        // Non-fatal: reviewer might not have access
      }
    }

    return normalizeGhPr(ghPr)
  }

  async getPr(repoSlug: string, prId: number): Promise<PullRequest> {
    const ghPr = await this.request<GhPullRequest>(
      'GET',
      `/repos/${this.owner}/${repoSlug}/pulls/${prId}`,
    )
    return normalizeGhPr(ghPr)
  }

  async getPrStatus(repoSlug: string, prId: number): Promise<{ state: string; approvalCount: number }> {
    const ghPr = await this.request<GhPullRequest>(
      'GET',
      `/repos/${this.owner}/${repoSlug}/pulls/${prId}`,
    )
    const reviews = await this.request<GhReview[]>(
      'GET',
      `/repos/${this.owner}/${repoSlug}/pulls/${prId}/reviews`,
    )
    const approvalCount = reviews.filter(r => r.state === 'APPROVED').length
    return {
      state: ghPr.merged ? 'MERGED' : ghPr.state.toUpperCase(),
      approvalCount,
    }
  }

  async approvePr(repoSlug: string, prId: number): Promise<void> {
    await this.request(
      'POST',
      `/repos/${this.owner}/${repoSlug}/pulls/${prId}/reviews`,
      { event: 'APPROVE' },
    )
  }

  async mergePr(repoSlug: string, prId: number, message?: string): Promise<PullRequest> {
    await this.request(
      'PUT',
      `/repos/${this.owner}/${repoSlug}/pulls/${prId}/merge`,
      {
        commit_title: message ?? 'Merged via A5 Agent',
        merge_method: 'squash',
      },
    )
    return this.getPr(repoSlug, prId)
  }

  // ── Comments ────────────────────────────────────────────────────────────────

  async getComments(repoSlug: string, prId: number): Promise<PrComment[]> {
    // GitHub has two comment APIs: issue comments (top-level) and review comments (inline)
    const [issueComments, reviewComments] = await Promise.all([
      this.listAll<GhIssueComment>(`/repos/${this.owner}/${repoSlug}/issues/${prId}/comments`),
      this.listAll<GhReviewComment>(`/repos/${this.owner}/${repoSlug}/pulls/${prId}/comments`),
    ])

    const mapped: PrComment[] = [
      ...issueComments.map(c => ({
        id: c.id,
        content: { raw: c.body },
        created_on: c.created_at,
        updated_on: c.updated_at,
      })),
      ...reviewComments.map(c => ({
        id: c.id,
        content: { raw: c.body },
        created_on: c.created_at,
        updated_on: c.updated_at,
        parent: c.in_reply_to_id ? { id: c.in_reply_to_id } : undefined,
        inline: { path: c.path, to: c.line ?? undefined },
      })),
    ]

    return mapped.sort((a, b) => a.created_on.localeCompare(b.created_on))
  }

  async postComment(repoSlug: string, prId: number, content: string): Promise<PrComment> {
    const repo = this.slug(repoSlug)
    // Top-level comments go through the Issues API
    const c = await this.request<GhIssueComment>(
      'POST',
      `/repos/${this.owner}/${repo}/issues/${prId}/comments`,
      { body: content },
    )
    return {
      id: c.id,
      content: { raw: c.body },
      created_on: c.created_at,
      updated_on: c.updated_at,
    }
  }

  async replyToComment(repoSlug: string, prId: number, parentId: number, content: string): Promise<PrComment> {
    const repo = this.slug(repoSlug)
    // Reply to a review comment
    const c = await this.request<GhReviewComment>(
      'POST',
      `/repos/${this.owner}/${repo}/pulls/${prId}/comments/${parentId}/replies`,
      { body: content },
    )
    return {
      id: c.id,
      content: { raw: c.body },
      created_on: c.created_at,
      updated_on: c.updated_at,
      parent: { id: parentId },
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async request<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    let lastError: GitHubError | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await sleep(Math.pow(2, attempt) * 1000)
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      if (res.ok) {
        if (res.status === 204) return undefined as T
        return await res.json() as T
      }

      // Rate limited
      if (res.status === 403) {
        const remaining = res.headers.get('x-ratelimit-remaining')
        if (remaining === '0') {
          const resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000
          const waitMs = Math.max(resetAt - Date.now(), 1000)
          await sleep(Math.min(waitMs, 30000))
          continue
        }
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new GitHubError(res.status, await res.text())
        continue
      }

      throw new GitHubError(res.status, await res.text())
    }

    throw lastError ?? new GitHubError(500, 'Max retries exceeded')
  }

  private async listAll<T>(path: string): Promise<T[]> {
    const results: T[] = []
    let url: string | null = `${this.baseUrl}${path}?per_page=100`

    while (url) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })

      if (!res.ok) {
        throw new GitHubError(res.status, await res.text())
      }

      const data = await res.json() as T[]
      results.push(...data)

      // Parse Link header for pagination
      const link = res.headers.get('link')
      url = null
      if (link) {
        const next = link.split(',').find(s => s.includes('rel="next"'))
        if (next) {
          const match = next.match(/<([^>]+)>/)
          if (match) url = match[1]
        }
      }
    }

    return results
  }
}

// ── GitHub API types (internal) ───────────────────────────────────────────────

interface GhPullRequest {
  number: number
  title: string
  body: string
  state: string
  merged: boolean
  head: { ref: string }
  base: { ref: string }
  user: { login: string }
  html_url: string
  created_at: string
  updated_at: string
}

interface GhReview {
  state: string
}

interface GhIssueComment {
  id: number
  body: string
  created_at: string
  updated_at: string
}

interface GhReviewComment {
  id: number
  body: string
  path: string
  line: number | null
  in_reply_to_id?: number
  created_at: string
  updated_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeGhPr(ghPr: GhPullRequest): PullRequest {
  let state: PullRequest['state'] = 'OPEN'
  if (ghPr.merged) state = 'MERGED'
  else if (ghPr.state === 'closed') state = 'DECLINED'

  return {
    id: ghPr.number,
    title: ghPr.title,
    description: ghPr.body,
    state,
    source: { branch: { name: ghPr.head.ref } },
    destination: { branch: { name: ghPr.base.ref } },
    author: { display_name: ghPr.user.login },
    created_on: ghPr.created_at,
    updated_on: ghPr.updated_at,
    links: { html: { href: ghPr.html_url } },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createGitHubClient(settings: Settings): GitHubClient | null {
  if (!settings.github.token) return null
  return new GitHubClient(
    settings.github.owner,
    settings.github.token,
    settings.github.baseUrl,
  )
}
