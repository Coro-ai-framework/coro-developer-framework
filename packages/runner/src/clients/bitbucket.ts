import { Settings } from '../config/settings'

// ── Errors ────────────────────────────────────────────────────────────────────

export class BitBucketError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`BitBucket ${statusCode}: ${message}`)
    this.name = 'BitBucketError'
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateRepoOptions {
  repoSlug: string
  isPrivate?: boolean
  description?: string
  mainBranch?: string
}

export interface CreatePrOptions {
  repoSlug: string
  title: string
  description?: string
  sourceBranch: string
  targetBranch?: string  // defaults to 'main'
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
  /**
   * Bitbucket Cloud embeds reviewer/approval state directly on the PR
   * object — there is NO `/pullrequests/{id}/participants` endpoint
   * (returns 404 "no API hosted at this URL"). Approvals are derived
   * by counting `participants[].approved === true`.
   */
  participants?: { approved: boolean; role?: string; user?: { display_name?: string } }[]
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * Map a free-form reviewer identifier to the right Bitbucket Cloud
 * reviewer-object field. Bitbucket rejects mixed/wrong fields with
 * `400 Malformed reviewers list` — we have to pick the correct field
 * per identifier shape:
 *
 *   - `{...}` UUID or bare hex UUID (8-4-4-4-12)         → `uuid`
 *   - Modern account_id (`557058:...`)                   → `account_id`
 *   - Legacy 24-hex Atlassian account_id                 → `account_id`
 *   - Anything else (treated as nickname / username)     → `username`
 *
 * The `username` branch is the legacy field; some workspaces have
 * disabled it. Callers should prefer uuid or account_id when they
 * have it.
 */
export function bbReviewerEntry(value: string): { uuid: string } | { account_id: string } | { username: string } {
  const v = value.trim()
  // {uuid} braced form
  if (/^\{[0-9a-f-]{32,}\}$/i.test(v)) return { uuid: v }
  // bare hyphenated UUID -> brace it for Bitbucket
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return { uuid: `{${v}}` }
  // modern account_id ("557058:...") — colon is the marker
  if (/^[0-9]+:[0-9a-f-]+$/i.test(v)) return { account_id: v }
  // legacy 24-hex account_id
  if (/^[0-9a-f]{24}$/i.test(v)) return { account_id: v }
  return { username: v }
}

/**
 * Rich workspace-member identity record. `uuid` is the only field
 * guaranteed to be present (it's what reviewers/PR APIs need);
 * everything else is best-effort from the Bitbucket members endpoint.
 */
export interface BitBucketUserRef {
  uuid: string
  account_id?: string
  nickname?: string
  display_name?: string
}

export class BitBucketClient {
  private readonly authHeader: string
  private readonly baseUrl: string
  /** Lowercased nickname / display_name / account_id / uuid → uuid. */
  private readonly memberIndex = new Map<string, string>()
  /** uuid → full member record (for richer lookups via resolveUser). */
  private readonly memberRecords = new Map<string, BitBucketUserRef>()
  private memberIndexLoaded = false

  constructor(
    private readonly workspace: string,
    username: string,
    appPassword: string,
    baseUrl = 'https://api.bitbucket.org/2.0',
  ) {
    // Bitbucket auth (Basic auth in all cases — Bearer is rejected even
    // for ATATT tokens):
    //   - Legacy App Passwords          -> username = Atlassian email
    //   - Legacy Repo Access Tokens     -> username = `x-token-auth`
    //   - Atlassian API tokens (ATATT…) -> username = Atlassian email
    //   - Bitbucket-scoped API tokens   -> username = `x-bitbucket-api-token-auth`
    //     (also start with `ATATT…` — the prefix cannot disambiguate them)
    //
    // We trust the configured `username` rather than auto-detecting from
    // the token prefix: an earlier auto-map of every `ATATT…` token to
    // `x-bitbucket-api-token-auth` broke plain Atlassian API tokens (which
    // need the email) and produced opaque 401s on every REST call.
    this.authHeader = `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  // ── Repositories ────────────────────────────────────────────────────────────

  async createRepo(opts: CreateRepoOptions): Promise<{ full_name: string; links: { clone: { href: string; name: string }[] } }> {
    return this.request('POST', `/repositories/${this.workspace}/${opts.repoSlug}`, {
      scm: 'git',
      is_private: opts.isPrivate ?? true,
      description: opts.description ?? '',
      mainbranch: { name: opts.mainBranch ?? 'main' },
    })
  }

  async getFile(repoSlug: string, filePath: string, revision = 'HEAD'): Promise<string> {
    return this.requestText('GET', `/repositories/${this.workspace}/${repoSlug}/src/${revision}/${filePath}`)
  }

  /**
   * List entries in a repository directory. Pass an empty `dirPath`
   * (or '/') for the repository root. `revision` accepts a branch
   * name, tag, or commit hash; Bitbucket also accepts `HEAD` as an
   * alias for the default branch.
   *
   * Honours Bitbucket's `next` cursor up to `maxEntries`. We don't
   * paginate forever — plan mode just wants enough breadth to find
   * the right subdir, not a full tree.
   */
  async listFiles(
    repoSlug: string,
    dirPath: string,
    revision = 'HEAD',
    maxEntries = 200,
  ): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
    // Bitbucket's API treats a trailing slash as "list this directory"
    // and a bare commit ref as "list root". Normalise both shapes so
    // callers can pass `''`, `/`, or `src/foo` interchangeably.
    const trimmedPath = dirPath.replace(/^\/+|\/+$/g, '')
    const out: Array<{ path: string; type: 'file' | 'dir' }> = []
    let url: string | null = trimmedPath
      ? `/repositories/${this.workspace}/${repoSlug}/src/${revision}/${trimmedPath}/`
      : `/repositories/${this.workspace}/${repoSlug}/src/${revision}/`

    while (url && out.length < maxEntries) {
      const data: {
        values: Array<{ path: string; type: string }>
        next?: string
      } = await this.request('GET', url)
      for (const v of data.values) {
        if (out.length >= maxEntries) break
        out.push({
          path: v.path,
          // Bitbucket types are `commit_file` and `commit_directory`.
          // Anything else (commit_link, …) is rare and gets treated as
          // a file so the agent at least sees it.
          type: v.type === 'commit_directory' ? 'dir' : 'file',
        })
      }
      // `next` is an absolute URL — strip the `baseUrl` prefix so the
      // shared `request` helper keeps signing it.
      if (data.next) {
        url = data.next.startsWith(this.baseUrl) ? data.next.slice(this.baseUrl.length) : data.next
      } else {
        url = null
      }
    }
    return out
  }

  /**
   * Workspace-scoped code search. Bitbucket's response shape is
   * non-obvious — content matches come back as `content_matches[].lines[]`
   * where each line is `{ line, segments[] }` and each segment is
   * `{ text, match? }`. We assemble the segments into a full line of
   * source so the LLM sees the actual hit context, not an empty
   * string (which the previous implementation produced because it
   * mistyped `lines` as a single `{ text }` object).
   *
   * Path-only matches (`path_matches` with no `content_matches`) are
   * also a thing — Bitbucket explicitly documents both. We surface
   * those as a hit with `pathMatchOnly: true` so the agent can act
   * on filename matches (e.g. searching for "Buyinbuyout.csproj").
   *
   * Caveat: Bitbucket Cloud's code-search index doesn't cover every
   * workspace. Free-plan / unindexed workspaces routinely return
   * `200 { values: [] }` even when the same query works in the web
   * UI. The plan-mode prompt steers the agent toward `listFiles` in
   * that case rather than retrying search.
   */
  async searchCode(
    repoSlug: string,
    query: string,
    maxResults = 20,
  ): Promise<Array<{ path: string; snippets: Array<{ seq: number; content: string }>; pathMatchOnly?: boolean }>> {
    const params = new URLSearchParams({
      search_query: `repo:${this.workspace}/${repoSlug} ${query}`,
      pagelen: String(Math.min(maxResults, 20)),
    })
    const data = await this.request<{
      values: Array<{
        file?: { path?: string }
        content_matches?: Array<{
          lines?: Array<{
            line?: number
            segments?: Array<{ text?: string; match?: boolean }>
          }>
        }>
        path_matches?: Array<{ text?: string; match?: boolean }>
      }>
    }>('GET', `/workspaces/${this.workspace}/search/code?${params.toString()}`)

    return (data.values ?? []).slice(0, maxResults).map(item => {
      const contentMatches = item.content_matches ?? []
      const snippets: Array<{ seq: number; content: string }> = []
      let seq = 1
      for (const match of contentMatches) {
        for (const line of match.lines ?? []) {
          const text = (line.segments ?? []).map(s => s.text ?? '').join('')
          // Skip the empty padding lines Bitbucket includes between
          // match windows (`{ line, segments: [] }`) — they're just
          // noise and waste tokens.
          if (!text.trim()) continue
          const prefix = typeof line.line === 'number' ? `L${line.line}: ` : ''
          snippets.push({ seq: seq++, content: `${prefix}${text}` })
        }
      }
      const pathMatchOnly = snippets.length === 0 && (item.path_matches ?? []).some(p => p.match === true)
      return {
        path: item.file?.path ?? 'unknown',
        snippets,
        ...(pathMatchOnly ? { pathMatchOnly: true } : {}),
      }
    })
  }

  // ── Pull requests ────────────────────────────────────────────────────────────

  async createPr(opts: CreatePrOptions): Promise<PullRequest> {
    const body = {
      title: opts.title,
      description: opts.description ?? '',
      source: { branch: { name: opts.sourceBranch } },
      destination: { branch: { name: opts.targetBranch ?? 'main' } },
      close_source_branch: true,
    }

    // Try with reviewers first. The new BitBucket API requires account_id or uuid,
    // not username — if reviewers cause a 400, fall back to creating without them.
    if (opts.reviewerUsernames && opts.reviewerUsernames.length > 0) {
      try {
        // Resolve nicknames/display-names to UUIDs first; Bitbucket
        // Cloud rejects `{ username: ... }` for most workspaces.
        const resolvedIds: string[] = []
        for (const u of opts.reviewerUsernames) {
          try { resolvedIds.push(await this.resolveReviewerIdentifier(u)) } catch { /* skip unresolved */ }
        }
        if (resolvedIds.length > 0) {
          const reviewers = resolvedIds.map(u => bbReviewerEntry(u))
          return await this.request('POST', `/repositories/${this.workspace}/${opts.repoSlug}/pullrequests`, {
            ...body,
            reviewers,
          })
        }
      } catch (err) {
        if (err instanceof BitBucketError && err.statusCode === 400) {
          // Reviewer format rejected — create PR without reviewers
        } else {
          throw err
        }
      }
    }

    return this.request('POST', `/repositories/${this.workspace}/${opts.repoSlug}/pullrequests`, body)
  }

  async getPr(repoSlug: string, prId: number): Promise<PullRequest> {
    return this.request('GET', `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}`)
  }

  async listPrs(repoSlug: string, state: 'OPEN' | 'MERGED' | 'DECLINED' = 'OPEN'): Promise<PullRequest[]> {
    return this.listAll<PullRequest>(`/repositories/${this.workspace}/${repoSlug}/pullrequests?state=${state}`)
  }

  async approvePr(repoSlug: string, prId: number): Promise<void> {
    await this.request('POST', `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/approve`)
  }

  /**
   * Set the reviewer list on an open PR. Bitbucket Cloud's PUT
   * /pullrequests/{id} replaces the reviewers array — pass the merged
   * list (existing + additions) to avoid dropping reviewers added by
   * the original author. Inputs may be UUIDs, account_ids, nicknames
   * or display names — `resolveReviewerIdentifier` normalises each to
   * a UUID before we build the payload (Bitbucket removed the legacy
   * `username` reviewer field for most workspaces, so passing a
   * nickname directly yields `400 Malformed reviewers list`).
   */
  async updatePrReviewers(repoSlug: string, prId: number, reviewers: ReadonlyArray<string>): Promise<void> {
    const resolved: string[] = []
    const errors: string[] = []
    for (const raw of reviewers) {
      try {
        resolved.push(await this.resolveReviewerIdentifier(raw))
      } catch (err) {
        errors.push(`"${raw}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `addReviewers: could not resolve ${errors.length} of ${reviewers.length} reviewer(s) to Bitbucket accounts. ` +
        `Details: ${errors.join('; ')}. ` +
        `Tip: pass the Bitbucket UUID (e.g. {12345678-...}) or account_id (e.g. 557058:...) ` +
        `directly, or use a nickname / display_name that matches a workspace member.`,
      )
    }
    await this.request('PUT', `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}`, {
      reviewers: resolved.map(r => bbReviewerEntry(r)),
    })
  }

  async mergePr(repoSlug: string, prId: number, message?: string): Promise<PullRequest> {
    return this.request('POST', `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/merge`, {
      type: 'commit',
      message: message ?? 'Merged via A5 Agent',
      close_source_branch: true,
      merge_strategy: 'merge_commit',
    })
  }

  async getPrStatus(repoSlug: string, prId: number): Promise<{ state: string; approvalCount: number }> {
    // Bitbucket Cloud embeds participant/approval data on the PR
    // resource itself; there is no `/participants` sub-resource (it
    // 404s with "no API hosted at this URL"). One GET is enough.
    const pr = await this.getPr(repoSlug, prId)
    const approvalCount = (pr.participants ?? []).filter(p => p.approved).length
    return { state: pr.state, approvalCount }
  }

  // ── Comments ────────────────────────────────────────────────────────────────

  async getComments(repoSlug: string, prId: number): Promise<PrComment[]> {
    return this.listAll<PrComment>(`/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`)
  }

  async postComment(repoSlug: string, prId: number, content: string): Promise<PrComment> {
    return this.request('POST', `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`, {
      content: { raw: content },
    })
  }

  async replyToComment(repoSlug: string, prId: number, parentId: number, content: string): Promise<PrComment> {
    return this.request('POST', `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`, {
      content: { raw: content },
      parent: { id: parentId },
    })
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async request<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    let lastError: BitBucketError | undefined

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
        if (res.status === 204 || res.headers.get('content-length') === '0') {
          return undefined as T
        }
        return res.json() as Promise<T>
      }

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text()
        lastError = new BitBucketError(res.status, text)
        continue
      }

      const text = await res.text()
      // Bitbucket often returns an empty body for 401 — surface the status
      // text + WWW-Authenticate header so the operator can tell *why* the
      // token was rejected (missing scope vs. expired vs. wrong username).
      const detail = text && text.trim().length > 0
        ? text
        : `${res.statusText || 'Unauthorized'} (www-authenticate: ${res.headers.get('www-authenticate') ?? 'n/a'})`
      throw new BitBucketError(res.status, detail)
    }

    throw lastError!
  }

  private async requestText(method: string, path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.authHeader },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new BitBucketError(res.status, text)
    }
    return res.text()
  }

  /** Follow BitBucket's paginated responses, collecting all values. */
  private async listAll<T>(initialPath: string): Promise<T[]> {
    const results: T[] = []
    let url: string | undefined = `${this.baseUrl}${initialPath}`

    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      })
      if (!res.ok) {
        const text = await res.text()
        throw new BitBucketError(res.status, text)
      }
      const page = await res.json() as { values: T[]; next?: string }
      results.push(...page.values)
      url = page.next
    }

    return results
  }

  // ── Reviewer resolution ─────────────────────────────────────────────────────

  /**
   * Normalise a reviewer identifier to something Bitbucket Cloud's
   * reviewers API actually accepts (uuid or account_id). Bitbucket
   * removed the legacy `username` field for most workspaces, so a
   * nickname like `samir.benali` would otherwise produce
   * `400 Malformed reviewers list`.
   *
   * Pass-through cases (no API call):
   *   - braced uuid `{...}`
   *   - bare hyphenated uuid (gets braced by `bbReviewerEntry`)
   *   - modern account_id (`557058:...`)
   *   - legacy 24-hex account_id
   *
   * Otherwise we treat the input as a nickname / display_name and
   * resolve it against the workspace members directory. Results are
   * cached per client instance.
   */
  async resolveReviewerIdentifier(input: string): Promise<string> {
    const v = input.trim()
    if (!v) throw new Error('reviewer identifier is empty')
    // Already a uuid or account_id → no lookup needed.
    if (/^\{[0-9a-f-]{32,}\}$/i.test(v)) return v
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v
    if (/^[0-9]+:[0-9a-f-]+$/i.test(v)) return v
    if (/^[0-9a-f]{24}$/i.test(v)) return v

    const key = v.toLowerCase()
    const cached = this.memberIndex.get(key)
    if (cached) return cached

    if (!this.memberIndexLoaded) {
      await this.loadWorkspaceMembers()
    }
    const resolved = this.memberIndex.get(key)
    if (!resolved) {
      throw new Error(
        `no Bitbucket workspace member matches "${input}" by nickname or display_name. ` +
        `Pass the user's UUID ({...}) or account_id instead.`,
      )
    }
    return resolved
  }

  /**
   * Look up a workspace member by free-form query and return a rich
   * identity record. Accepts:
   *   - braced uuid `{...}` or bare hyphenated uuid (pass-through; we
   *     opportunistically enrich from the member directory).
   *   - modern account_id (`557058:...`) or legacy 24-hex account_id
   *     (pass-through; enriched if known).
   *   - nickname or display_name (case-insensitive lookup against the
   *     workspace member directory).
   *
   * Email is NOT searchable here — Bitbucket's members endpoint does
   * not expose emails. To resolve by email, look up the user in your
   * tracker (Jira, Linear, GitHub) first; the Atlassian `accountId`
   * returned by Jira is identical to the Bitbucket `account_id` and
   * can be passed straight through this method.
   *
   * Returns `null` when nothing matches (instead of throwing) so the
   * MCP tool can surface a clean "no match" result.
   */
  async resolveUser(input: string): Promise<BitBucketUserRef | null> {
    const v = input.trim()
    if (!v) return null

    // Pass-through cases — normalise to a canonical uuid (braced)
    // when possible, then try to enrich from the loaded directory.
    let uuid: string | undefined
    let accountId: string | undefined
    if (/^\{[0-9a-f-]{32,}\}$/i.test(v)) {
      uuid = v
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      uuid = `{${v}}`
    } else if (/^[0-9]+:[0-9a-f-]+$/i.test(v) || /^[0-9a-f]{24}$/i.test(v)) {
      accountId = v
    }

    if (!this.memberIndexLoaded) {
      await this.loadWorkspaceMembers().catch(() => { /* swallow; fall through */ })
    }

    if (uuid) {
      const rec = this.memberRecords.get(uuid)
      return rec ?? { uuid }
    }
    if (accountId) {
      for (const rec of this.memberRecords.values()) {
        if (rec.account_id?.toLowerCase() === accountId.toLowerCase()) return rec
      }
      // Pass-through: the caller can still feed this to scm_add_pr_reviewers
      // — bbReviewerEntry maps it to the right field. We cannot synthesise
      // a uuid, so leave uuid empty by reporting account_id only via a stub.
      return { uuid: '', account_id: accountId }
    }

    // Name / nickname / display_name lookup.
    const matchedUuid = this.memberIndex.get(v.toLowerCase())
    if (matchedUuid) {
      const rec = this.memberRecords.get(matchedUuid)
      return rec ?? { uuid: matchedUuid }
    }
    return null
  }

  /**
   * Page through `/workspaces/{workspace}/members` (and members'
   * embedded user objects), building a case-insensitive lookup by
   * nickname, display_name, and account_id → uuid. Called lazily the
   * first time a non-UUID/account_id reviewer identifier needs to be
   * resolved.
   */
  private async loadWorkspaceMembers(): Promise<void> {
    type Member = {
      user?: {
        uuid?: string
        nickname?: string
        display_name?: string
        account_id?: string
      }
    }
    const members = await this.listAll<Member>(`/workspaces/${this.workspace}/members?pagelen=100`)
    for (const m of members) {
      const u = m.user
      if (!u?.uuid) continue
      const uuid = u.uuid
      const record: BitBucketUserRef = {
        uuid,
        ...(u.account_id ? { account_id: u.account_id } : {}),
        ...(u.nickname ? { nickname: u.nickname } : {}),
        ...(u.display_name ? { display_name: u.display_name } : {}),
      }
      this.memberRecords.set(uuid, record)
      const keys = [u.nickname, u.display_name, u.account_id, u.uuid]
      for (const k of keys) {
        if (typeof k !== 'string' || !k.trim()) continue
        this.memberIndex.set(k.toLowerCase(), uuid)
      }
    }
    this.memberIndexLoaded = true
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createBitBucketClients(settings: Settings): {
  coder: BitBucketClient
  reviewer: BitBucketClient
} {
  return {
    coder: new BitBucketClient(
      settings.bitbucket.workspace,
      settings.bitbucket.coderAccount.username,
      settings.bitbucket.coderAccount.appPassword,
      settings.bitbucket.baseUrl,
    ),
    reviewer: new BitBucketClient(
      settings.bitbucket.workspace,
      settings.bitbucket.reviewerAccount.username,
      settings.bitbucket.reviewerAccount.appPassword,
      settings.bitbucket.baseUrl,
    ),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
