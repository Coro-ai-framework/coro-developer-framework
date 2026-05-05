// ── Linear tracker plugin ────────────────────────────────────────────────────
//
// Wraps {@link LinearTrackerClient} in the {@link TrackerPluginRuntime}
// contract. Linear webhook normalisation is intentionally a no-op for
// v1 (read-only API only — see megaplan §8 "out of scope").

import { z } from 'zod'
import type { Logger } from 'pino'
import { LinearTrackerClient } from '../../../clients/tracker/linear'
import type { TrackerNotConfigured, TrackerResult } from '../../../clients/tracker/types'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  TrackerCommentArgs,
  TrackerCreateEpicArgs,
  TrackerCreateIssueArgs,
  TrackerIssue,
  TrackerLinkIssuesArgs,
  TrackerPluginRuntime,
  TrackerTransitionArgs,
} from '../../types'

function unwrap<T>(r: TrackerResult<T>): T {
  if (
    r !== null &&
    typeof r === 'object' &&
    'available' in (r as object) &&
    (r as TrackerNotConfigured).available === false
  ) {
    throw new Error(`linear plugin: tracker not available — ${(r as TrackerNotConfigured).reason}`)
  }
  return r as T
}

const linearConfigSchema = z.object({
  apiKey: z.string().min(1),
  /** Default Linear team key (e.g. "ENG"). */
  teamKey: z.string().optional(),
  apiUrl: z.string().optional(),
})

export type LinearPluginConfig = z.infer<typeof linearConfigSchema>

const MANIFEST: PluginManifest = {
  id: 'linear',
  kind: 'tracker',
  version: '1.0.0',
  displayName: 'Linear',
  hostCompatibility: '^1.0.0',
  configSchema: linearConfigSchema,
  capabilities: {
    supportsEpics: true,
    supportsLinks: true,
  },
  // Linear webhook support is a follow-up; we don't advertise a
  // descriptor at v1 so the cloud rejects webhook configuration for
  // this plugin until the feature lands.
}

class LinearTrackerPlugin implements TrackerPluginRuntime<LinearPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private client!: LinearTrackerClient

  async init(rawConfig: LinearPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = linearConfigSchema.parse(rawConfig)
    this.client = new LinearTrackerClient({
      apiKey: cfg.apiKey,
      ...(cfg.teamKey ? { defaultTeamKey: cfg.teamKey } : {}),
      ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
    })
  }

  async healthcheck(): Promise<PluginHealth> {
    return { ok: this.client.isAvailable() }
  }

  async dispose(): Promise<void> {}

  /** @internal */
  unsafeClient(): LinearTrackerClient { return this.client }

  async getIssue(key: string): Promise<TrackerIssue> {
    return unwrap(await this.client.getIssue(key))
  }

  async listChildren(parentKey: string): Promise<TrackerIssue[]> {
    return unwrap(await this.client.listChildren(parentKey))
  }

  async commentIssue(args: TrackerCommentArgs): Promise<void> {
    unwrap(await this.client.commentIssue(args))
  }

  async transitionIssue(args: TrackerTransitionArgs): Promise<void> {
    unwrap(await this.client.transitionIssue(args))
  }

  async createIssue(args: TrackerCreateIssueArgs): Promise<TrackerIssue> {
    return unwrap(await this.client.createIssue({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      ...(args.issueType ? { issueType: args.issueType } : {}),
      ...(args.parentKey ? { parentKey: args.parentKey } : {}),
      ...(args.labels ? { labels: [...args.labels] } : {}),
    }))
  }

  async createEpic(args: TrackerCreateEpicArgs): Promise<TrackerIssue> {
    return unwrap(await this.client.createEpic({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      ...(args.labels ? { labels: [...args.labels] } : {}),
    }))
  }

  async linkIssues(args: TrackerLinkIssuesArgs): Promise<void> {
    unwrap(await this.client.linkIssues(args))
  }
}

export function createLinearTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new LinearTrackerPlugin()
}
