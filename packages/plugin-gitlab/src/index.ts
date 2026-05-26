// ── @coro-ai/plugin-gitlab ─────────────────────────────────────────────────────
//
// Reference Coro plugin demonstrating the MCP-first pattern. This plugin:
//
//   - Declares the `gitlab` SCM plugin manifest.
//   - Returns an MCP server descriptor pointing at the upstream
//     `@modelcontextprotocol/server-gitlab` package, so the agent gets
//     `mcp__gitlab__*` tools at runtime.
//   - Implements only the four operations MCP cannot serve from inside
//     a `query()` session: cloneInfo, matchesRemote, normalizeInbound,
//     pollPr, plus the writerCreatePr escape hatch for self-improvement
//     PRs.
//
// Drop this package into `~/.coro/plugins/gitlab/` (or `npm install`
// it via the dashboard's "Install plugin" UI), restart `coro start`,
// and the GitLab plugin appears in the registry.
//
// Tested against `@modelcontextprotocol/server-gitlab >= 0.6.0`. The
// upstream tool surface is large (~30 tools); we curate a default
// `allowedMcpTools` list that mirrors the operations Coro's agent
// procedures actually use.

import { z } from 'zod'
import path from 'node:path'
import type { ExternalRef, NormalizedEvent } from '@coro-ai/cloud-protocol'
import {
  ScmPluginBase,
  buildExternalRef,
  mcpStdioDescriptor,
  readHeader,
  type PluginDeps,
  type PluginManifest,
  type PluginMcpServerConfig,
  type ScmCloneInfo,
  type ScmCreatePrArgs,
  type ScmPollSnapshot,
  type ScmPrComment,
  type ScmPrStatus,
} from '@coro-ai/plugin-sdk'

// ── Config ──────────────────────────────────────────────────────────────────

const gitlabConfigSchema = z.object({
  /**
   * GitLab namespace (group or user) under which the plugin operates.
   * Equivalent to GitHub's `owner`. For nested groups, pass the full
   * path (e.g. `my-group/sub-group`).
   */
  namespace: z.string().min(1),
  /** Personal access token with `api` + `read_repository` scopes. */
  token: z.string().min(1),
  /**
   * Override for self-managed GitLab instances. Defaults to
   * `https://gitlab.com/api/v4` upstream when omitted.
   */
  baseUrl: z.string().optional(),
})

export type GitLabPluginConfig = z.infer<typeof gitlabConfigSchema>

// ── Manifest ────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_MCP_TOOLS: ReadonlyArray<string> = [
  // Merge request lifecycle (GitLab's term for PR)
  'create_merge_request',
  'get_merge_request',
  'list_merge_requests',
  'merge_merge_request',
  'update_merge_request',
  // Discussion / comment threads
  'create_merge_request_thread',
  'create_merge_request_note',
  'list_merge_request_discussions',
  // Project + repo bootstrapping
  'create_repository',
  'fork_repository',
  // File / content reads
  'get_file_contents',
  // Branches & commits
  'create_branch',
  'list_branches',
  'get_commit',
  // Search (used by planners + reviewers)
  'search_repositories',
]

const MANIFEST: PluginManifest = {
  id: 'gitlab',
  kind: 'scm',
  version: '0.1.0',
  displayName: 'GitLab',
  hostCompatibility: '^1.0.0',
  configSchema: gitlabConfigSchema,
  capabilities: {
    supportsRepoCreation: true,
    supportsApproval: true,
    supportsMerge: true,
  },
  allowedMcpTools: DEFAULT_ALLOWED_MCP_TOOLS,
  // Maps Coro's generic `scm_*` proxy ops to upstream tool names.
  // Read by the runner's `mcp-handlers.ts` when redirecting an
  // agent call to this plugin's MCP server.
  mcpToolMap: {
    scm_create_pr: 'create_merge_request',
    scm_get_pr_status: 'get_merge_request',
    scm_list_pr_comments: 'list_merge_request_discussions',
    scm_post_pr_comment: 'create_merge_request_note',
    scm_merge_pr: 'merge_merge_request',
  },
  webhook: {
    algorithm: 'none',
    header: 'X-Gitlab-Token',
    format: '<plain>',
  },
  intelligence: {
    snippets: [
      { id: 'gitlab-clone', relativePath: 'snippets/gitlab-clone.md' },
    ],
  },
}

// ── Runtime ─────────────────────────────────────────────────────────────────

class GitLabScmPlugin extends ScmPluginBase<GitLabPluginConfig> {
  readonly manifest = MANIFEST

  private namespace!: string
  private token!: string
  private baseUrl?: string
  private fetchImpl!: typeof fetch

  async init(rawConfig: GitLabPluginConfig | Record<string, unknown>, deps: PluginDeps): Promise<void> {
    const cfg = gitlabConfigSchema.parse(rawConfig)
    this.namespace = cfg.namespace
    this.token = cfg.token
    if (cfg.baseUrl) this.baseUrl = cfg.baseUrl
    this.fetchImpl = deps.fetch
  }

  intelligenceRoot(): string | undefined {
    return path.join(__dirname, '..', 'intelligence')
  }

  /**
   * Spawns the upstream GitLab MCP server with credentials baked into
   * env. The runner attaches this once per job under the registration
   * key `gitlab`, so the agent sees `mcp__gitlab__create_merge_request`,
   * etc.
   */
  override mcpServer(): PluginMcpServerConfig {
    const env: Record<string, string> = {
      GITLAB_PERSONAL_ACCESS_TOKEN: this.token,
    }
    if (this.baseUrl) {
      env.GITLAB_API_URL = this.baseUrl
    }
    return mcpStdioDescriptor({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gitlab'],
      env,
    })
  }

  cloneInfo(args: { repo: string }): ScmCloneInfo {
    // GitLab PATs use the literal username `oauth2` for HTTPS basic auth.
    const token = encodeURIComponent(this.token)
    const host = this.gitlabHost()
    return {
      url: `https://oauth2:${token}@${host}/${this.namespace}/${args.repo}.git`,
      envForGit: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    }
  }

  matchesRemote(remoteUrl: string): boolean {
    const host = this.gitlabHost()
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|//|@)${escaped}[:/]`, 'i').test(remoteUrl)
  }

  /**
   * Polling runs OUTSIDE an active `query()` session, so we reach the
   * GitLab REST API directly here. Kept intentionally minimal: only
   * the fields the runner actually checks.
   */
  async pollPr(ref: ExternalRef): Promise<ScmPollSnapshot> {
    const { projectPath, mrIid } = parseRef(ref, this.manifest.id, this.namespace)
    const projectId = encodeURIComponent(projectPath)
    const apiBase = this.baseUrl ?? 'https://gitlab.com/api/v4'

    const [mrRes, discRes] = await Promise.all([
      this.fetchImpl(`${apiBase}/projects/${projectId}/merge_requests/${mrIid}`, {
        headers: { 'PRIVATE-TOKEN': this.token },
      }),
      this.fetchImpl(`${apiBase}/projects/${projectId}/merge_requests/${mrIid}/discussions`, {
        headers: { 'PRIVATE-TOKEN': this.token },
      }),
    ])

    if (!mrRes.ok) {
      throw new Error(`gitlab pollPr: GET merge_request failed: ${mrRes.status} ${mrRes.statusText}`)
    }
    if (!discRes.ok) {
      throw new Error(`gitlab pollPr: GET discussions failed: ${discRes.status} ${discRes.statusText}`)
    }

    const mr = (await mrRes.json()) as GitLabMrPayload
    const discussions = (await discRes.json()) as GitLabDiscussion[]

    const comments: ScmPrComment[] = []
    for (const disc of discussions) {
      for (const note of disc.notes ?? []) {
        if (note.system) continue
        comments.push({
          id: String(note.id),
          body: note.body,
          createdAt: note.created_at,
          updatedAt: note.updated_at ?? note.created_at,
          author: note.author?.username,
          ...(disc.notes && disc.notes[0] && note.id !== disc.notes[0].id
            ? { parentId: String(disc.notes[0].id) }
            : {}),
          ...(note.position
            ? { inline: { path: note.position.new_path ?? note.position.old_path ?? '', line: note.position.new_line ?? undefined } }
            : {}),
        })
      }
    }

    return {
      state: normalisePrState(mr.state),
      approvalCount: mr.upvotes ?? 0,
      commentCount: comments.length,
      comments,
    }
  }

  /**
   * Self-improvement writer escape hatch. Runs OUTSIDE `query()` so
   * the upstream MCP server is unreachable. We open the MR directly
   * via REST. Mirrors `pollPr` in keeping the surface minimal.
   */
  async writerCreatePr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    const apiBase = this.baseUrl ?? 'https://gitlab.com/api/v4'
    const projectPath = `${this.namespace}/${args.repoSlug}`
    const projectId = encodeURIComponent(projectPath)
    const body: Record<string, unknown> = {
      source_branch: args.sourceBranch,
      target_branch: args.targetBranch ?? 'main',
      title: args.title,
    }
    if (args.description !== undefined) body['description'] = args.description
    if (args.reviewers && args.reviewers.length > 0) {
      body['reviewer_ids'] = await this.resolveUserIds(apiBase, args.reviewers)
    }

    const res = await this.fetchImpl(`${apiBase}/projects/${projectId}/merge_requests`, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`gitlab writerCreatePr: ${res.status} ${res.statusText}: ${text}`)
    }
    const mr = (await res.json()) as GitLabMrPayload
    return buildExternalRef({
      kind: 'pull_request',
      pluginId: this.manifest.id,
      repoKey: args.repoSlug,
      externalId: mr.iid,
      url: mr.web_url,
    })
  }

  /**
   * Parses GitLab webhook payloads. Covers the most common shapes:
   * `Merge Request Hook`, `Note Hook` (for comments), and the wrapper
   * `Pipeline Hook` is skipped (returns null) since Coro doesn't track
   * pipelines through plugins yet.
   */
  override normalizeInbound(req: {
    headers: Record<string, string | string[] | undefined>
    rawBody: Buffer
  }): NormalizedEvent | null {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(req.rawBody.toString('utf-8')) as Record<string, unknown>
    } catch {
      return null
    }

    const eventName = readHeader(req.headers, 'x-gitlab-event') ?? ''
    const objectKind = typeof payload['object_kind'] === 'string' ? (payload['object_kind'] as string) : ''
    const project = payload['project'] as Record<string, unknown> | undefined
    const projectPath = typeof project?.['path_with_namespace'] === 'string'
      ? (project['path_with_namespace'] as string)
      : undefined
    const repoSlug = projectPath ? projectPath.split('/').pop() : undefined

    if (objectKind === 'merge_request' || eventName === 'Merge Request Hook') {
      const attrs = payload['object_attributes'] as Record<string, unknown> | undefined
      if (!attrs || (attrs['iid'] === undefined && attrs['id'] === undefined)) return null
      const iid = attrs['iid'] ?? attrs['id']
      const action = typeof attrs['action'] === 'string' ? (attrs['action'] as string) : ''
      const url = typeof attrs['url'] === 'string' ? (attrs['url'] as string) : undefined
      return {
        ref: buildExternalRef({
          kind: 'pull_request',
          pluginId: this.manifest.id,
          repoKey: repoSlug ?? 'unknown',
          externalId: iid,
          ...(url ? { url } : {}),
        }),
        kind: toGenericMrEvent(action),
        raw: payload,
        receivedAt: new Date().toISOString(),
      }
    }

    if (objectKind === 'note' || eventName === 'Note Hook') {
      const mr = payload['merge_request'] as Record<string, unknown> | undefined
      if (!mr) return null
      const iid = mr['iid'] ?? mr['id']
      if (iid === undefined) return null
      const url = typeof mr['url'] === 'string' ? (mr['url'] as string) : undefined
      return {
        ref: buildExternalRef({
          kind: 'pull_request',
          pluginId: this.manifest.id,
          repoKey: repoSlug ?? 'unknown',
          externalId: iid,
          ...(url ? { url } : {}),
        }),
        kind: 'pr.commented',
        raw: payload,
        receivedAt: new Date().toISOString(),
      }
    }

    return null
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private gitlabHost(): string {
    if (!this.baseUrl) return 'gitlab.com'
    try {
      return new URL(this.baseUrl).host
    } catch {
      return 'gitlab.com'
    }
  }

  private async resolveUserIds(apiBase: string, usernames: ReadonlyArray<string>): Promise<number[]> {
    const ids: number[] = []
    for (const username of usernames) {
      const res = await this.fetchImpl(`${apiBase}/users?username=${encodeURIComponent(username)}`, {
        headers: { 'PRIVATE-TOKEN': this.token },
      })
      if (!res.ok) continue
      const users = (await res.json()) as Array<{ id: number; username: string }>
      const match = users.find(u => u.username === username)
      if (match) ids.push(match.id)
    }
    return ids
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface GitLabMrPayload {
  iid: number
  state: string
  upvotes?: number
  web_url: string
}

interface GitLabDiscussion {
  id: string
  notes?: GitLabNote[]
}

interface GitLabNote {
  id: number
  body: string
  created_at: string
  updated_at?: string
  system?: boolean
  author?: { username: string }
  position?: { new_path?: string; old_path?: string; new_line?: number | null }
}

function parseRef(
  ref: ExternalRef,
  pluginId: string,
  namespace: string,
): { projectPath: string; mrIid: number } {
  if (ref.pluginId !== pluginId) {
    throw new Error(`gitlab plugin: refusing to operate on ref owned by "${ref.pluginId}"`)
  }
  if (!ref.repoKey) {
    throw new Error(`gitlab plugin: ref is missing repoKey for kind=${ref.kind}`)
  }
  const mrIid = Number(ref.externalId)
  if (Number.isNaN(mrIid)) {
    throw new Error(`gitlab plugin: ref.externalId "${ref.externalId}" is not a number`)
  }
  return { projectPath: `${namespace}/${ref.repoKey}`, mrIid }
}

function normalisePrState(s: string): ScmPrStatus['state'] {
  switch (s.toLowerCase()) {
    case 'opened':
    case 'open':
      return 'open'
    case 'merged':
      return 'merged'
    case 'closed':
      return 'declined'
    default:
      return 'open'
  }
}

function toGenericMrEvent(action: string): string {
  switch (action) {
    case 'open':
      return 'pr.opened'
    case 'close':
      return 'pr.declined'
    case 'merge':
      return 'pr.merged'
    case 'update':
      return 'pr.updated'
    case 'approved':
      return 'pr.approved'
    case 'review_requested':
      return 'pr.review_requested'
    default:
      return action ? `pr.${action}` : 'pr.updated'
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Loader entry point. The runner's drop-in plugin loader imports this
 * module and calls `createPlugin({ config, logger })` for each plugin
 * configured in `~/.coro/config.json`.
 */
export function createPlugin(_args: { config: Record<string, unknown> }): GitLabScmPlugin {
  return new GitLabScmPlugin()
}

export default createPlugin
