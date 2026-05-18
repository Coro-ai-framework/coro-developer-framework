// ── GitHub SCM plugin (MCP mode) ─────────────────────────────────────────────
//
// After the MCP-first pivot, GitHub's agent-facing operations come from the
// upstream `@modelcontextprotocol/server-github` MCP server (attached at job
// start via `mcpServer()`). The plugin keeps only the responsibilities MCP
// can't do:
//
//   - `cloneInfo(...)`        — provides the credentialed HTTPS clone URL.
//                               No MCP equivalent.
//   - `matchesRemote(...)`    — host check for self-improvement remote
//                               detection. Pure string match.
//   - `normalizeInbound(...)` — parses GitHub webhook payloads into a
//                               provider-neutral NormalizedEvent. MCP
//                               doesn't see webhooks.
//   - `pollPr(...)`           — runs OUTSIDE an active `query()`, so it
//                               can't reach the MCP server. We keep a
//                               tiny inline GitHubClient call for this
//                               single method.
//
// All other operations (createPr, getPrStatus, listPrComments,
// postPrComment, replyToComment, approvePr, mergePr, createRepo) are
// served by the upstream MCP server as `mcp__github__*` tools and have
// been removed from this runtime. The hybrid `scm_*` proxy
// (`packages/runner/src/mcp-handlers.ts`, S4) forwards generic
// `scm_create_pr` etc. through the SDK's MCP client instead.

import { z } from 'zod'
import path from 'node:path'
import type { Logger } from 'pino'
import { GitHubClient } from '../../../clients/github'
import type { ExternalRef, NormalizedEvent } from '@coro/cloud-protocol'
import { externalIdString } from '../../refs'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  PluginMcpServerConfig,
  ScmCloneInfo,
  ScmCreatePrArgs,
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
}

// ── Runtime ──────────────────────────────────────────────────────────────────

class GitHubScmPlugin implements ScmPluginRuntime<GitHubPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'scm' as const

  private client!: GitHubClient
  private owner!: string
  private token!: string
  private baseUrl?: string

  async init(rawConfig: GitHubPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = ghConfigSchema.parse(rawConfig)
    this.owner = cfg.owner
    this.token = cfg.token
    this.baseUrl = cfg.baseUrl
    this.client = new GitHubClient(cfg.owner, cfg.token, cfg.baseUrl)
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
    return {
      url: `https://x-access-token:${token}@github.com/${this.owner}/${args.repo}.git`,
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
    const normalisedComments: ScmPrComment[] = comments.map(c => ({
      id: String(c.id),
      body: c.content.raw,
      createdAt: c.created_on,
      updatedAt: c.updated_on,
      ...(c.parent ? { parentId: String(c.parent.id) } : {}),
      ...(c.inline ? { inline: { path: c.inline.path, line: c.inline.to } } : {}),
    }))
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

  /**
   * Self-improvement writer escape hatch (see ScmPluginRuntime.writerCreatePr).
   * Re-uses the inline `GitHubClient` that `pollPr` already needs, so
   * we don't pay the round-trip cost of spawning a fresh upstream
   * MCP server outside `query()` — which the SDK doesn't support
   * today anyway.
   */
  async writerCreatePr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    const reviewers = args.reviewers ? Array.from(args.reviewers) : undefined
    const pr = await this.client.createPr({
      repoSlug: args.repoSlug,
      title: args.title,
      ...(args.description !== undefined ? { description: args.description } : {}),
      sourceBranch: args.sourceBranch,
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
