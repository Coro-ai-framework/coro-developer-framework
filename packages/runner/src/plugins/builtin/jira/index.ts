// ── Jira tracker plugin (MCP mode) ──────────────────────────────────────────
//
// After the MCP-first pivot, Jira's agent-facing operations come from an
// upstream Atlassian/Jira MCP server (attached via `mcpServer()`). This
// plugin keeps only the responsibilities MCP can't serve:
//
//   - `init`/`healthcheck`/`dispose` lifecycle      — plugin contract.
//   - `intelligenceRoot()`                          — markdown snippets
//                                                     for the agent.
//   - `mcpServer()`                                 — descriptor for the
//                                                     stdio MCP server.
//   - `normalizeInbound()`                          — Jira webhooks have
//                                                     no MCP equivalent.
//
// All read/write methods (`getIssue`, `commentIssue`, `transitionIssue`,
// `createIssue`, `createEpic`, `linkIssues`, `listChildren`) are dropped
// — the upstream MCP server serves them as `mcp__jira__*` tools.
//
// The hybrid `tracker_*` proxy (mcp-handlers.ts) is reshaped in S4 to
// forward calls through the SDK's MCP client.

import { z } from 'zod'
import path from 'node:path'
import type { Logger } from 'pino'
import type { NormalizedEvent } from '@coro-ai/cloud-protocol'
import { externalIdString } from '../../refs'
import type {
  PluginDeps,
  PluginHealth,
  PluginTestResult,
  PluginManifest,
  PluginMcpServerConfig,
  TrackerComment,
  TrackerCommentArgs,
  TrackerIssue,
  TrackerPluginRuntime,
} from '../../types'
import { JiraTrackerClient } from '../../../clients/tracker/jira'
import type { TrackerNotConfigured, TrackerResult } from '../../../clients/tracker/types'

// ── Config ───────────────────────────────────────────────────────────────────

const jiraConfigSchema = z.object({
  baseUrl: z.string().min(1),
  username: z.string().min(1),
  apiToken: z.string().min(1),
})

export type JiraPluginConfig = z.infer<typeof jiraConfigSchema>

// Curated allowlist of upstream MCP tools exposed to the agent. Mirrors
// the agent procedures in `intelligence-base/.../agents/*.md`.
//
// Tool names follow the conventions of the most-deployed community
// Jira MCP servers (`mcp-atlassian`, `@cosmix/jira-mcp`). When we
// switch to a different upstream the names map across the same
// canonical operations, so the curation set stays portable.
const DEFAULT_ALLOWED_MCP_TOOLS: ReadonlyArray<string> = [
  // Read
  'jira_get_issue',
  'jira_search_issues',
  'jira_list_children',
  'jira_get_user_profile',
  'jira_search_user',
  // Write
  'jira_create_issue',
  'jira_create_epic',
  'jira_update_issue',
  'jira_add_comment',
  'jira_transition_issue',
  'jira_link_issues',
]

const MANIFEST: PluginManifest = {
  id: 'jira',
  kind: 'tracker',
  version: '2.0.0',
  displayName: 'Jira',
  hostCompatibility: '^1.0.0',
  configSchema: jiraConfigSchema,
  capabilities: {
    supportsEpics: true,
    supportsLinks: true,
  },
  allowedMcpTools: DEFAULT_ALLOWED_MCP_TOOLS,
  mcpToolMap: {
    tracker_get_issue: 'jira_get_issue',
    tracker_comment_issue: 'jira_add_comment',
    tracker_transition_issue: 'jira_transition_issue',
  },
  webhook: {
    // Atlassian webhooks don't carry an HMAC by default — they rely on
    // a secret embedded in the URL. The verifier treats `'none'` as
    // "skip HMAC; rely on URL secret + tenant-scoped routing".
    algorithm: 'none',
    header: 'authorization',
    format: '<plain>',
  },
  intelligence: {
    snippets: [
      { id: 'jira-transitions', relativePath: 'snippets/jira-transitions.md' },
    ],
  },
  ui: {
    subtitle: 'Atlassian Cloud or Data Center. API token auth.',
  },
  auth: {
    methods: [
      {
        kind: 'form',
        id: 'manual',
        label: 'API token',
        recommended: true,
        fields: [
          {
            key: 'baseUrl',
            label: 'Base URL',
            kind: 'url',
            placeholder: 'https://acme.atlassian.net',
            required: true,
          },
          {
            key: 'username',
            label: 'Email',
            kind: 'text',
            placeholder: 'you@example.com',
            required: true,
          },
          {
            key: 'apiToken',
            label: 'API token',
            kind: 'secret',
            placeholder: 'ATATT…',
            required: true,
          },
        ],
      },
    ],
  },
}

// ── Runtime ──────────────────────────────────────────────────────────────────

class JiraTrackerPlugin implements TrackerPluginRuntime<JiraPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private baseUrl!: string
  private username!: string
  private apiToken!: string
  private available = false
  private trackerClient!: JiraTrackerClient

  async init(rawConfig: JiraPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = jiraConfigSchema.parse(rawConfig)
    this.baseUrl = cfg.baseUrl
    this.username = cfg.username
    this.apiToken = cfg.apiToken
    this.available = Boolean(cfg.baseUrl && cfg.username && cfg.apiToken)
    this.trackerClient = new JiraTrackerClient({
      baseUrl: cfg.baseUrl,
      username: cfg.username,
      apiToken: cfg.apiToken,
    })
  }

  async healthcheck(): Promise<PluginHealth> {
    return this.available
      ? { ok: true }
      : { ok: false, reason: 'jira plugin: missing baseUrl/username/apiToken' }
  }

  /**
   * Real credential probe. `healthcheck` only checks that the three fields
   * are non-empty, which would pass a typo'd site URL or an expired token —
   * the dashboard would report success and the first job would fail.
   */
  async testConnection(config: JiraPluginConfig | Record<string, unknown>): Promise<PluginTestResult> {
    const parsed = jiraConfigSchema.safeParse(config)
    if (!parsed.success) {
      return { ok: false, message: 'Site URL, e-mail, and API token are all required.' }
    }
    const { baseUrl, username, apiToken } = parsed.data
    const url = `${baseUrl.replace(/\/$/, '')}/rest/api/3/myself`
    const auth = Buffer.from(`${username}:${apiToken}`).toString('base64')
    try {
      const res = await globalThis.fetch(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      })
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: `Jira rejected the credentials (${res.status}).`,
          hint: 'API tokens are created at id.atlassian.com and pair with your account e-mail, not your password.',
        }
      }
      if (!res.ok) {
        return {
          ok: false,
          message: `Jira returned ${res.status}.`,
          hint: `Check the site URL is correct — it should look like https://your-team.atlassian.net`,
        }
      }
      const body = (await res.json()) as { displayName?: string; emailAddress?: string }
      const who = body.displayName ?? body.emailAddress ?? username
      return { ok: true, message: `Connected to Jira as ${who}` }
    } catch (err) {
      return {
        ok: false,
        message: 'Could not reach Jira.',
        hint: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async dispose(): Promise<void> {}

  intelligenceRoot(): string | undefined {
    return path.join(__dirname, 'intelligence')
  }

  /**
   * Descriptor for the upstream Jira MCP server. Defaults to the
   * popular community `mcp-atlassian` package run via `uvx`, which
   * reads `JIRA_URL` / `JIRA_USERNAME` / `JIRA_API_TOKEN` env vars.
   *
   * Operators on different MCP servers (Atlassian's hosted SSE
   * endpoint, `@cosmix/jira-mcp`, …) can override by adapting the
   * plugin install entry in `~/.coro/config.json` once the v1.5
   * drop-in loader exposes mcp overrides — until then, this default
   * is what ships out of the box.
   */
  mcpServer(): PluginMcpServerConfig {
    return {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-atlassian'],
      env: {
        JIRA_URL: this.baseUrl,
        JIRA_USERNAME: this.username,
        JIRA_API_TOKEN: this.apiToken,
        // Disable the Confluence half of the server — Coro only needs
        // Jira tools attached for now.
        CONFLUENCE_DISABLED: 'true',
      },
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

  /**
   * Post a comment natively via the Jira REST client (not the upstream
   * MCP `jira_add_comment` tool) so we can pass `parentId` for threaded
   * replies — the MCP server does not expose that field.
   */
  async commentIssue(args: TrackerCommentArgs): Promise<void> {
    unwrapTrackerResult(await this.trackerClient.commentIssue({
      key: args.key,
      body: args.body,
      ...(args.parentId ? { parentId: args.parentId } : {}),
    }))
  }

  // ── Webhook normalisation ───────────────────────────────────────────────

  normalizeInbound(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): NormalizedEvent | null {
    void req.headers
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(req.rawBody.toString('utf-8')) as Record<string, unknown>
    } catch {
      return null
    }
    const issue = payload['issue'] as Record<string, unknown> | undefined
    const key = typeof issue?.['key'] === 'string' ? (issue['key'] as string) : undefined
    if (!key) return null
    const eventName =
      (typeof payload['webhookEvent'] === 'string' ? (payload['webhookEvent'] as string) : undefined) ??
      (typeof payload['issue_event_type_name'] === 'string' ? (payload['issue_event_type_name'] as string) : undefined) ??
      'unknown'
    return {
      ref: {
        kind: 'ticket',
        pluginId: this.manifest.id,
        externalId: externalIdString(key),
      },
      kind: toGenericTicketEvent(eventName),
      raw: payload,
      receivedAt: new Date().toISOString(),
    }
  }
}

function toGenericTicketEvent(name: string): string {
  if (name.includes('comment')) return 'ticket.commented'
  if (name.includes('updated') || name.includes('transition')) return 'ticket.transitioned'
  if (name.includes('created')) return 'ticket.created'
  if (name.includes('deleted')) return 'ticket.deleted'
  return `ticket.${name}`
}

function unwrapTrackerResult<T>(result: TrackerResult<T>): T {
  if (typeof result === 'object' && result !== null && 'available' in result && (result as TrackerNotConfigured).available === false) {
    throw new Error((result as TrackerNotConfigured).reason)
  }
  return result as T
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createJiraTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new JiraTrackerPlugin()
}
