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
}

export interface RepoInfo {
  full_name: string
  default_branch: string
  clone_url: string
  html_url: string
  fork: boolean
  /** Present on a fork: the repository it was forked from. */
  parent?: { full_name: string }
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

/**
 * Identity returned by {@link GitHubClient.resolveUser}. `nickname` is
 * the login `requested_reviewers` accepts; `uuid` is the GraphQL node id.
 */
export interface GitHubUserRef {
  uuid: string
  account_id?: string
  nickname?: string
  display_name?: string
}

/**
 * Result of {@link GitHubClient.requestReviewers}. Names that matched
 * nobody (or several people) are reported rather than failing the
 * whole request, so one unknown name cannot drop the reviewers that
 * did resolve. `candidates` lists the repository's collaborators as
 * `login (Name)` when something was left unresolved.
 */
export interface ReviewerRequestOutcome {
  requested: string[]
  unresolved: string[]
  candidates?: string[]
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
  /** ETag cache so unchanged polls do not spend the rate limit. */
  private readonly etags = new Map<string, { etag: string; body: unknown }>()

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
   *
   * The `organization` body parameter is the trap here. GitHub accepts it
   * *only* when forking into an organisation, and rejects a personal login
   * outright with `422 Fork organization invalid` — so a target account
   * has to be classified before the request is built, not after. Passing
   * it unconditionally made the documented configuration (`forkOwner` =
   * your own username) fail every time.
   *
   * What comes back from the fork's address is checked rather than trusted,
   * because two things other than the fork can answer there: a same-named
   * repository, and a redirect left behind by a repository that moved out of
   * that account. Adopting either would send contribution branches somewhere
   * they do not belong.
   */
  async ensureFork(
    repoSlug: string,
    forkOwner?: string,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<RepoInfo> {
    const { repo } = this.parseRepo(repoSlug)
    const upstreamSlug = this.repoPath(repoSlug)
    const owner = forkOwner ?? this.owner
    const forkSlug = `${owner}/${repo}`

    let found = await this.forkAt(forkSlug, upstreamSlug)
    if (found.kind === 'fork') return found.repo

    await this.request('POST', `/repos/${upstreamSlug}/forks`, await this.forkTarget(forkOwner))

    const attempts = opts.attempts ?? 10
    const delayMs = opts.delayMs ?? 2000
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(delayMs)
      found = await this.forkAt(forkSlug, upstreamSlug)
      if (found.kind === 'fork') return found.repo
    }

    // A redirect that survived the fork request is a configuration answer,
    // not a slow fork: GitHub will not put a fork at a path that another
    // repository still claims.
    if (found.kind === 'redirect') {
      throw new GitHubError(
        422,
        `${forkSlug} is the former path of ${found.to} and still redirects there, so GitHub ` +
        'will not create a fork at that address. Set `upstream.forkOwner` (Settings → Coro ' +
        'contribution) to an account that does not already claim that path — an organisation ' +
        'you can create repositories in works.',
      )
    }

    throw new GitHubError(
      504,
      `fork ${forkSlug} was requested but did not become available after ${attempts} checks`,
    )
  }

  /**
   * What is at the fork's address: the fork, nothing, or a redirect to the
   * repository that used to live there. A same-named repository that is not
   * a fork of `upstreamSlug` throws instead of being reported, since no
   * amount of waiting will turn it into one.
   */
  private async forkAt(
    forkSlug: string,
    upstreamSlug: string,
  ): Promise<
    | { kind: 'fork'; repo: RepoInfo }
    | { kind: 'absent' }
    | { kind: 'redirect'; to: string }
  > {
    const repo = await this.getRepo(forkSlug).catch(() => null)
    if (!repo) return { kind: 'absent' }

    // `fetch` follows GitHub's permanent redirect, so a response describing
    // some other repository means this address is free.
    if (repo.full_name.toLowerCase() !== forkSlug.toLowerCase()) {
      return { kind: 'redirect', to: repo.full_name }
    }

    assertForkOf(repo, upstreamSlug)
    return { kind: 'fork', repo }
  }

  /**
   * The body for `POST /forks`: `{ organization }` for an org, `{}` for
   * the token's own account.
   *
   * A third case exists and is not a body at all — a personal account that
   * is not the token's. GitHub cannot fork into someone else's account, so
   * omitting `organization` would quietly fork into the token's own
   * account instead, and the caller would then poll for a repository that
   * is never going to appear. Refusing here names the misconfigured
   * setting while the operator can still act on it.
   */
  private async forkTarget(forkOwner?: string): Promise<Record<string, string>> {
    if (!forkOwner) return {}

    const account = await this.request<{ type?: string; login?: string }>(
      'GET',
      `/users/${encodeURIComponent(forkOwner)}`,
    ).catch((err: unknown) => {
      if (err instanceof GitHubError && err.statusCode === 404) {
        throw new GitHubError(
          404,
          `No GitHub user or organisation named "${forkOwner}". Fix \`upstream.forkOwner\` ` +
          '(Settings → Coro contribution) — it is the account Coro forks the upstream ' +
          'repository into, and it must be either your own username or an organisation you ' +
          'can create repositories in.',
        )
      }
      throw err
    })

    if (account.type === 'Organization') return { organization: forkOwner }

    const self = await this.authenticatedLogin()
    if (self && self.toLowerCase() !== forkOwner.toLowerCase()) {
      throw new GitHubError(
        422,
        `\`upstream.forkOwner\` is "${forkOwner}", which is a personal account other than the ` +
        `one this token belongs to ("${self}"). GitHub can only fork into your own account or ` +
        `an organisation you belong to. Set it to "${self}" or to such an organisation ` +
        '(Settings → Coro contribution).',
      )
    }

    // Own account: `organization` must be absent, not empty.
    return {}
  }

  /** Login behind the token, used to validate a fork target. */
  private async authenticatedLogin(): Promise<string | null> {
    const user = await this.request<{ login?: string }>('GET', '/user').catch(() => null)
    return user?.login ?? null
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
    return normalizeGhPr(ghPr)
  }

  /**
   * Ask GitHub to request reviews on an open pull request.
   *
   * `POST /pulls/{n}/requested_reviewers` adds to the current list; it
   * does not replace it, and it only accepts logins of repository
   * collaborators. Each entry may be a login, a numeric account id, a
   * GraphQL node id, or a human name ("Samir Benali", "lee.chun-chen",
   * "Samir Benali (samir-benali_corp)"); names are matched against the
   * repository's collaborators before anything wider.
   *
   * Entries that match nobody, or several people, are returned in
   * `unresolved` and the rest are still requested. Throws only when
   * GitHub refuses the request itself.
   */
  async requestReviewers(
    repoSlug: string,
    prId: number,
    reviewers: ReadonlyArray<string>,
  ): Promise<ReviewerRequestOutcome> {
    const collaborators = await this.listCollaborators(repoSlug)
    const logins: string[] = []
    const seen = new Set<string>()
    const unresolved: string[] = []
    for (const raw of reviewers) {
      const user = await this.resolveUserIn(raw, collaborators, this.parseRepo(repoSlug).owner)
      const login = user?.nickname
      if (!login) {
        unresolved.push(raw)
        continue
      }
      const key = login.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      logins.push(login)
    }
    const outcome: ReviewerRequestOutcome = {
      requested: logins,
      unresolved,
      ...(unresolved.length > 0 && collaborators.length > 0
        ? { candidates: collaborators.slice(0, 50).map(describeUser) }
        : {}),
    }
    if (logins.length === 0) return outcome
    try {
      await this.request(
        'POST',
        `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/requested_reviewers`,
        { reviewers: logins },
      )
    } catch (err) {
      if (err instanceof GitHubError) {
        throw new Error(
          `addReviewers: GitHub refused the reviewer request for ${logins.join(', ')} on PR #${prId}: ${err.message}. ` +
          'Reviewers must be collaborators on the repository and cannot be the pull request author.',
        )
      }
      throw err
    }
    return outcome
  }

  /**
   * Resolve a login, numeric account id, GraphQL node id, or human name
   * to the identity `requestReviewers` can attach. Returns null when
   * nothing matches, or when a name matches several people. Email is
   * not searchable.
   *
   * With `repoSlug`, names are matched against that repository's
   * collaborators first — the only people a review can be requested
   * from. Then the owner's organisation members, then an exact public
   * profile. GitHub's user search does not return Enterprise Managed
   * Users, and its member/collaborator `query` filters are
   * punctuation-sensitive, so matching is done locally on the listed
   * people.
   */
  async resolveUser(input: string, opts: { repoSlug?: string } = {}): Promise<GitHubUserRef | null> {
    const collaborators = opts.repoSlug ? await this.listCollaborators(opts.repoSlug) : []
    const org = opts.repoSlug ? this.parseRepo(opts.repoSlug).owner : this.owner
    return this.resolveUserIn(input, collaborators, org)
  }

  private async resolveUserIn(
    input: string,
    collaborators: ReadonlyArray<GitHubUserRef>,
    org: string,
  ): Promise<GitHubUserRef | null> {
    const q = input.trim().replace(/^@/, '')
    if (!q) return null

    // "Samir Benali (samir-benali_corp)" — the form GitHub's UI shows.
    const shown = /\(\s*@?([^()\s]+)\s*\)\s*$/.exec(q)
    if (shown) {
      const byLogin = await this.resolveUserIn(shown[1]!, collaborators, org)
      if (byLogin) return byLogin
    }

    if (collaborators.length > 0) {
      const match = matchUser(q, collaborators, true)
      if (match === 'ambiguous') return null
      if (match) return match
    }

    if (isGitHubNodeId(q)) {
      const node = await this.lookupNode(q)
      if (node) return node
    }
    if (/^\d+$/.test(q)) return this.lookupByAccountId(q)

    if (isGitHubLogin(q)) {
      const direct = await this.lookupByLogin(q)
      if (direct) return direct
    }
    return this.searchByName(q, org)
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

  async whoami(): Promise<{ login: string; id?: string; name?: string }> {
    const user = await this.request<{ login: string; id?: number; name?: string }>('GET', '/user')
    return { login: user.login, ...(user.id !== undefined ? { id: String(user.id) } : {}), ...(user.name ? { name: user.name } : {}) }
  }

  async listReviewRequests(includeTeams: boolean): Promise<Array<{
    repo: string
    number: number
    title: string
    author: string
    url: string
    updatedAt: string
    draft?: boolean
  }>> {
    const qualifier = includeTeams ? 'review-requested:@me' : 'user-review-requested:@me'
    const q = `is:pr is:open archived:false ${qualifier}`
    const data = await this.requestCached<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      `/search/issues?q=${encodeURIComponent(q)}&per_page=50`,
    )
    return (data?.items ?? []).map(item => {
      const repoUrl = String(item['repository_url'] ?? '')
      const repo = repoUrl.split('/repos/')[1] ?? ''
      const user = item['user'] as { login?: string } | undefined
      return {
        repo,
        number: Number(item['number']),
        title: String(item['title'] ?? ''),
        author: user?.login ?? '',
        url: String(item['html_url'] ?? ''),
        updatedAt: String(item['updated_at'] ?? ''),
        draft: item['draft'] === true,
      }
    }).filter(item => item.repo && Number.isFinite(item.number))
  }

  async getPrDetails(repoSlug: string, prId: number): Promise<{
    author: string
    title: string
    draft: boolean
    state: string
    baseSha: string
    headSha: string
    requestedReviewers: string[]
    labels: string[]
    url?: string
    files: { path: string; additions: number; deletions: number; status?: string }[]
  }> {
    const repo = this.repoPath(repoSlug)
    const pr = await this.request<GhPullRequest & {
      draft?: boolean
      user?: { login?: string }
      base?: { sha?: string }
      head?: { sha?: string }
      requested_reviewers?: Array<{ login?: string }>
      labels?: Array<{ name?: string }>
      html_url?: string
    }>('GET', `/repos/${repo}/pulls/${prId}`)
    const files = await this.request<Array<{ filename: string; additions?: number; deletions?: number; status?: string }>>(
      'GET',
      `/repos/${repo}/pulls/${prId}/files?per_page=100`,
    )
    return {
      author: pr.user?.login ?? '',
      title: pr.title,
      draft: pr.draft === true,
      state: pr.merged ? 'MERGED' : pr.state,
      baseSha: pr.base?.sha ?? '',
      headSha: pr.head?.sha ?? '',
      requestedReviewers: (pr.requested_reviewers ?? []).map(r => r.login ?? '').filter(Boolean),
      labels: (pr.labels ?? []).map(l => l.name ?? '').filter(Boolean),
      ...(pr.html_url ? { url: pr.html_url } : {}),
      files: (files ?? []).map(file => ({
        path: file.filename,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        ...(file.status ? { status: file.status } : {}),
      })),
    }
  }

  async getPrFiles(repoSlug: string, prId: number): Promise<Array<{ path: string; patch?: string; additions: number; deletions: number; status?: string }>> {
    const files = await this.request<Array<{ filename: string; patch?: string; additions?: number; deletions?: number; status?: string }>>(
      'GET',
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/files?per_page=100`,
    )
    return (files ?? []).map(file => ({
      path: file.filename,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      ...(file.patch ? { patch: file.patch } : {}),
      ...(file.status ? { status: file.status } : {}),
    }))
  }

  async submitReview(repoSlug: string, prId: number, review: {
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | 'PENDING'
    body: string
    commitId?: string
    comments: Array<{ path: string; line: number; side?: string; start_line?: number; body: string }>
  }): Promise<{ id: number }> {
    const payload: Record<string, unknown> = {
      body: review.body,
      comments: review.comments.map(comment => ({
        path: comment.path,
        line: comment.line,
        side: comment.side ?? 'RIGHT',
        body: comment.body,
        ...(comment.start_line ? { start_line: comment.start_line } : {}),
      })),
    }
    if (review.commitId) payload['commit_id'] = review.commitId
    if (review.event !== 'PENDING') payload['event'] = review.event
    const created = await this.request<{ id: number }>(
      'POST',
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/reviews`,
      payload,
    )
    return created
  }

  /** The inline comments of one review. Creating a review does not return their ids. */
  async listReviewComments(repoSlug: string, prId: number, reviewId: number): Promise<Array<{ id: number; path: string; line: number | null }>> {
    const rows = await this.request<Array<{ id: number; path: string; line?: number | null; original_line?: number | null }>>(
      'GET',
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/reviews/${reviewId}/comments?per_page=100`,
    )
    return rows.map(row => ({ id: row.id, path: row.path, line: row.line ?? row.original_line ?? null }))
  }

  async submitPendingReview(repoSlug: string, prId: number, reviewId: number, event: string, body?: string): Promise<void> {
    await this.request(
      'POST',
      `/repos/${this.repoPath(repoSlug)}/pulls/${prId}/reviews/${reviewId}/events`,
      { event, ...(body ? { body } : {}) },
    )
  }

  async listReviewThreads(repoSlug: string, prId: number): Promise<Array<{
    id: string
    path?: string
    line?: number
    resolved: boolean
    outdated: boolean
    comments: { id: string; body: string; author?: string; createdAt: string }[]
  }>> {
    const { owner, repo } = parseGitHubRepo(repoSlug, this.owner)
    const data = await this.graphql<{
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{
              id: string
              isResolved: boolean
              isOutdated: boolean
              path?: string
              line?: number
              comments?: { nodes?: Array<{ databaseId?: number; body: string; author?: { login?: string }; createdAt: string }> }
            }>
          }
        }
      }
    }>(`query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { id isResolved isOutdated path line comments(first: 50) { nodes { databaseId body author { login } createdAt } } }
          }
        }
      }
    }`, { owner, repo, number: prId })
    const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? []
    return nodes.map(node => ({
      id: node.id,
      ...(node.path ? { path: node.path } : {}),
      ...(node.line !== undefined ? { line: node.line } : {}),
      resolved: node.isResolved,
      outdated: node.isOutdated,
      comments: (node.comments?.nodes ?? []).map(comment => ({
        id: String(comment.databaseId ?? ''),
        body: comment.body,
        ...(comment.author?.login ? { author: comment.author.login } : {}),
        createdAt: comment.createdAt,
      })),
    }))
  }

  async resolveThread(threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved
      ? `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`
      : `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }`
    await this.graphql(mutation, { id: threadId })
  }

  /**
   * GET that returns the cached body on 304. Callers that need a fresh
   * miss should treat a returned `undefined` body as "unchanged" only
   * when they already hold the previous value; the first call always hits.
   */
  private async requestCached<T>(method: string, path: string): Promise<T | undefined> {
    const url = `${this.baseUrl}${path}`
    const cached = this.etags.get(url)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    const res = await fetch(url, { method, headers })
    if (res.status === 304 && cached) return cached.body as T
    if (!res.ok) {
      throw new GitHubError(res.status, await res.text())
    }
    const body = await res.json() as T
    const etag = res.headers.get('etag')
    if (etag) this.etags.set(url, { etag, body })
    return body
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

  async updateIssueComment(repoSlug: string, commentId: number, content: string): Promise<PrComment> {
    const c = await this.request<GhIssueComment>(
      'PATCH',
      `/repos/${this.repoPath(repoSlug)}/issues/comments/${commentId}`,
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

  private async lookupByLogin(login: string): Promise<GitHubUserRef | null> {
    try {
      const user = await this.request<GhUser>('GET', `/users/${encodeURIComponent(login)}`)
      if (user.type === 'Organization') return null
      return toUserRef(user)
    } catch (err) {
      if (err instanceof GitHubError && err.statusCode === 404) return null
      throw err
    }
  }

  private async lookupByAccountId(id: string): Promise<GitHubUserRef | null> {
    try {
      const user = await this.request<GhUser>('GET', `/user/${encodeURIComponent(id)}`)
      if (user.type === 'Organization') return null
      return toUserRef(user)
    } catch (err) {
      if (err instanceof GitHubError && err.statusCode === 404) return null
      throw err
    }
  }

  private async lookupNode(id: string): Promise<GitHubUserRef | null> {
    try {
      const data = await this.graphql<{
        node?: { login?: string; name?: string | null; id?: string; databaseId?: number } | null
      }>(
        'query($id:ID!){ node(id:$id){ ... on User { login name id databaseId } } }',
        { id },
      )
      const node = data.node
      if (!node?.login || !node.id) return null
      return {
        uuid: node.id,
        nickname: node.login,
        ...(node.databaseId != null ? { account_id: String(node.databaseId) } : {}),
        ...(node.name ? { display_name: node.name } : {}),
      }
    } catch {
      return null
    }
  }

  /**
   * Everyone who can be requested as a reviewer on `repoSlug`. Empty
   * when the token cannot list collaborators (it needs push access);
   * callers then widen to organisation members.
   */
  private async listCollaborators(repoSlug: string): Promise<GitHubUserRef[]> {
    const { owner, repo } = this.parseRepo(repoSlug)
    return this.listUserConnection(
      'query($owner:String!,$name:String!,$after:String){ repository(owner:$owner,name:$name){ collaborators(first:100, after:$after){ pageInfo { hasNextPage endCursor } nodes { login name id databaseId } } } }',
      { owner, name: repo },
      data => (data as { repository?: { collaborators?: UserConnection } | null }).repository?.collaborators,
    )
  }

  /** Organisation members; empty when the token cannot read the membership. */
  private async listOrgMembers(org: string): Promise<GitHubUserRef[]> {
    return this.listUserConnection(
      'query($org:String!,$after:String){ organization(login:$org){ membersWithRole(first:100, after:$after){ pageInfo { hasNextPage endCursor } nodes { login name id databaseId } } } }',
      { org },
      data => (data as { organization?: { membersWithRole?: UserConnection } | null }).organization?.membersWithRole,
    )
  }

  private async listUserConnection(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: unknown) => UserConnection | undefined,
  ): Promise<GitHubUserRef[]> {
    const users: GitHubUserRef[] = []
    let after: string | null = null
    try {
      for (let page = 0; page < MAX_USER_PAGES; page++) {
        const conn = pick(await this.graphql<unknown>(query, { ...variables, after }))
        for (const n of conn?.nodes ?? []) {
          if (!n?.login) continue
          users.push({
            uuid: n.id,
            nickname: n.login,
            account_id: String(n.databaseId),
            ...(n.name ? { display_name: n.name } : {}),
          })
        }
        if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break
        after = conn.pageInfo.endCursor
      }
    } catch {
      // Permission and transport failures both mean "no list from here".
    }
    return users
  }

  private async searchByName(query: string, org: string): Promise<GitHubUserRef | null> {
    const fromOrg = matchUser(query, await this.listOrgMembers(org), true)
    if (fromOrg === 'ambiguous') return null
    if (fromOrg) return fromOrg

    const listed = matchUser(query, await this.searchUsers(`${query} org:${org} in:login,name,fullname`), true)
    if (listed === 'ambiguous') return null
    if (listed) return listed

    // A public search is wider, not safer: only an exact login or name counts.
    const pub = matchUser(query, await this.searchUsers(`${query} in:login,name,fullname`), false)
    return pub === 'ambiguous' ? null : pub
  }

  private async searchUsers(q: string): Promise<GitHubUserRef[]> {
    try {
      const data = await this.request<{ items?: Array<{ login: string }> }>(
        'GET',
        `/search/users?q=${encodeURIComponent(q)}&per_page=5`,
      )
      const logins = (data.items ?? []).map(item => item.login).filter(Boolean)
      const profiles = await Promise.all(logins.map(login => this.lookupByLogin(login)))
      return profiles.filter((p): p is GitHubUserRef => p !== null)
    } catch (err) {
      if (err instanceof GitHubError && (err.statusCode === 403 || err.statusCode === 422)) return []
      throw err
    }
  }

  private graphqlUrl(): string {
    const base = this.baseUrl.replace(/\/$/, '')
    if (/^https:\/\/api\.github\.com$/i.test(base)) return `${base}/graphql`
    // GitHub Enterprise serves REST at {host}/api/v3 and GraphQL at {host}/api/graphql.
    return `${base.replace(/\/api\/v3$/i, '')}/api/graphql`
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.graphqlUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) {
      throw new GitHubError(res.status, await res.text())
    }
    const payload = await res.json() as { data?: T; errors?: Array<{ message: string }> }
    if (payload.errors?.length && payload.data == null) {
      throw new GitHubError(422, payload.errors.map(e => e.message).join('; '))
    }
    return (payload.data ?? {}) as T
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

interface GhUser {
  login: string
  id: number
  node_id: string
  name?: string | null
  type?: string
}

/** A GraphQL `UserConnection` page as selected by the member/collaborator listings. */
interface UserConnection {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null }
  nodes?: Array<{ login: string; name: string | null; id: string; databaseId: number } | null>
}

/** Caps member/collaborator listing at 1,000 people (10 GraphQL pages). */
const MAX_USER_PAGES = 10

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

/**
 * Refuse a repository that merely shares the fork's name.
 *
 * `ensureFork` treats whatever is at `<forkOwner>/<repo>` as the fork, which
 * is right for a real fork and dangerous otherwise: contribution branches get
 * pushed into it, and GitHub then rejects a pull request whose head is
 * outside the upstream's fork network. Both failures read as unrelated
 * errors, so the mismatch is named here instead.
 */
function assertForkOf(repo: RepoInfo, upstreamSlug: string): void {
  const parent = repo.parent?.full_name
  if (repo.fork && (!parent || parent.toLowerCase() === upstreamSlug.toLowerCase())) return

  throw new GitHubError(
    422,
    `${repo.html_url} already exists and is not a fork of ${upstreamSlug}` +
    `${parent ? ` (it is a fork of ${parent})` : ''}, so Coro would be pushing contribution ` +
    'branches into it. Rename that repository, or set `upstream.forkOwner` (Settings → Coro ' +
    'contribution) to an account that does not hold one — an organisation you can create ' +
    'repositories in works.',
  )
}

function toUserRef(user: GhUser): GitHubUserRef {
  return {
    uuid: user.node_id,
    account_id: String(user.id),
    nickname: user.login,
    ...(user.name ? { display_name: user.name } : {}),
  }
}

function describeUser(user: GitHubUserRef): string {
  return user.display_name ? `${user.nickname} (${user.display_name})` : user.nickname ?? user.uuid
}

/**
 * GitHub logins are alphanumeric plus single interior hyphens, max 39.
 * Enterprise Managed Users append `_<shortcode>` (`samir-benali_corp`).
 */
function isGitHubLogin(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}(?:_[a-zA-Z0-9]+)?$/.test(value)
}

/**
 * Legacy node ids are base64 (`=` / `+` / `/`, `MDQ6…` for users); the
 * newer global ids are an uppercase type prefix and `_` (`U_kgDO…`).
 * The latter can collide with an EMU login, so a miss falls through
 * to the login lookup.
 */
function isGitHubNodeId(value: string): boolean {
  return /[=+/]/.test(value) || value.startsWith('MDQ6') || /^[A-Z]{1,4}_[A-Za-z0-9_-]{4,}$/.test(value)
}

/** `samir-benali_corp` → `samir-benali`: the handle without the EMU shortcode. */
function loginHandle(login: string): string {
  return login.replace(/_[a-zA-Z0-9]+$/, '')
}

/** Case-, punctuation- and parenthetical-insensitive word list: "Lee Chun-Chen (x)" → ["lee", "chun", "chen"]. */
function nameTokens(value: string): string[] {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * Pick the person a query names, from strictest to loosest: exact
 * login, the same words as the name or login handle, the same words in
 * any order, and — when `allowPartial` — every query word appearing in
 * one person's name ("samir" → "Samir Benali"). The first rule that
 * matches anyone decides: one match wins, several are `'ambiguous'`, so
 * a looser rule never overrides a stricter one.
 *
 * `allowPartial` is for lists already scoped to the repository or
 * organisation. A public search only accepts the exact rules, so a
 * common name cannot attach a stranger.
 */
function matchUser(
  query: string,
  users: ReadonlyArray<GitHubUserRef>,
  allowPartial: boolean,
): GitHubUserRef | 'ambiguous' | null {
  const lower = query.toLowerCase()
  const q = nameTokens(query)
  if (q.length === 0) return null
  const phrase = q.join(' ')
  const sorted = [...q].sort().join(' ')

  const candidates = users.map(u => {
    const login = u.nickname ?? ''
    const forms = [nameTokens(u.display_name ?? ''), nameTokens(loginHandle(login))].filter(t => t.length > 0)
    return { user: u, login: login.toLowerCase(), handle: loginHandle(login).toLowerCase(), forms }
  })

  const rules: Array<(c: typeof candidates[number]) => boolean> = [
    c => c.login === lower || c.handle === lower,
    c => c.forms.some(t => t.join(' ') === phrase),
    c => c.forms.some(t => [...t].sort().join(' ') === sorted),
  ]
  if (allowPartial) {
    rules.push(c => c.forms.some(t => q.every(word => t.includes(word))))
  }

  for (const rule of rules) {
    const hits = candidates.filter(rule)
    if (hits.length === 1) return hits[0]!.user
    if (hits.length > 1) return 'ambiguous'
  }
  return null
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
