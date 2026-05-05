// ── GitHub SCM plugin ────────────────────────────────────────────────────────
//
// Wraps {@link GitHubClient} in the {@link ScmPluginRuntime} contract. The
// `cloneInfo` builder absorbs the `github.com` host hardcoding that
// previously lived in `clients/git.ts`, so the runner can host both
// GitHub and BitBucket clones side-by-side without per-host branches.

import { z } from 'zod'
import type { Logger } from 'pino'
import {
  GitHubClient,
  type CreatePrOptions,
  type CreateRepoOptions,
} from '../../../clients/github'
import {
  externalIdString,
  type ExternalRef,
  type NormalizedEvent,
} from '../../refs'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  ScmCloneInfo,
  ScmCreatePrArgs,
  ScmCreateRepoArgs,
  ScmMergeOptions,
  ScmPluginRuntime,
  ScmPollSnapshot,
  ScmPrComment,
  ScmPrStatus,
} from '../../types'

// ── Config ───────────────────────────────────────────────────────────────────

const ghConfigSchema = z.object({
  /** Org or user that owns the repos this plugin operates on. */
  owner: z.string().min(1),
  token: z.string().min(1),
  baseUrl: z.string().optional(),
})

export type GitHubPluginConfig = z.infer<typeof ghConfigSchema>

const MANIFEST: PluginManifest = {
  id: 'github',
  kind: 'scm',
  version: '1.0.0',
  displayName: 'GitHub',
  hostCompatibility: '^1.0.0',
  configSchema: ghConfigSchema,
  capabilities: {
    supportsRepoCreation: true,
    supportsApproval: true,
    supportsMerge: true,
  },
  webhook: {
    algorithm: 'hmac-sha256',
    header: 'X-Hub-Signature-256',
    format: 'sha256=<hex>',
  },
}

// ── Runtime ──────────────────────────────────────────────────────────────────

class GitHubScmPlugin implements ScmPluginRuntime<GitHubPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'scm' as const

  private client!: GitHubClient
  private owner!: string
  private token!: string

  async init(rawConfig: GitHubPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = ghConfigSchema.parse(rawConfig)
    this.owner = cfg.owner
    this.token = cfg.token
    this.client = new GitHubClient(cfg.owner, cfg.token, cfg.baseUrl)
  }

  async healthcheck(): Promise<PluginHealth> {
    return { ok: true }
  }

  async dispose(): Promise<void> {}

  /** @internal */
  unsafeClient(): GitHubClient { return this.client }

  cloneInfo(args: { repo: string }): ScmCloneInfo {
    // GitHub PATs use `x-access-token` as the HTTPS basic-auth username.
    const token = encodeURIComponent(this.token)
    return {
      url: `https://x-access-token:${token}@github.com/${this.owner}/${args.repo}.git`,
      envForGit: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    }
  }

  async createPr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    const opts: CreatePrOptions = {
      repoSlug: args.repoSlug,
      title: args.title,
      ...(args.description ? { description: args.description } : {}),
      sourceBranch: args.sourceBranch,
      ...(args.targetBranch ? { targetBranch: args.targetBranch } : {}),
      ...(args.reviewers && args.reviewers.length > 0 ? { reviewerUsernames: [...args.reviewers] } : {}),
    }
    const pr = await this.client.createPr(opts)
    return {
      kind: 'pull_request',
      pluginId: this.manifest.id,
      repoKey: args.repoSlug,
      externalId: externalIdString(pr.id),
      url: pr.links.html.href,
    }
  }

  async getPrStatus(ref: ExternalRef): Promise<ScmPrStatus> {
    const { repoSlug, prId } = this.parseRef(ref)
    const status = await this.client.getPrStatus(repoSlug, prId)
    return {
      state: this.normaliseState(status.state),
      approvalCount: status.approvalCount,
    }
  }

  async listPrComments(ref: ExternalRef): Promise<ScmPrComment[]> {
    const { repoSlug, prId } = this.parseRef(ref)
    const comments = await this.client.getComments(repoSlug, prId)
    return comments.map(c => ({
      id: String(c.id),
      body: c.content.raw,
      createdAt: c.created_on,
      updatedAt: c.updated_on,
      ...(c.parent ? { parentId: String(c.parent.id) } : {}),
      ...(c.inline ? { inline: { path: c.inline.path, line: c.inline.to } } : {}),
    }))
  }

  async postPrComment(ref: ExternalRef, body: string): Promise<ScmPrComment> {
    const { repoSlug, prId } = this.parseRef(ref)
    const c = await this.client.postComment(repoSlug, prId, body)
    return {
      id: String(c.id),
      body: c.content.raw,
      createdAt: c.created_on,
      updatedAt: c.updated_on,
    }
  }

  async replyToComment(ref: ExternalRef, parentId: string, body: string): Promise<ScmPrComment> {
    const { repoSlug, prId } = this.parseRef(ref)
    const c = await this.client.replyToComment(repoSlug, prId, Number(parentId), body)
    return {
      id: String(c.id),
      body: c.content.raw,
      createdAt: c.created_on,
      updatedAt: c.updated_on,
      parentId,
    }
  }

  async approvePr(ref: ExternalRef): Promise<void> {
    const { repoSlug, prId } = this.parseRef(ref)
    await this.client.approvePr(repoSlug, prId)
  }

  async mergePr(ref: ExternalRef, opts?: ScmMergeOptions): Promise<void> {
    const { repoSlug, prId } = this.parseRef(ref)
    await this.client.mergePr(repoSlug, prId, opts?.message)
  }

  async createRepo(args: ScmCreateRepoArgs): Promise<ExternalRef> {
    const opts: CreateRepoOptions = {
      repoSlug: args.repoSlug,
      ...(args.description ? { description: args.description } : {}),
      ...(args.isPrivate !== undefined ? { isPrivate: args.isPrivate } : {}),
    }
    const repo = await this.client.createRepo(opts)
    return {
      kind: 'repo',
      pluginId: this.manifest.id,
      externalId: repo.full_name,
      url: `https://github.com/${repo.full_name}`,
    }
  }

  async pollPr(ref: ExternalRef): Promise<ScmPollSnapshot> {
    const [status, comments] = await Promise.all([
      this.getPrStatus(ref),
      this.listPrComments(ref),
    ])
    return {
      state: status.state,
      approvalCount: status.approvalCount,
      commentCount: comments.length,
      comments,
    }
  }

  normalizeInbound(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): NormalizedEvent | null {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(req.rawBody.toString('utf-8')) as Record<string, unknown>
    } catch {
      return null
    }

    const eventName = pickHeader(req.headers, 'x-github-event') ?? 'unknown'
    const action = typeof payload['action'] === 'string' ? (payload['action'] as string) : ''

    const pr = (payload['pull_request'] as Record<string, unknown> | undefined)
      ?? (payload['pullrequest'] as Record<string, unknown> | undefined)
    const repo = payload['repository'] as Record<string, unknown> | undefined
    const repoFullName = typeof repo?.['full_name'] === 'string' ? (repo['full_name'] as string) : undefined
    const repoSlug = typeof repo?.['name'] === 'string' ? (repo['name'] as string) : repoFullName?.split('/')[1]

    if (pr && (pr['number'] !== undefined || pr['id'] !== undefined)) {
      const prId = pr['number'] ?? pr['id']
      const url = typeof pr['html_url'] === 'string' ? (pr['html_url'] as string) : undefined
      return {
        ref: {
          kind: 'pull_request',
          pluginId: this.manifest.id,
          repoKey: repoSlug ?? 'unknown',
          externalId: externalIdString(prId),
          ...(url ? { url } : {}),
        },
        kind: this.toGenericPrEvent(eventName, action),
        raw: payload,
        receivedAt: new Date().toISOString(),
      }
    }

    return null
  }

  matchesRemote(remoteUrl: string): boolean {
    return /(^|\/\/|@)github\.com[:/]/i.test(remoteUrl)
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private parseRef(ref: ExternalRef): { repoSlug: string; prId: number } {
    if (ref.pluginId !== this.manifest.id) {
      throw new Error(`github plugin: refusing to operate on ref owned by "${ref.pluginId}"`)
    }
    if (!ref.repoKey) {
      throw new Error(`github plugin: ref is missing repoKey for kind=${ref.kind}`)
    }
    const prId = Number(ref.externalId)
    if (Number.isNaN(prId)) {
      throw new Error(`github plugin: ref.externalId "${ref.externalId}" is not a number`)
    }
    return { repoSlug: ref.repoKey, prId }
  }

  private normaliseState(s: string): ScmPrStatus['state'] {
    switch (s.toUpperCase()) {
      case 'OPEN': return 'open'
      case 'MERGED': return 'merged'
      case 'CLOSED':
      case 'DECLINED': return 'declined'
      default: return 'open'
    }
  }

  private toGenericPrEvent(eventName: string, action: string): string {
    if (eventName === 'pull_request') {
      if (action === 'closed') return 'pr.declined'
      if (action === 'opened') return 'pr.opened'
      if (action === 'synchronize') return 'pr.updated'
      if (action === 'review_requested') return 'pr.review_requested'
      return `pr.${action || 'updated'}`
    }
    if (eventName === 'pull_request_review') {
      if (action === 'submitted') return 'pr.approved'
      return `pr.review_${action || 'changed'}`
    }
    if (eventName === 'pull_request_review_comment' || eventName === 'issue_comment') {
      return 'pr.commented'
    }
    return `pr.${eventName}`
  }
}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createGitHubScmPlugin(_args: { config: Record<string, unknown>; logger: Logger }): ScmPluginRuntime {
  return new GitHubScmPlugin()
}
