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
import type { NormalizedEvent } from '@coro/cloud-protocol'
import { externalIdString } from '../../refs'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  PluginMcpServerConfig,
  TrackerPluginRuntime,
} from '../../types'

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
}

class GitHubTrackerPlugin implements TrackerPluginRuntime<GitHubTrackerPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private token!: string
  private apiBaseUrl?: string
  private available = false

  async init(rawConfig: GitHubTrackerPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = ghTrackerConfigSchema.parse(rawConfig)
    this.token = cfg.token
    this.apiBaseUrl = cfg.apiBaseUrl
    this.available = Boolean(cfg.token && cfg.defaultOwner)
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

export function createGitHubTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new GitHubTrackerPlugin()
}
