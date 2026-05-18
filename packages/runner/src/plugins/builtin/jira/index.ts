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
}

// ── Runtime ──────────────────────────────────────────────────────────────────

class JiraTrackerPlugin implements TrackerPluginRuntime<JiraPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private baseUrl!: string
  private username!: string
  private apiToken!: string
  private available = false

  async init(rawConfig: JiraPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = jiraConfigSchema.parse(rawConfig)
    this.baseUrl = cfg.baseUrl
    this.username = cfg.username
    this.apiToken = cfg.apiToken
    this.available = Boolean(cfg.baseUrl && cfg.username && cfg.apiToken)
  }

  async healthcheck(): Promise<PluginHealth> {
    return this.available
      ? { ok: true }
      : { ok: false, reason: 'jira plugin: missing baseUrl/username/apiToken' }
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

// ── Factory ──────────────────────────────────────────────────────────────────

export function createJiraTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new JiraTrackerPlugin()
}
