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
  TrackerComment,
  TrackerCommentArgs,
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
  ui: {
    subtitle: 'Linear API key. Fast issue tracker for product teams.',
  },
  auth: {
    methods: [
      {
        kind: 'form',
        id: 'manual',
        label: 'API key',
        recommended: true,
        fields: [
          {
            key: 'apiKey',
            label: 'API key',
            kind: 'secret',
            placeholder: 'lin_api_…',
            hint: 'Generate in Linear → Settings → API → Personal API keys.',
            required: true,
          },
          {
            key: 'teamKey',
            label: 'Default team key',
            kind: 'text',
            placeholder: 'ENG',
            hint: "Optional. Picks the team Coro files issues against when a job doesn't specify one.",
          },
        ],
      },
    ],
  },
}

class LinearTrackerPlugin implements TrackerPluginRuntime<LinearPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private apiKey!: string
  private apiUrl?: string
  private teamKey?: string
  private available = false
  private trackerClient!: LinearTrackerClient

  async init(rawConfig: LinearPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = linearConfigSchema.parse(rawConfig)
    this.apiKey = cfg.apiKey
    this.apiUrl = cfg.apiUrl
    this.teamKey = cfg.teamKey
    this.available = Boolean(cfg.apiKey)
    this.trackerClient = new LinearTrackerClient({
      apiKey: cfg.apiKey,
      ...(cfg.teamKey ? { defaultTeamKey: cfg.teamKey } : {}),
      ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
    })
  }

  /**
   * Linear surfaces its configured default team key so the campaign-planner
   * can pass `team: tracker.defaults.teamKey` without re-deriving it from
   * the spec on every job.
   */
  promptDefaults(): Record<string, string> | undefined {
    if (!this.teamKey) return undefined
    return { teamKey: this.teamKey }
  }

  async healthcheck(): Promise<PluginHealth> {
    return this.available
      ? { ok: true }
      : { ok: false, reason: 'linear plugin: missing apiKey' }
  }

  async dispose(): Promise<void> {}

  async testConnection(): Promise<import('../../types').PluginTestResult> {
    const result = await this.trackerClient.searchIssues('', 1)
    if (
      typeof result === 'object' &&
      result !== null &&
      'available' in result &&
      (result as TrackerNotConfigured).available === false
    ) {
      return { ok: false, message: (result as TrackerNotConfigured).reason }
    }
    return { ok: true, message: 'Authenticated with Linear.' }
  }

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

  async getComments(key: string): Promise<TrackerComment[]> {
    return unwrapTrackerResult(await this.trackerClient.getComments(key))
  }

  /**
   * Post a comment natively via the Linear GraphQL client (not the
   * upstream MCP `create_comment` tool) so `parentId` reaches
   * `commentCreate` and the reply threads under its parent.
   */
  async commentIssue(args: TrackerCommentArgs): Promise<void> {
    unwrapTrackerResult(await this.trackerClient.commentIssue({
      key: args.key,
      body: args.body,
      ...(args.parentId ? { parentId: args.parentId } : {}),
    }))
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
