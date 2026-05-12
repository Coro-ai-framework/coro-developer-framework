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

// Token-type guidance shared between zod field hints, init() validation
// errors, and the dashboard's auto-rendered config card. Keeping a
// single string means the user sees the *exact* same instructions
// regardless of where the misconfiguration is caught.
const USERNAME_HELP =
  'Use the Atlassian account email for App Passwords / Atlassian API tokens, ' +
  '`x-token-auth` for legacy repository access tokens, or ' +
  '`x-bitbucket-api-token-auth` for Bitbucket-scoped API tokens. ' +
  'A display name (e.g. "Jane Doe") will 401 every request.'

const bbConfigSchema = z.object({
  workspace: z
    .string()
    .min(1)
    .describe('Bitbucket workspace slug (the part after `bitbucket.org/`).'),
  coderUsername: z
    .string()
    .min(1)
    .describe(`Account that opens PRs. ${USERNAME_HELP}`),
  coderToken: z
    .string()
    .min(1)
    .describe('App Password, repository access token, or API token paired with the username above.'),
  reviewerUsername: z
    .string()
    .optional()
    .describe(`Reviewer account (defaults to coder). ${USERNAME_HELP}`),
  reviewerToken: z
    .string()
    .optional()
    .describe('Reviewer credential (defaults to coder token).'),
  baseUrl: z
    .string()
    .optional()
    .describe('Override the Bitbucket Cloud REST base URL (Server/DC installs).'),
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

    // Hard-fail at startup on a malformed coderUsername. The most
    // common foot-gun is pasting an Atlassian display name ("Jane
    // Doe") into the username field — Basic auth then 401s every
    // request, the agent reads it as a missing scope, and we waste a
    // job. We catch it here so the user gets a single clear error
    // before any tool runs.
    if (!looksLikeBitbucketUsername(cfg.coderUsername)) {
      throw new Error(
        `Invalid Bitbucket coderUsername "${cfg.coderUsername}". ${USERNAME_HELP}`,
      )
    }

    this.workspace = cfg.workspace
    this.coderUsername = cfg.coderUsername
    this.coderToken = cfg.coderToken
    this.coder = new BitBucketClient(
      cfg.workspace,
      cfg.coderUsername,
      cfg.coderToken,
      cfg.baseUrl,
    )

    // Reviewer username sanity check. Same shape as coderUsername but
    // we fall back instead of throwing so a misconfigured reviewer
    // doesn't wedge the whole plugin — the coder credentials still
    // work for everything except approving the agent's own PR.
    let reviewerUsername = cfg.reviewerUsername ?? cfg.coderUsername
    if (cfg.reviewerUsername && !looksLikeBitbucketUsername(cfg.reviewerUsername)) {
      deps.logger.warn(
        { configured: cfg.reviewerUsername, fallback: cfg.coderUsername },
        `Bitbucket reviewerUsername "${cfg.reviewerUsername}" is not an email or x-*-auth synthetic — falling back to coderUsername. ${USERNAME_HELP}`,
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
    // Cheap ping against /2.0/user with the coder credentials. This
    // catches the most common failure mode (wrong username for the
    // token type) at startup instead of mid-job. We don't probe the
    // workspace explicitly — listing the user is enough to confirm
    // Basic auth is accepted.
    try {
      const baseUrl = (this.coder as unknown as { baseUrl?: string }).baseUrl ?? 'https://api.bitbucket.org/2.0'
      const auth = Buffer.from(`${this.coderUsername}:${this.coderToken}`).toString('base64')
      const r = await fetch(`${baseUrl}/user`, {
        headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'coro-runner' },
      })
      if (!r.ok) {
        const detail = await r.text().catch(() => '')
        return {
          ok: false,
          reason:
            `Bitbucket auth check failed (${r.status}): ${detail.slice(0, 200) || r.statusText}. ` +
            `${USERNAME_HELP}`,
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `Bitbucket auth check threw: ${(err as Error).message}` }
    }
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
    // Trust the configured `coderUsername`. Bitbucket has three token
    // types and each requires its own username (Atlassian email,
    // `x-token-auth`, or `x-bitbucket-api-token-auth`); the token
    // prefix cannot disambiguate them. An earlier auto-map of every
    // `ATATT…` token to `x-bitbucket-api-token-auth` broke plain
    // Atlassian API tokens (which need the email) — git push appeared
    // to work but every REST call 401'd, and the agent then
    // misclassified the failure as a missing scope. The init()
    // validator above guarantees the username is in a shape Bitbucket
    // Basic auth can accept.
    const username = encodeURIComponent(this.coderUsername)
    const token = encodeURIComponent(this.coderToken)
    return {
      url: `https://${username}:${token}@bitbucket.org/${this.workspace}/${args.repo}.git`,
      envForGit: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    }
  }

  // ── Pull requests ──────────────────────────────────────────────────────

  async createPr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    // Idempotent: Bitbucket rejects a second POST for the same source
    // branch with `400 There is already an open pull request for this
    // source branch`. The agent's natural reflex is to dedupe with raw
    // `curl` — which fails because BB has three token/username combos
    // and the agent guesses wrong. Dedupe inside the plugin so the
    // agent can call `scm_create_pr` unconditionally.
    try {
      const openPrs = await this.coder.listPrs(args.repoSlug, 'OPEN')
      const existing = openPrs.find(
        p => p.source?.branch?.name === args.sourceBranch,
      )
      if (existing) {
        return {
          kind: 'pull_request',
          pluginId: this.manifest.id,
          repoKey: args.repoSlug,
          externalId: externalIdString(existing.id),
          url: existing.links.html.href,
        }
      }
    } catch {
      // Lookup failed — fall through to POST. The POST itself will
      // surface the real auth/permission error in a single place
      // instead of two.
    }

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

  async addReviewers(args: { repoSlug: string; prId: number | string; reviewers: ReadonlyArray<string> }): Promise<void> {
    const prId = Number(args.prId)
    if (!Number.isFinite(prId)) {
      throw new Error(`addReviewers: prId must be numeric, got "${args.prId}"`)
    }
    // Bitbucket's PUT replaces the reviewer list \u2014 read the current
    // PR first and merge so we don't drop the original author's
    // reviewers. Dedupe by username.
    const pr = await this.coder.getPr(args.repoSlug, prId)
    const existing = new Set<string>(
      ((pr as unknown as { reviewers?: { username?: string; uuid?: string }[] }).reviewers ?? [])
        .map(r => r.username ?? r.uuid ?? '')
        .filter(Boolean),
    )
    for (const u of args.reviewers) existing.add(u)
    await this.coder.updatePrReviewers(args.repoSlug, prId, [...existing])
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
