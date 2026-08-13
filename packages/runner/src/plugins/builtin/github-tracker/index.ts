// ── GitHub Issues tracker plugin (MCP mode) ────────────────────────────────
//
// Same shape as the other tracker plugins post-pivot: registers under
// `github-issues` so a tenant can run BB-as-SCM + GH-as-Tracker without
// an id collision, and points its `mcpServer()` at the same upstream
// `@modelcontextprotocol/server-github` MCP server the SCM plugin uses.
//
// Note: when both `github` (SCM) and `github-issues` (tracker) are
// installed, the runner attaches **two distinct MCP server instances**
// — once under `mcp__github__*` and once under `mcp__github-issues__*`.
// This intentional duplication keeps the resolution rules simple
// (one plugin id ⇒ one MCP server) and lets each side curate its own
// `allowedMcpTools` list (issues-only for the tracker, PRs-only for
// the SCM).

import { z } from 'zod'
import path from 'node:path'
import type { Logger } from 'pino'
import type { NormalizedEvent } from '@coro-ai/cloud-protocol'
import { externalIdString } from '../../refs'
import type {
  CredentialCandidate,
  PluginDeps,
  PluginHealth,
  PluginManifest,
  PluginMcpServerConfig,
  PluginTestResult,
  TrackerComment,
  TrackerIssue,
  TrackerPluginRuntime,
} from '../../types'
import { detectGitHubCredentials } from '../github/detect'
import { registerGitHubOAuthRoutes } from '../github/oauth-routes'
import { loadLocalConfig } from '../../../config/local-config'
import { GitHubTrackerClient } from '../../../clients/tracker/github'
import type { TrackerNotConfigured, TrackerResult } from '../../../clients/tracker/types'

// ── Config ───────────────────────────────────────────────────────────────────

const ghTrackerConfigSchema = z.object({
  token: z.string().min(1),
  /** Default `<owner>` for `projectKey`s passed as bare repo names. */
  defaultOwner: z.string().min(1),
  defaultRepo: z.string().optional(),
  apiBaseUrl: z.string().optional(),
})

export type GitHubTrackerPluginConfig = z.infer<typeof ghTrackerConfigSchema>

// Tracker-side curation: keep only the issue-flavoured tools so the
// agent is not confused by the SCM-side PR tools (those are surfaced
// by the `github` SCM plugin under `mcp__github__*`).
const DEFAULT_ALLOWED_MCP_TOOLS: ReadonlyArray<string> = [
  'create_issue',
  'get_issue',
  'list_issues',
  'update_issue',
  'add_issue_comment',
  'get_issue_comments',
  'search_issues',
]

const MANIFEST: PluginManifest = {
  id: 'github-issues',
  kind: 'tracker',
  version: '2.0.0',
  displayName: 'GitHub Issues',
  hostCompatibility: '^1.0.0',
  configSchema: ghTrackerConfigSchema,
  capabilities: {
    supportsEpics: true,
    supportsLinks: true,
  },
  allowedMcpTools: DEFAULT_ALLOWED_MCP_TOOLS,
  mcpToolMap: {
    tracker_get_issue: 'get_issue',
    tracker_get_comments: 'get_issue_comments',
    tracker_comment_issue: 'add_issue_comment',
    tracker_transition_issue: 'update_issue',
  },
  webhook: {
    algorithm: 'hmac-sha256',
    header: 'X-Hub-Signature-256',
    format: 'sha256=<hex>',
  },
  intelligence: {
    snippets: [
      { id: 'github-issues-keys', relativePath: 'snippets/github-issues-keys.md' },
    ],
  },
  ui: {
    subtitle: 'Reuse your GitHub credentials to track work in repo issues.',
  },
  auth: {
    methods: [
      {
        kind: 'detect',
        id: 'gh-cli',
        label: 'Use existing GitHub CLI session',
        recommended: true,
        accountConfigKey: 'defaultOwner',
      },
      {
        kind: 'oauth',
        id: 'device-oauth',
        label: 'Sign in with GitHub',
        startPath: '/config/plugins/github-issues/auth/device-oauth/start',
        statusPath: '/config/plugins/github-issues/auth/device-oauth/status',
      },
      {
        kind: 'form',
        id: 'manual',
        label: 'Personal access token',
        fields: [
          {
            key: 'defaultOwner',
            label: 'Owner / organisation',
            kind: 'text',
            placeholder: 'acme-inc',
            hint: 'The org or user that owns the repos you file issues against.',
            required: true,
          },
          {
            key: 'token',
            label: 'Personal access token',
            kind: 'secret',
            placeholder: 'ghp_… or github_pat_…',
            hint: "Needs the 'repo' scope. The same token used for source control works.",
            required: true,
          },
        ],
      },
    ],
  },
}

class GitHubTrackerPlugin implements TrackerPluginRuntime<GitHubTrackerPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private token!: string
  private apiBaseUrl?: string
  private defaultOwner?: string
  private available = false
  private fetchFn: typeof fetch = globalThis.fetch
  private trackerClient!: GitHubTrackerClient

  async init(rawConfig: GitHubTrackerPluginConfig | Record<string, unknown>, deps: PluginDeps): Promise<void> {
    const cfg = ghTrackerConfigSchema.parse(rawConfig)
    this.token = cfg.token
    this.apiBaseUrl = cfg.apiBaseUrl
    this.defaultOwner = cfg.defaultOwner
    this.fetchFn = deps.fetch
    this.available = Boolean(cfg.token && cfg.defaultOwner)
    this.trackerClient = new GitHubTrackerClient({
      token: cfg.token,
      defaultOwner: cfg.defaultOwner,
      ...(cfg.defaultRepo ? { defaultRepo: cfg.defaultRepo } : {}),
      ...(cfg.apiBaseUrl ? { apiBaseUrl: cfg.apiBaseUrl } : {}),
    })
  }

  async detectCredentials(): Promise<ReadonlyArray<CredentialCandidate>> {
    const candidates: CredentialCandidate[] = []

    const localCfg = loadLocalConfig()
    const scmCfg = (localCfg?.plugins?.installed?.github?.config ?? {}) as Record<string, unknown>
    const scmOwner = typeof scmCfg['owner'] === 'string' ? scmCfg['owner'] : ''
    const scmToken = typeof scmCfg['token'] === 'string' ? scmCfg['token'] : ''
    if (scmOwner && scmToken) {
      candidates.push({
        id: 'github-issues-from-scm',
        sourceLabel: 'GitHub source control plugin',
        accountHint: scmOwner,
        config: { defaultOwner: scmOwner, token: scmToken },
        preview: [
          { label: 'Account', value: scmOwner },
          { label: 'Token', value: '…(redacted)' },
        ],
      })
    }

    for (const detected of await detectGitHubCredentials(this.fetchFn)) {
      const owner = typeof detected.config['owner'] === 'string' ? detected.config['owner'] : ''
      const token = typeof detected.config['token'] === 'string' ? detected.config['token'] : ''
      if (!owner || !token) continue
      candidates.push({
        ...detected,
        id: detected.id.replace(/^github-/, 'github-issues-'),
        config: { defaultOwner: owner, token },
      })
    }

    return candidates
  }

  registerHttpRoutes(ctx: import('@coro-ai/plugin-sdk').PluginHttpRoutesContext): void {
    registerGitHubOAuthRoutes(ctx, {
      pluginId: 'github-issues',
      ownerConfigKey: 'defaultOwner',
    })
  }

  async testConnection(config: GitHubTrackerPluginConfig | Record<string, unknown>): Promise<PluginTestResult> {
    try {
      const cfg = ghTrackerConfigSchema.parse(config)
      const fetchFn = this.fetchFn ?? globalThis.fetch
      const res = await fetchFn('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'coro-runner',
        },
      })
      if (!res.ok) {
        return { ok: false, message: `GitHub API returned ${res.status}. Check your token.` }
      }
      const user = (await res.json()) as { login?: string }
      return {
        ok: true,
        message: user.login ? `Authenticated as ${user.login}.` : 'Authenticated.',
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * GitHub Issues surfaces the configured default owner so the
   * campaign-planner can fill `owner` on `mcp__github-issues__*` tool
   * calls without re-deriving it from the spec.
   */
  promptDefaults(): Record<string, string> | undefined {
    if (!this.defaultOwner) return undefined
    return { owner: this.defaultOwner }
  }

  async healthcheck(): Promise<PluginHealth> {
    return this.available
      ? { ok: true }
      : { ok: false, reason: 'github-issues plugin: missing token/defaultOwner' }
  }

  async dispose(): Promise<void> {}

  intelligenceRoot(): string | undefined {
    return path.join(__dirname, 'intelligence')
  }

  /**
   * Descriptor for the upstream `@modelcontextprotocol/server-github`
   * MCP server. Shared with the `github` SCM plugin — when both are
   * installed, the runner spawns two child processes (one per plugin
   * id) so each side can run its own curated tool allowlist without
   * leaking PR-tools into the tracker scope or vice versa.
   *
   * Operators that want to consolidate to a single child process can
   * uninstall one of the plugins; resolution will fail loudly if a
   * job tries to use the missing kind, which is the desired behaviour.
   */
  mcpServer(): PluginMcpServerConfig {
    const env: Record<string, string> = {
      GITHUB_PERSONAL_ACCESS_TOKEN: this.token,
    }
    if (this.apiBaseUrl) env.GITHUB_API_URL = this.apiBaseUrl
    return {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env,
    }
  }

  async getIssue(key: string): Promise<TrackerIssue> {
    return unwrapTrackerResult(await this.trackerClient.getIssue(key))
  }

  async searchIssues(query: string, limit?: number): Promise<TrackerIssue[]> {
    return unwrapTrackerResult(await this.trackerClient.searchIssues(query, limit))
  }

  async getComments(key: string): Promise<TrackerComment[]> {
    return unwrapTrackerResult(await this.trackerClient.getComments(key))
  }

  // ── Webhook normalisation ───────────────────────────────────────────────

  normalizeInbound(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): NormalizedEvent | null {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(req.rawBody.toString('utf-8')) as Record<string, unknown>
    } catch {
      return null
    }

    const eventName = pickHeader(req.headers, 'x-github-event') ?? 'unknown'
    const action = typeof payload['action'] === 'string' ? (payload['action'] as string) : ''
    const issue = payload['issue'] as Record<string, unknown> | undefined

    // The `issue_comment` event ships PR comments as well — we filter
    // those out by checking for the presence of `pull_request` on the
    // issue payload. The SCM plugin's `normalizeInbound` claims the
    // PR-side comment events.
    const isPrComment =
      eventName === 'issue_comment' &&
      issue?.['pull_request'] !== undefined
    if (isPrComment) return null

    if (issue && (issue['number'] !== undefined || issue['id'] !== undefined)) {
      const issueId = issue['number'] ?? issue['id']
      const url = typeof issue['html_url'] === 'string' ? (issue['html_url'] as string) : undefined
      const repo = payload['repository'] as Record<string, unknown> | undefined
      const repoFullName = typeof repo?.['full_name'] === 'string' ? (repo['full_name'] as string) : ''
      // Tracker `ExternalRef`s use `<owner>/<repo>#<number>` as the
      // composite key so the runner can disambiguate when an org has
      // many repos.
      const externalId = repoFullName
        ? `${repoFullName}#${externalIdString(issueId)}`
        : externalIdString(issueId)
      return {
        ref: {
          kind: 'ticket',
          pluginId: this.manifest.id,
          externalId,
          ...(url ? { url } : {}),
        },
        kind: toGenericTicketEvent(eventName, action),
        raw: payload,
        receivedAt: new Date().toISOString(),
      }
    }

    return null
  }
}

function toGenericTicketEvent(name: string, action: string): string {
  if (name === 'issues') {
    if (action === 'opened') return 'ticket.created'
    if (action === 'closed') return 'ticket.transitioned'
    if (action === 'reopened') return 'ticket.transitioned'
    if (action === 'labeled' || action === 'unlabeled') return 'ticket.transitioned'
    return `ticket.${action || 'updated'}`
  }
  if (name === 'issue_comment') return 'ticket.commented'
  return `ticket.${name}`
}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

function unwrapTrackerResult<T>(result: TrackerResult<T>): T {
  if (typeof result === 'object' && result !== null && 'available' in result && (result as TrackerNotConfigured).available === false) {
    throw new Error((result as TrackerNotConfigured).reason)
  }
  return result as T
}

export function createGitHubTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new GitHubTrackerPlugin()
}
