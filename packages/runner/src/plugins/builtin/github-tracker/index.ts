// ── GitHub Issues tracker plugin ─────────────────────────────────────────────
//
// Same shape as the Jira plugin but registered under id `github-issues`
// so a tenant can run BB-as-SCM + GH-as-Tracker without conflict.

import { z } from 'zod'
import type { Logger } from 'pino'
import { GitHubTrackerClient } from '../../../clients/tracker/github'
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
    throw new Error(`github-issues plugin: tracker not available — ${(r as TrackerNotConfigured).reason}`)
  }
  return r as T
}

const ghTrackerConfigSchema = z.object({
  token: z.string().min(1),
  /** Default `<owner>` for `projectKey`s passed as bare repo names. */
  defaultOwner: z.string().min(1),
  defaultRepo: z.string().optional(),
  apiBaseUrl: z.string().optional(),
})

export type GitHubTrackerPluginConfig = z.infer<typeof ghTrackerConfigSchema>

const MANIFEST: PluginManifest = {
  id: 'github-issues',
  kind: 'tracker',
  version: '1.0.0',
  displayName: 'GitHub Issues',
  hostCompatibility: '^1.0.0',
  configSchema: ghTrackerConfigSchema,
  capabilities: {
    supportsEpics: true,
    supportsLinks: true,
  },
  webhook: {
    algorithm: 'hmac-sha256',
    header: 'X-Hub-Signature-256',
    format: 'sha256=<hex>',
  },
}

class GitHubTrackerPlugin implements TrackerPluginRuntime<GitHubTrackerPluginConfig> {
  readonly manifest = MANIFEST
  readonly kind = 'tracker' as const

  private client!: GitHubTrackerClient

  async init(rawConfig: GitHubTrackerPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = ghTrackerConfigSchema.parse(rawConfig)
    this.client = new GitHubTrackerClient({
      token: cfg.token,
      defaultOwner: cfg.defaultOwner,
      ...(cfg.defaultRepo ? { defaultRepo: cfg.defaultRepo } : {}),
      ...(cfg.apiBaseUrl ? { apiBaseUrl: cfg.apiBaseUrl } : {}),
    })
  }

  async healthcheck(): Promise<PluginHealth> {
    return { ok: this.client.isAvailable() }
  }

  async dispose(): Promise<void> {}

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

export function createGitHubTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new GitHubTrackerPlugin()
}
