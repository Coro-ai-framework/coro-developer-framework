// ── GitHub SCM plugin ────────────────────────────────────────────────────────
//
// The upstream `@modelcontextprotocol/server-github` MCP server is still
// attached at job start (via `mcpServer()`) so agents can reach the long tail
// of GitHub operations as `mcp__github__*` tools. But the PR lifecycle —
// create, status, comments, reply, approve, merge — is served here by the
// inline `GitHubClient`, alongside the operations MCP structurally cannot do:
//
//   - `cloneInfo(...)`        — credentialed HTTPS clone URL. No MCP
//                               equivalent.
//   - `matchesRemote(...)`    — host check for self-improvement remote
//                               detection. Pure string match.
//   - `normalizeInbound(...)` — parses GitHub webhook payloads into a
//                               provider-neutral NormalizedEvent. MCP
//                               doesn't see webhooks.
//   - `pollPr(...)`           — runs OUTSIDE an active `query()`, so it
//                               cannot reach any MCP server.
//
// The MCP-first pivot (S4) had removed the lifecycle methods so the generic
// `scm_*` proxy would redirect agents to the native tools. That redirect is
// delivered as `isError: true`, so an agent working a PR saw a run of
// failures across five tools and could reasonably conclude the PR surface was
// broken — one such job escalated instead of merging. Serving them locally
// also makes GitHub behave like Bitbucket, which never stopped doing so.
// `mcpToolMap` stays in the manifest as the fallback contract: the proxy only
// redirects for ops a plugin leaves undefined.

import { z } from 'zod'
import path from 'node:path'
import type { Logger } from 'pino'
import { GitHubClient, parseGitHubRepo, type PrComment } from '../../../clients/github'
import type { ExternalRef, NormalizedEvent } from '@coro-ai/cloud-protocol'
import { externalIdString } from '../../refs'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  PluginMcpServerConfig,
  ScmCloneInfo,
  ScmCodeSearchHit,
  ScmDirectoryEntry,
  ScmCreatePrArgs,
  ScmMergeOptions,
  ScmPluginRuntime,
  ScmPollSnapshot,
  ScmPrComment,
  ScmPrStatus,
  ScmReadFileResult,
  CredentialCandidate,
} from '../../types'
import { detectGitHubCredentials } from './detect'
import { registerGitHubOAuthRoutes } from './oauth-routes'

// ── Config ───────────────────────────────────────────────────────────────────

const ghConfigSchema = z.object({
  /** Org or user that owns the repos this plugin operates on. */
  owner: z.string().min(1),
  token: z.string().min(1),
  baseUrl: z.string().optional(),
})

export type GitHubPluginConfig = z.infer<typeof ghConfigSchema>

// Curated list of upstream MCP tools we want the agent to see by
// default. The upstream `@modelcontextprotocol/server-github` ships
// ~70 tools; surfacing all of them at the prompt is expensive and
// distracting. The list mirrors the agent procedures in
// `packages/intelligence-base/layer/agents/*.md`.
//
// Operators that need additional tools can override this list
// per-tenant by editing `~/.coro/config.json`'s
// `plugins.installed.github.config.allowedMcpTools` after the legacy
// config translator (`local-config.ts`) propagates it into the
// manifest's capabilities.
const DEFAULT_ALLOWED_MCP_TOOLS: ReadonlyArray<string> = [
  // Pull request lifecycle
  'create_pull_request',
  'get_pull_request',
  'list_pull_requests',
  'merge_pull_request',
  // PR review + comments
  'create_pull_request_review',
  'get_pull_request_comments',
  'add_pull_request_review_comment',
  'add_issue_comment',
  // Repo bootstrapping (rare path — campaign planner uses it)
  'create_repository',
  // File / content reads — agents occasionally need these
  'get_file_contents',
  // Commit / branch metadata
  'list_branches',
  'get_commit',
  'list_commits',
  // Search (used by planners + reviewers)
  'search_code',
  'search_repositories',
]

const MANIFEST: PluginManifest = {
  id: 'github',
  kind: 'scm',
  version: '2.0.0',
  displayName: 'GitHub',
  hostCompatibility: '^1.0.0',
  configSchema: ghConfigSchema,
  capabilities: {
    supportsRepoCreation: true,
    supportsApproval: true,
    supportsMerge: true,
  },
  allowedMcpTools: DEFAULT_ALLOWED_MCP_TOOLS,
  // Maps Coro's generic proxy ops to the upstream
  // `@modelcontextprotocol/server-github` tool names. Read by the
  // hybrid `scm_*` proxy (`mcp-handlers.ts`) when redirecting an
  // agent call to the active MCP-mode plugin.
  mcpToolMap: {
    scm_create_pr: 'create_pull_request',
    scm_get_pr_status: 'get_pull_request',
    scm_list_pr_comments: 'get_pull_request_comments',
    scm_post_pr_comment: 'add_issue_comment',
    scm_reply_to_comment: 'add_pull_request_review_comment',
    scm_merge_pr: 'merge_pull_request',
  },
  webhook: {
    algorithm: 'hmac-sha256',
    header: 'X-Hub-Signature-256',
    format: 'sha256=<hex>',
  },
  intelligence: {
    snippets: [
      { id: 'github-clone', relativePath: 'snippets/github-clone.md' },
    ],
  },
  ui: {
    subtitle: 'github.com or GitHub Enterprise. Personal or fine-grained PAT.',
  },
  auth: {
    methods: [
      {
        kind: 'detect',
        id: 'gh-cli',
        label: 'Use existing GitHub CLI session',
        recommended: true,
        accountConfigKey: 'owner',
      },
      {
        kind: 'oauth',
        id: 'device-oauth',
        label: 'Sign in with GitHub',
        startPath: '/config/plugins/github/auth/device-oauth/start',
        statusPath: '/config/plugins/github/auth/device-oauth/status',
      },
      {
        kind: 'form',
        id: 'manual',
        label: 'Personal access token',
        fields: [
          {
            key: 'owner',
            label: 'Owner / organisation',
            kind: 'text',
            placeholder: 'acme-inc',
            hint: 'The org or user that owns the repos you want Coro to work in.',
            required: true,
          },
          {
            key: 'token',
            label: 'Personal access token',
            kind: 'secret',
            placeholder: 'ghp_… or github_pat_…',
            hint: "Needs the 'repo' scope (or equivalent fine-grained permissions).",
            required: true,
          },
        ],
      },
    ],
  },
}

// ── Runtime ──────────────────────────────────────────────────────────────────

class GitHubScmPlugin implements ScmPluginRuntime<GitHubPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'scm' as const

  private client!: GitHubClient
  private owner!: string
  private token!: string
  private baseUrl?: string
  private fetchFn: typeof fetch = globalThis.fetch

  async init(rawConfig: GitHubPluginConfig | Record<string, unknown>, deps: PluginDeps): Promise<void> {
    const cfg = ghConfigSchema.parse(rawConfig)
    this.owner = cfg.owner
    this.token = cfg.token
    this.baseUrl = cfg.baseUrl
    this.fetchFn = deps.fetch
    this.client = new GitHubClient(cfg.owner, cfg.token, cfg.baseUrl)
  }

  async detectCredentials(): Promise<ReadonlyArray<CredentialCandidate>> {
    return detectGitHubCredentials(this.fetchFn)
  }

  registerHttpRoutes(ctx: import('@coro-ai/plugin-sdk').PluginHttpRoutesContext): void {
    registerGitHubOAuthRoutes(ctx, { pluginId: 'github', ownerConfigKey: 'owner' })
  }

  async healthcheck(): Promise<PluginHealth> {
    return { ok: true }
  }

  async dispose(): Promise<void> {}

  intelligenceRoot(): string | undefined {
    return path.join(__dirname, 'intelligence')
  }

  /**
   * Descriptor for the upstream `@modelcontextprotocol/server-github`
   * MCP server. The runner spawns this once per job (under the
   * registration key `github`) so the agent sees the upstream tools as
   * `mcp__github__*`.
   *
   * Overriding `GITHUB_API_URL` lets the plugin point at GHE servers
   * when `config.baseUrl` is set.
   */
  mcpServer(): PluginMcpServerConfig {
    const env: Record<string, string> = {
      GITHUB_PERSONAL_ACCESS_TOKEN: this.token,
    }
    if (this.baseUrl) {
      env.GITHUB_API_URL = this.baseUrl
    }
    return {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env,
    }
  }

  cloneInfo(args: { repo: string }): ScmCloneInfo {
    // GitHub PATs use `x-access-token` as the HTTPS basic-auth username.
    const token = encodeURIComponent(this.token)
    // `repo` may carry its own owner (`someone/coro`) — an upstream
    // contribution clones a fork that is not under the configured org.
    const { owner, repo } = parseGitHubRepo(args.repo, this.owner)
    return {
      url: `https://x-access-token:${token}@github.com/${owner}/${repo}.git`,
      envForGit: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    }
  }

  /**
   * Polling transport entry point. Runs in the runner's main event
   * loop, OUTSIDE any `query()` session — so we can't reach the MCP
   * server here. The PR status + comments are fetched via the inline
   * GitHubClient (kept solely for this purpose after the pivot).
   */
  async pollPr(ref: ExternalRefShape): Promise<ScmPollSnapshot> {
    const { repoSlug, prId } = parseRef(ref, this.manifest.id)
    const [status, comments] = await Promise.all([
      this.client.getPrStatus(repoSlug, prId),
      this.client.getComments(repoSlug, prId),
    ])
    const normalisedComments: ScmPrComment[] = comments.map(toScmComment)
    return {
      state: normalisePrState(status.state),
      approvalCount: status.approvalCount,
      commentCount: normalisedComments.length,
      comments: normalisedComments,
    }
  }

  matchesRemote(remoteUrl: string): boolean {
    return /(^|\/\/|@)github\.com[:/]/i.test(remoteUrl)
  }

  async readFile(args: { repo: string; path: string; ref?: string }): Promise<ScmReadFileResult> {
    return this.client.getFileContent(args.repo, args.path, args.ref ?? 'HEAD')
  }

  async searchCode(args: { repo: string; query: string; maxResults?: number }): Promise<ScmCodeSearchHit[]> {
    return this.client.searchCode(args.repo, args.query, args.maxResults ?? 20)
  }

  async listFiles(args: { repo: string; path?: string; ref?: string }): Promise<ScmDirectoryEntry[]> {
    return this.client.listFiles(args.repo, args.path ?? '', args.ref ?? 'HEAD')
  }

  async createPr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    const reviewers = args.reviewers ? Array.from(args.reviewers) : undefined
    const pr = await this.client.createPr({
      repoSlug: args.repoSlug,
      title: args.title,
      ...(args.description !== undefined ? { description: args.description } : {}),
      sourceBranch: args.sourceBranch,
      ...(args.sourceOwner !== undefined ? { sourceOwner: args.sourceOwner } : {}),
      ...(args.targetBranch !== undefined ? { targetBranch: args.targetBranch } : {}),
      ...(reviewers && reviewers.length > 0 ? { reviewerUsernames: reviewers } : {}),
    })
    return {
      kind: 'pull_request',
      pluginId: this.manifest.id,
      repoKey: args.repoSlug,
      externalId: String(pr.id),
      url: pr.links.html.href,
    }
  }

  /**
   * Self-improvement writer escape hatch (see ScmPluginRuntime.writerCreatePr).
   * Uses the inline `GitHubClient` because it runs outside `query()`, where
   * no MCP server is reachable.
   */
  async writerCreatePr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    return this.createPr(args)
  }

  // ── PR lifecycle ───────────────────────────────────────────────────────────
  //
  // Served by the inline `GitHubClient` rather than redirected to the
  // upstream MCP server. The generic `scm_*` proxy only redirects when the
  // plugin leaves a method undefined, and a redirect is reported to the
  // agent as `isError: true` — so leaving these out meant every PR
  // operation looked like a failure, and an agent that hit several in a
  // row could reasonably conclude the whole PR surface was broken.
  //
  // Implementing them also makes GitHub behave like Bitbucket, which has
  // always served these locally. The client already had every method; only
  // the wiring was missing.

  async getPrStatus(ref: ExternalRef): Promise<ScmPrStatus> {
    const { repoSlug, prId } = parseRef(ref, this.manifest.id)
    const status = await this.client.getPrStatus(repoSlug, prId)
    return {
      state: normalisePrState(status.state),
      approvalCount: status.approvalCount,
    }
  }

  async listPrComments(ref: ExternalRef): Promise<ScmPrComment[]> {
    const { repoSlug, prId } = parseRef(ref, this.manifest.id)
    const comments = await this.client.getComments(repoSlug, prId)
    return comments.map(toScmComment)
  }

  async postPrComment(ref: ExternalRef, body: string): Promise<ScmPrComment> {
    const { repoSlug, prId } = parseRef(ref, this.manifest.id)
    return toScmComment(await this.client.postComment(repoSlug, prId, body))
  }

  async replyToComment(ref: ExternalRef, parentId: string, body: string): Promise<ScmPrComment> {
    const { repoSlug, prId } = parseRef(ref, this.manifest.id)
    const parent = Number(parentId)
    if (!Number.isFinite(parent)) {
      throw new Error(`github plugin: parentCommentId "${parentId}" is not a number`)
    }
    return toScmComment(await this.client.replyToComment(repoSlug, prId, parent, body))
  }

  async approvePr(ref: ExternalRef): Promise<void> {
    const { repoSlug, prId } = parseRef(ref, this.manifest.id)
    await this.client.approvePr(repoSlug, prId)
  }

  async mergePr(ref: ExternalRef, opts?: ScmMergeOptions): Promise<void> {
    const { repoSlug, prId } = parseRef(ref, this.manifest.id)
    await this.client.mergePr(repoSlug, prId, opts?.message)
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
        kind: toGenericPrEvent(eventName, action),
        raw: payload,
        receivedAt: new Date().toISOString(),
      }
    }

    return null
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ExternalRefShape {
  kind: string
  pluginId: string
  externalId: string
  repoKey?: string
}

function parseRef(ref: ExternalRefShape, pluginId: string): { repoSlug: string; prId: number } {
  if (ref.pluginId !== pluginId) {
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

function toScmComment(c: PrComment): ScmPrComment {
  return {
    id: String(c.id),
    body: c.content.raw,
    createdAt: c.created_on,
    updatedAt: c.updated_on,
    ...(c.parent ? { parentId: String(c.parent.id) } : {}),
    ...(c.inline ? { inline: { path: c.inline.path, line: c.inline.to } } : {}),
  }
}

function normalisePrState(s: string): ScmPrStatus['state'] {
  switch (s.toUpperCase()) {
    case 'OPEN': return 'open'
    case 'MERGED': return 'merged'
    case 'CLOSED':
    case 'DECLINED': return 'declined'
    default: return 'open'
  }
}

function toGenericPrEvent(eventName: string, action: string): string {
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

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createGitHubScmPlugin(_args: { config: Record<string, unknown>; logger: Logger }): ScmPluginRuntime {
  return new GitHubScmPlugin()
}
