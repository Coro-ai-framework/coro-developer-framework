// ── Bitbucket SCM plugin ─────────────────────────────────────────────────────
//
// Wraps the legacy {@link BitBucketClient} behind the {@link ScmPluginRuntime}
// contract. The legacy client stays around for one release because the
// `bb_*` MCP tool wrappers and a handful of internal helpers still call
// it directly; the plugin shape is what the registry, generic MCP tools,
// and the polling transport see.
//
// ── MCP-first pivot status (S3) ──────────────────────────────────────────
//
// Unlike `github`, `jira`, `linear`, and `github-issues` — which switched
// to MCP mode and dropped their per-operation methods — `bitbucket`
// **stays native** for now. It does NOT implement `mcpServer()`. The
// hybrid `scm_*` proxy detects this and falls back to the plugin's own
// methods (createPr, getPrStatus, postPrComment, …), preserving today's
// behaviour exactly.
//
// Why: at the time of this writing there is no production-quality
// upstream BitBucket MCP server covering both Cloud and Server with
// the full `Scm*` op set. See `docs/plugins-bitbucket-future.md` for
// the off-ramp options (wait for upstream, publish ours, contribute
// to community).
//
// Config shape (validated at init):
//   - workspace: BitBucket workspace slug (e.g. `acme`).
//   - coderUsername / coderToken: account that opens PRs.
//   - reviewerUsername / reviewerToken: account that approves & merges.
//
// Reviewer credentials default to coder credentials when omitted —
// solo deployments don't need a separate reviewer account.

import { z } from 'zod'
import path from 'node:path'
import type { Logger } from 'pino'
import {
  BitBucketClient,
  type CreatePrOptions,
  type CreateRepoOptions,
} from '../../../clients/bitbucket'
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

// ── Config schema ────────────────────────────────────────────────────────────

const bbConfigSchema = z.object({
  workspace: z.string().min(1),
  coderUsername: z.string().min(1),
  coderToken: z.string().min(1),
  reviewerUsername: z.string().optional(),
  reviewerToken: z.string().optional(),
  baseUrl: z.string().optional(),
})

export type BitBucketPluginConfig = z.infer<typeof bbConfigSchema>

// A username Bitbucket Basic auth will accept: either an email
// (Atlassian API tokens / App Passwords) or one of the synthetic
// `x-*-auth` usernames used by repository / API tokens.
function looksLikeBitbucketUsername(value: string): boolean {
  return value.includes('@') || /^x-[\w-]+-auth$/.test(value)
}

// ── Manifest ─────────────────────────────────────────────────────────────────

const MANIFEST: PluginManifest = {
  id: 'bitbucket',
  kind: 'scm',
  version: '1.0.0',
  displayName: 'BitBucket',
  hostCompatibility: '^1.0.0',
  configSchema: bbConfigSchema,
  capabilities: {
    supportsRepoCreation: true,
    supportsApproval: true,
    supportsMerge: true,
  },
  webhook: {
    algorithm: 'hmac-sha256',
    header: 'X-Hub-Signature',
    format: 'sha256=<hex>',
  },
  intelligence: {
    snippets: [
      { id: 'bitbucket-clone', relativePath: 'snippets/bitbucket-clone.md' },
    ],
  },
}

// ── Runtime ──────────────────────────────────────────────────────────────────

class BitBucketScmPlugin implements ScmPluginRuntime<BitBucketPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'scm' as const

  private coder!: BitBucketClient
  private reviewer!: BitBucketClient
  private workspace!: string
  private coderUsername!: string
  private coderToken!: string

  async init(rawConfig: BitBucketPluginConfig | Record<string, unknown>, deps: PluginDeps): Promise<void> {
    const cfg = bbConfigSchema.parse(rawConfig)
    this.workspace = cfg.workspace
    this.coderUsername = cfg.coderUsername
    this.coderToken = cfg.coderToken
    this.coder = new BitBucketClient(
      cfg.workspace,
      cfg.coderUsername,
      cfg.coderToken,
      cfg.baseUrl,
    )

    // Reviewer username sanity check.
    //
    // Bitbucket Basic auth requires either the account email
    // (Atlassian API tokens, App Passwords) or a synthetic username
    // (`x-token-auth`, `x-bitbucket-api-token-auth`). A display name
    // like "Jane Doe" 401s every request. We've been bitten by users
    // pasting their display name into `reviewerUsername` — surface a
    // clear warning and fall back to the coder username so the
    // reviewer client at least authenticates against the same
    // account.
    let reviewerUsername = cfg.reviewerUsername ?? cfg.coderUsername
    if (cfg.reviewerUsername && !looksLikeBitbucketUsername(cfg.reviewerUsername)) {
      deps.logger.warn(
        { configured: cfg.reviewerUsername, fallback: cfg.coderUsername },
        'Bitbucket reviewerUsername does not look like an email or x-*-auth synthetic username — falling back to coderUsername. ' +
        'Update plugins.installed.bitbucket.config.reviewerUsername in ~/.coro/config.json to silence this warning.',
      )
      reviewerUsername = cfg.coderUsername
    }

    this.reviewer = new BitBucketClient(
      cfg.workspace,
      reviewerUsername,
      cfg.reviewerToken ?? cfg.coderToken,
      cfg.baseUrl,
    )
  }

  async healthcheck(): Promise<PluginHealth> {
    // No cheap "ping" endpoint; assume reachable. Concrete health checks
    // would issue a low-cost call (e.g. /user) — left for a follow-up.
    return { ok: true }
  }

  async dispose(): Promise<void> {
    // Stateless HTTP client — nothing to release.
  }

  intelligenceRoot(): string | undefined {
    // Plugin-shipped markdown lives next to the runtime so a single
    // `tsc` build keeps it on disk under `dist/.../intelligence/`.
    // The resolver tolerates a missing dir (we declare contributions
    // in the manifest before the snippet file is written).
    return path.join(__dirname, 'intelligence')
  }

  // Expose the underlying clients to back-compat consumers (RunnerContext
  // adapters, the writer's PR-opening fallback). Marked as `internal`
  // because plugin-aware code should never need to reach for the raw
  // client.
  /** @internal */
  unsafeCoderClient(): BitBucketClient { return this.coder }
  /** @internal */
  unsafeReviewerClient(): BitBucketClient { return this.reviewer }

  // ── Clone info ──────────────────────────────────────────────────────────

  cloneInfo(args: { repo: string }): ScmCloneInfo {
    // Bitbucket has three token types and each needs a different git
    // HTTPS username:
    //   - Legacy App Passwords      -> your Atlassian account email
    //   - Legacy Access Tokens      -> 'x-token-auth'  (random prefix)
    //   - New scoped API tokens (ATATT…) -> 'x-bitbucket-api-token-auth'
    // The ATATT prefix is shared with the old `x-token-auth` scheme in
    // some integrations, but for git-over-HTTPS the new tokens require
    // the bitbucket-specific username.
    const username = this.coderToken.startsWith('ATATT')
      ? 'x-bitbucket-api-token-auth'
      : encodeURIComponent(this.coderUsername)
    const token = encodeURIComponent(this.coderToken)
    return {
      url: `https://${username}:${token}@bitbucket.org/${this.workspace}/${args.repo}.git`,
      envForGit: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    }
  }

  // ── Pull requests ──────────────────────────────────────────────────────

  async createPr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    const opts: CreatePrOptions = {
      repoSlug: args.repoSlug,
      title: args.title,
      ...(args.description ? { description: args.description } : {}),
      sourceBranch: args.sourceBranch,
      ...(args.targetBranch ? { targetBranch: args.targetBranch } : {}),
      ...(args.reviewers && args.reviewers.length > 0 ? { reviewerUsernames: [...args.reviewers] } : {}),
    }
    const pr = await this.coder.createPr(opts)
    return {
      kind: 'pull_request',
      pluginId: this.manifest.id,
      repoKey: args.repoSlug,
      externalId: externalIdString(pr.id),
      url: pr.links.html.href,
    }
  }

  /**
   * Self-improvement writer escape hatch. BitBucket is fully native
   * (no upstream MCP), so this just delegates to `createPr`. The
   * dedicated method exists so the writer doesn't have to reach into
   * the agent-facing surface and so the contract stays uniform with
   * MCP-mode plugins like GitHub.
   */
  async writerCreatePr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    return this.createPr(args)
  }

  async getPrStatus(ref: ExternalRef): Promise<ScmPrStatus> {
    const { repoSlug, prId } = this.parseRef(ref)
    const status = await this.coder.getPrStatus(repoSlug, prId)
    return {
      state: this.normaliseState(status.state),
      approvalCount: status.approvalCount,
    }
  }

  async listPrComments(ref: ExternalRef): Promise<ScmPrComment[]> {
    const { repoSlug, prId } = this.parseRef(ref)
    const comments = await this.coder.getComments(repoSlug, prId)
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
    const c = await this.reviewer.postComment(repoSlug, prId, body)
    return {
      id: String(c.id),
      body: c.content.raw,
      createdAt: c.created_on,
      updatedAt: c.updated_on,
    }
  }

  async replyToComment(ref: ExternalRef, parentId: string, body: string): Promise<ScmPrComment> {
    const { repoSlug, prId } = this.parseRef(ref)
    const c = await this.reviewer.replyToComment(repoSlug, prId, Number(parentId), body)
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
    await this.reviewer.approvePr(repoSlug, prId)
  }

  async mergePr(ref: ExternalRef, opts?: ScmMergeOptions): Promise<void> {
    const { repoSlug, prId } = this.parseRef(ref)
    await this.reviewer.mergePr(repoSlug, prId, opts?.message)
  }

  async createRepo(args: ScmCreateRepoArgs): Promise<ExternalRef> {
    const opts: CreateRepoOptions = {
      repoSlug: args.repoSlug,
      ...(args.description ? { description: args.description } : {}),
      ...(args.isPrivate !== undefined ? { isPrivate: args.isPrivate } : {}),
      ...(args.defaultBranch ? { mainBranch: args.defaultBranch } : {}),
    }
    const repo = await this.coder.createRepo(opts)
    const httpsClone = repo.links.clone.find(c => c.name === 'https')
    return {
      kind: 'repo',
      pluginId: this.manifest.id,
      externalId: repo.full_name,
      url: httpsClone?.href ?? `https://bitbucket.org/${repo.full_name}`,
    }
  }

  // ── Polling ────────────────────────────────────────────────────────────

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

  // ── Webhook normalisation ──────────────────────────────────────────────

  normalizeInbound(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): NormalizedEvent | null {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(req.rawBody.toString('utf-8')) as Record<string, unknown>
    } catch {
      return null
    }

    const eventKey = pickHeader(req.headers, 'x-event-key') ?? 'unknown'
    const pr = payload['pullrequest'] as Record<string, unknown> | undefined
    const repo = payload['repository'] as Record<string, unknown> | undefined
    const repoSlug = typeof repo?.['name'] === 'string' ? (repo['name'] as string) : undefined

    if (pr && pr['id'] !== undefined) {
      return {
        ref: {
          kind: 'pull_request',
          pluginId: this.manifest.id,
          repoKey: repoSlug ?? 'unknown',
          externalId: externalIdString(pr['id']),
          ...(typeof (pr['links'] as Record<string, unknown> | undefined)?.['html'] === 'object'
            ? { url: (((pr['links'] as Record<string, unknown>)['html'] as Record<string, unknown>)['href'] as string) }
            : {}),
        },
        kind: this.toGenericPrEvent(eventKey),
        raw: payload,
        receivedAt: new Date().toISOString(),
      }
    }

    return null
  }

  matchesRemote(remoteUrl: string): boolean {
    return /(^|\/\/|@)bitbucket\.org[:/]/i.test(remoteUrl)
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private parseRef(ref: ExternalRef): { repoSlug: string; prId: number } {
    if (ref.pluginId !== this.manifest.id) {
      throw new Error(`bitbucket plugin: refusing to operate on ref owned by "${ref.pluginId}"`)
    }
    if (!ref.repoKey) {
      throw new Error(`bitbucket plugin: ref is missing repoKey for kind=${ref.kind}`)
    }
    const prId = Number(ref.externalId)
    if (Number.isNaN(prId)) {
      throw new Error(`bitbucket plugin: ref.externalId "${ref.externalId}" is not a number`)
    }
    return { repoSlug: ref.repoKey, prId }
  }

  private normaliseState(s: string): ScmPrStatus['state'] {
    switch (s) {
      case 'OPEN': return 'open'
      case 'MERGED': return 'merged'
      case 'DECLINED': return 'declined'
      case 'SUPERSEDED': return 'superseded'
      default: return 'open'
    }
  }

  private toGenericPrEvent(eventKey: string): string {
    if (eventKey.includes('fulfilled')) return 'pr.merged'
    if (eventKey.includes('rejected')) return 'pr.declined'
    if (eventKey.includes('approved')) return 'pr.approved'
    if (eventKey.includes('comment')) return 'pr.commented'
    if (eventKey.includes('updated')) return 'pr.updated'
    return `pr.${eventKey}`
  }

}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createBitBucketScmPlugin(_args: { config: Record<string, unknown>; logger: Logger }): ScmPluginRuntime {
  return new BitBucketScmPlugin()
}
