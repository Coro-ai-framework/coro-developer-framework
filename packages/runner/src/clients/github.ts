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
  /**
   * Account that owns the branch, when it lives in a fork rather than in
   * `repoSlug`. GitHub expresses cross-repository PRs as
   * `head: "<owner>:<branch>"`; set this instead of encoding the owner
   * into `sourceBranch` by hand.
   */
  sourceOwner?: string
  targetBranch?: string
  reviewerUsernames?: string[]
}

export interface RepoInfo {
  full_name: string
  default_branch: string
  clone_url: string
  html_url: string
  fork: boolean
}

/** One issue or PR as returned by search / issue reads. */
export interface IssueSearchHit {
  number: number
  title: string
  url: string
  state: string
  /** GitHub's issue search returns PRs too; they carry `pull_request`. */
  isPr: boolean
  body: string
  createdAt: string
  updatedAt: string
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
   * Build the `<owner>/<repo>` segment of an API path from whatever shape
   * the caller had on hand.
   *
   * Every method that addresses a repository MUST go through this. Jobs are
   * routinely started with `--repo owner/repo`, and that string is stored
   * verbatim as the external ref's `repoKey`. Interpolating it raw after the
   * configured owner yields `/repos/<owner>/<owner>/<repo>/…`, which 404s —
   * and because the poller reads those 404s as "the PR is gone", a job can
   * be failed over a purely cosmetic difference in how the repo was named.
   */
  private repoPath(repoSlug: string): string {
    const { owner, repo } = this.parseRepo(repoSlug)
    return `${owner}/${repo}`
  }

  // ── Repositories ────────────────────────────────────────────────────────────

  async createRepo(opts: CreateRepoOptions): Promise<{ full_name: string }> {
    const body = {
      name: this.parseRepo(opts.repoSlug).repo,
      private: opts.isPrivate ?? true,
      description: opts.description ?? '',
      auto_init: false,
    }
    const data = await this.request<{ full_name: string }>('POST', `/user/repos`, body)
    return { full_name: data.full_name }
  }

  /** Repository metadata. `default_branch` is what PR bases are resolved from. */
  async getRepo(repoSlug: string): Promise<RepoInfo> {
    return await this.request<RepoInfo>('GET', `/repos/${this.repoPath(repoSlug)}`)
  }

  /**
   * Ensure a fork of `repoSlug` exists under `forkOwner` (or the
   * authenticated user when omitted) and return it once GitHub reports it
   * ready.
   *
   * Forking is asynchronous: `POST /forks` returns 202 with the repo
   * record before the fork is actually clonable, so we poll until
   * `GET /repos/<forkOwner>/<repo>` succeeds. An existing fork short-
   * circuits — GitHub treats a repeated POST as a no-op, but checking
   * first keeps the common path to one request.
   */
  async ensureFork(
    repoSlug: string,
    forkOwner?: string,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<RepoInfo> {
    const { repo } = this.parseRepo(repoSlug)
    const owner = forkOwner ?? this.owner
    const forkSlug = `${owner}/${repo}`

    const existing = await this.getRepo(forkSlug).catch(() => null)
    if (existing) return existing

    await this.request('POST', `/repos/${this.repoPath(repoSlug)}/forks`, {
      ...(forkOwner ? { organization: forkOwner } : {}),
    })

    const attempts = opts.attempts ?? 10
    const delayMs = opts.delayMs ?? 2000
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(delayMs)
      const fork = await this.getRepo(forkSlug).catch(() => null)
      if (fork) return fork
    }

    throw new GitHubError(
      504,
      `fork ${forkSlug} was requested but did not become available after ${attempts} checks`,
    )
  }

  /**
   * Fast-forward a fork's branch to its parent — GitHub's "Sync fork"
   * button. Returns false when the fork has diverged and cannot be
   * fast-forwarded, which is informative rather than fatal: a PR from a
   * stale base still diffs correctly, it just may conflict.
   */
  async syncFork(forkSlug: string, branch: string): Promise<boolean> {
    try {
      await this.request('POST', `/repos/${this.repoPath(forkSlug)}/merge-upstream`, { branch })
      return true
    } catch (err) {
      if (err instanceof GitHubError && err.statusCode === 409) return false
      throw err
    }
  }

  // ── Issues ──────────────────────────────────────────────────────────────────

  /**
   * Search issues and pull requests inside one repository.
   *
   * `query` goes to GitHub's search syntax verbatim, so a caller can pass
   * a quoted marker string to find a specific record. The `repo:` and
   * `is:` qualifiers are added here so callers cannot accidentally search
   * the whole of GitHub.
   */
  async searchIssues(
    repoSlug: string,
    query: string,
    opts: { state?: 'open' | 'closed' | 'all'; maxResults?: number } = {},
  ): Promise<IssueSearchHit[]> {
    const { owner, repo } = this.parseRepo(repoSlug)
    const state = opts.state ?? 'open'
    const maxResults = opts.maxResults ?? 20
    const qualifiers = [query, `repo:${owner}/${repo}`]
    if (state !== 'all') qualifiers.push(`is:${state}`)

    const data = await this.request<{ items?: GhIssue[] }>(
      'GET',
      `/search/issues?q=${encodeURIComponent(qualifiers.join(' '))}&per_page=${Math.min(maxResults, 100)}`,
    )

    return (data.items ?? []).slice(0, maxResults).map(normalizeGhIssue)
  }

  async createIssue(
    repoSlug: string,
    opts: { title: string; body: string; labels?: string[] },
  ): Promise<IssueSearchHit> {
    const issue = await this.request<GhIssue>('POST', `/repos/${this.repoPath(repoSlug)}/issues`, {
      title: opts.title,
      body: opts.body,
      ...(opts.labels && opts.labels.length > 0 ? { labels: opts.labels } : {}),
    })
    return normalizeGhIssue(issue)
  }

  async getIssue(repoSlug: string, number: number): Promise<IssueSearchHit> {
    const issue = await this.request<GhIssue>(
      'GET',
      `/repos/${this.repoPath(repoSlug)}/issues/${number}`,
    )
    return normalizeGhIssue(issue)
  }

  // ── Pull requests ────────────────────────────────────────────────────────────

  async createPr(opts: CreatePrOptions): Promise<PullRequest> {
    const body = {
      title: opts.title,
      body: opts.description ?? '',
      head: opts.sourceOwner ? `${opts.sourceOwner}:${opts.sourceBranch}` : opts.sourceBranch,
      base: opts.targetBranch ?? 'main',
    }

    const repo = this.repoPath(opts.repoSlug)
    const ghPr = await this.request<GhPullRequest>(
      'POST',
      `/repos/${repo}/pulls`,
      body,
    )

    // Request reviewers if provided
    if (opts.reviewerUsernames && opts.reviewerUsernames.length > 0) {
      try {
        await this.request(
          'POST',
          `/repos/${repo}/pulls/${ghPr.number}/requested_reviewers`,
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
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}`,
    )
    return normalizeGhPr(ghPr)
  }

  async getPrStatus(repoSlug: string, prId: number): Promise<{ state: string; approvalCount: number }> {
    const repo = this.repoPath(repoSlug)
    const ghPr = await this.request<GhPullRequest>(
      'GET',
      `/repos/${repo}/pulls/${prId}`,
    )
    const reviews = await this.request<GhReview[]>(
      'GET',
      `/repos/${repo}/pulls/${prId}/reviews`,
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
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/reviews`,
      { event: 'APPROVE' },
    )
  }

  async mergePr(repoSlug: string, prId: number, message?: string): Promise<PullRequest> {
    await this.request(
      'PUT',
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/merge`,
      {
        commit_title: message ?? 'Merged via A5 Agent',
        merge_method: 'squash',
      },
    )
    return this.getPr(repoSlug, prId)
  }

  // ── Comments ────────────────────────────────────────────────────────────────

  async getComments(repoSlug: string, prId: number): Promise<PrComment[]> {
    const repo = this.repoPath(repoSlug)
    // GitHub has two comment APIs: issue comments (top-level) and review comments (inline)
    const [issueComments, reviewComments] = await Promise.all([
      this.listAll<GhIssueComment>(`/repos/${repo}/issues/${prId}/comments`),
      this.listAll<GhReviewComment>(`/repos/${repo}/pulls/${prId}/comments`),
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
    // Top-level comments go through the Issues API
    const c = await this.request<GhIssueComment>(
      'POST',
      `/repos/${this.repoPath(repoSlug)}/issues/${prId}/comments`,
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
    // Reply to a review comment
    const c = await this.request<GhReviewComment>(
      'POST',
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/comments/${parentId}/replies`,
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

  // ── Repository file reads (plan mode) ─────────────────────────────────────

  async getFileContent(
    repoSlug: string,
    filePath: string,
    ref = 'HEAD',
    maxBytes = 64 * 1024,
  ): Promise<{ content: string; encoding: 'utf-8' | 'base64'; truncated?: boolean }> {
    const { owner, repo } = this.parseRepo(repoSlug)
    const data = await this.request<{
      content: string
      encoding: string
      size?: number
    }>(
      'GET',
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
    )
    if (data.encoding === 'base64') {
      const buf = Buffer.from(data.content.replace(/\n/g, ''), 'base64')
      const truncated = buf.length > maxBytes
      const slice = truncated ? buf.subarray(0, maxBytes) : buf
      return {
        content: slice.toString('utf-8'),
        encoding: 'utf-8',
        ...(truncated ? { truncated: true } : {}),
      }
    }
    const text = data.content ?? ''
    if (text.length > maxBytes) {
      return { content: text.slice(0, maxBytes), encoding: 'utf-8', truncated: true }
    }
    return { content: text, encoding: 'utf-8' }
  }

  /**
   * List the entries at a directory path in a repository. Empty path
   * lists the repository root. `ref` accepts a branch, tag, or commit
   * SHA and defaults to GitHub's `HEAD` alias for the default branch.
   *
   * `GET /repos/{owner}/{repo}/contents/{path}` returns an object for
   * a single file and an array for a directory; we only surface
   * directory listings here so plan mode can walk the tree.
   */
  async listFiles(
    repoSlug: string,
    dirPath: string,
    ref = 'HEAD',
  ): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
    const { owner, repo } = this.parseRepo(repoSlug)
    const trimmedPath = dirPath.replace(/^\/+|\/+$/g, '')
    const encoded = trimmedPath ? `/${trimmedPath.split('/').map(encodeURIComponent).join('/')}` : ''
    const data = await this.request<
      | Array<{ path: string; type: string }>
      | { path: string; type: string }
    >('GET', `/repos/${owner}/${repo}/contents${encoded}?ref=${encodeURIComponent(ref)}`)
    // Single-file responses come back as an object; treat them as a
    // one-entry listing so callers don't need a separate code path.
    const entries = Array.isArray(data) ? data : [data]
    return entries.map(v => ({
      path: v.path,
      type: v.type === 'dir' ? 'dir' : 'file',
    }))
  }

  async searchCode(
    repoSlug: string,
    query: string,
    maxResults = 20,
  ): Promise<Array<{ path: string; snippets: Array<{ seq: number; content: string }> }>> {
    const { owner, repo } = this.parseRepo(repoSlug)
    const q = encodeURIComponent(`${query} repo:${owner}/${repo}`)
    // The `text-match` preview media type is what makes GitHub return
    // `text_matches[].fragment`. Without it the response carries paths
    // only, which makes the snippets array useless.
    const data = await this.request<{
      items: Array<{
        path: string
        text_matches?: Array<{ fragment?: string }>
      }>
    }>(
      'GET',
      `/search/code?q=${q}&per_page=${Math.min(maxResults, 100)}`,
      undefined,
      { accept: 'application/vnd.github.text-match+json' },
    )

    return (data.items ?? []).slice(0, maxResults).map(item => ({
      path: item.path,
      snippets: (item.text_matches ?? []).map((match, idx) => ({
        seq: idx + 1,
        content: match.fragment ?? '',
      })),
    }))
  }

  private parseRepo(repoSlug: string): { owner: string; repo: string } {
    return parseGitHubRepo(repoSlug, this.owner)
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async request<T = void>(
    method: string,
    path: string,
    body?: unknown,
    opts: { accept?: string } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept ?? 'application/vnd.github+json',
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

interface GhIssue {
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  pull_request?: { url: string }
  created_at: string
  updated_at: string
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

/**
 * Coerce any of these input shapes into an `{ owner, repo }` pair:
 *   - `repo`                              → `defaultOwner`
 *   - `owner/repo`                        → that owner (may differ from config)
 *   - `https://github.com/owner/repo`     → that owner
 *   - `https://github.com/owner/repo.git` → that owner
 *   - `git@github.com:owner/repo.git`     → that owner
 *
 * An explicit owner always wins over the configured one so cross-org
 * repositories address correctly instead of being silently rewritten to
 * the configured org. Exported because clone URLs are built outside this
 * client (the GitHub plugin's `cloneInfo`) and the two must agree — a job
 * working on a fork passes `owner/repo` and would otherwise clone
 * `github.com/<configured-owner>/<owner>/<repo>.git`.
 */
export function parseGitHubRepo(
  repoSlug: string,
  defaultOwner: string,
): { owner: string; repo: string } {
  let s = String(repoSlug ?? '').trim()
  // Strip protocol + host (https://…, git@github.com:).
  s = s.replace(/^https?:\/\/[^/]+\//, '')
  s = s.replace(/^git@[^:]+:/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length >= 2) {
    // First two segments, so trailing path noise on a copied browser URL
    // (…/owner/repo/pull/5) resolves to the repo rather than to `pull/5`.
    return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/, '') }
  }
  return { owner: defaultOwner, repo: (parts[0] ?? '').replace(/\.git$/, '') }
}

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

function normalizeGhIssue(issue: GhIssue): IssueSearchHit {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    isPr: issue.pull_request !== undefined,
    body: issue.body ?? '',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
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
