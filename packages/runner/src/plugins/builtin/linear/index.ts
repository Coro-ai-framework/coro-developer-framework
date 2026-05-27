// ── Linear tracker plugin (MCP mode) ────────────────────────────────────────
//
// After the MCP-first pivot, Linear's agent-facing operations come from
// Linear's official MCP server (`@linear/mcp-server`), attached to every
// job session via `mcpServer()`. The plugin keeps only:
//
//   - lifecycle (`init`/`healthcheck`/`dispose`)
//   - `intelligenceRoot()` — markdown snippets
//   - `mcpServer()` — descriptor for the upstream MCP server
//
// All read/write methods are dropped — the upstream MCP serves them as
// `mcp__linear__*` tools. Linear webhook normalisation remains a no-op
// for v1 (out of scope; revisit when the Linear → Coro webhook flow is
// designed).

import { z } from 'zod'
import path from 'node:path'
import type { Logger } from 'pino'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  PluginMcpServerConfig,
  TrackerIssue,
  TrackerPluginRuntime,
} from '../../types'
import { LinearTrackerClient } from '../../../clients/tracker/linear'
import type { TrackerNotConfigured, TrackerResult } from '../../../clients/tracker/types'

// ── Config ───────────────────────────────────────────────────────────────────

const linearConfigSchema = z.object({
  apiKey: z.string().min(1),
  /** Default Linear team key (e.g. "ENG"). */
  teamKey: z.string().optional(),
  apiUrl: z.string().optional(),
})

export type LinearPluginConfig = z.infer<typeof linearConfigSchema>

const DEFAULT_ALLOWED_MCP_TOOLS: ReadonlyArray<string> = [
  // Read
  'list_issues',
  'get_issue',
  'list_projects',
  'list_teams',
  // Write
  'create_issue',
  'update_issue',
  'create_comment',
  // Linear's "epic" is just a parent issue, no separate API.
]

const MANIFEST: PluginManifest = {
  id: 'linear',
  kind: 'tracker',
  version: '2.0.0',
  displayName: 'Linear',
  hostCompatibility: '^1.0.0',
  configSchema: linearConfigSchema,
  capabilities: {
    supportsEpics: true,
    supportsLinks: true,
  },
  allowedMcpTools: DEFAULT_ALLOWED_MCP_TOOLS,
  mcpToolMap: {
    tracker_get_issue: 'get_issue',
    tracker_comment_issue: 'create_comment',
    tracker_transition_issue: 'update_issue',
  },
  // Linear webhook support is a follow-up; we don't advertise a
  // descriptor at v1 so the cloud rejects webhook configuration for
  // this plugin until the feature lands.
  intelligence: {
    snippets: [
      { id: 'linear-keys', relativePath: 'snippets/linear-keys.md' },
    ],
  },
}

class LinearTrackerPlugin implements TrackerPluginRuntime<LinearPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private apiKey!: string
  private apiUrl?: string
  private available = false
  private trackerClient!: LinearTrackerClient

  async init(rawConfig: LinearPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = linearConfigSchema.parse(rawConfig)
    this.apiKey = cfg.apiKey
    this.apiUrl = cfg.apiUrl
    this.available = Boolean(cfg.apiKey)
    this.trackerClient = new LinearTrackerClient({
      apiKey: cfg.apiKey,
      ...(cfg.teamKey ? { defaultTeamKey: cfg.teamKey } : {}),
      ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
    })
  }

  async healthcheck(): Promise<PluginHealth> {
    return this.available
      ? { ok: true }
      : { ok: false, reason: 'linear plugin: missing apiKey' }
  }

  async dispose(): Promise<void> {}

  intelligenceRoot(): string | undefined {
    return path.join(__dirname, 'intelligence')
  }

  /**
   * Descriptor for the upstream Linear MCP server. Defaults to the
   * official `@linear/mcp-server` package which reads
   * `LINEAR_API_KEY` from the env.
   */
  mcpServer(): PluginMcpServerConfig {
    const env: Record<string, string> = { LINEAR_API_KEY: this.apiKey }
    if (this.apiUrl) env.LINEAR_API_URL = this.apiUrl
    return {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@linear/mcp-server'],
      env,
    }
  }

  async getIssue(key: string): Promise<TrackerIssue> {
    return unwrapTrackerResult(await this.trackerClient.getIssue(key))
  }

  async searchIssues(query: string, limit?: number): Promise<TrackerIssue[]> {
    return unwrapTrackerResult(await this.trackerClient.searchIssues(query, limit))
  }
}

function unwrapTrackerResult<T>(result: TrackerResult<T>): T {
  if (typeof result === 'object' && result !== null && 'available' in result && (result as TrackerNotConfigured).available === false) {
    throw new Error((result as TrackerNotConfigured).reason)
  }
  return result as T
}

export function createLinearTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new LinearTrackerPlugin()
}
