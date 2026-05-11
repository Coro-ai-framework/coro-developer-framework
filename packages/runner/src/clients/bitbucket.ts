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

export class BitBucketClient {
  private readonly authHeader: string
  private readonly baseUrl: string

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

  async listFiles(repoSlug: string, dirPath: string, revision = 'HEAD'): Promise<string[]> {
    const data = await this.request<{ values: { path: string; type: string }[]; next?: string }>(
      'GET',
      `/repositories/${this.workspace}/${repoSlug}/src/${revision}/${dirPath}`,
    )
    return data.values.map(v => v.path)
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
        const reviewers = opts.reviewerUsernames.map(u => ({ username: u }))
        return await this.request('POST', `/repositories/${this.workspace}/${opts.repoSlug}/pullrequests`, {
          ...body,
          reviewers,
        })
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
