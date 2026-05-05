// ── Jira tracker plugin ──────────────────────────────────────────────────────
//
// Wraps the existing {@link JiraTrackerClient} (and the legacy
// {@link JiraClient}) in the {@link TrackerPluginRuntime} contract.
//
// Two clients live underneath because the legacy {@link JiraClient}
// (in `clients/jira.ts`) is the read-skewed spec-writer flow; the new
// tracker client owns the campaign-planner write paths. Both are
// reachable via the plugin so the upstream consumers can move over
// gradually.

import { z } from 'zod'
import path from 'node:path'
import type { Logger } from 'pino'
import { JiraClient } from './legacy-client'
import { JiraTrackerClient } from '../../../clients/tracker/jira'
import type { TrackerNotConfigured, TrackerResult } from '../../../clients/tracker/types'
import {
  externalIdString,
  type NormalizedEvent,
} from '../../refs'
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

/**
 * Narrow a `TrackerResult<T>` to `T`, throwing the upstream
 * `unavailable` reason when the legacy client reports the tracker is
 * not configured. The plugin contract is "throw on failure", so we
 * bridge here.
 */
function unwrap<T>(r: TrackerResult<T>): T {
  if (
    r !== null &&
    typeof r === 'object' &&
    'available' in (r as object) &&
    (r as TrackerNotConfigured).available === false
  ) {
    throw new Error(`jira plugin: tracker not available — ${(r as TrackerNotConfigured).reason}`)
  }
  return r as T
}

// ── Config ───────────────────────────────────────────────────────────────────

const jiraConfigSchema = z.object({
  baseUrl: z.string().min(1),
  username: z.string().min(1),
  apiToken: z.string().min(1),
})

export type JiraPluginConfig = z.infer<typeof jiraConfigSchema>

const MANIFEST: PluginManifest = {
  id: 'jira',
  kind: 'tracker',
  version: '1.0.0',
  displayName: 'Jira',
  hostCompatibility: '^1.0.0',
  configSchema: jiraConfigSchema,
  capabilities: {
    supportsEpics: true,
    supportsLinks: true,
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

  private tracker!: JiraTrackerClient
  private legacy!: JiraClient

  async init(rawConfig: JiraPluginConfig | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = jiraConfigSchema.parse(rawConfig)
    this.tracker = new JiraTrackerClient(cfg)
    this.legacy = new JiraClient(cfg)
  }

  async healthcheck(): Promise<PluginHealth> {
    return { ok: this.tracker.isAvailable() }
  }

  async dispose(): Promise<void> {}

  intelligenceRoot(): string | undefined {
    return path.join(__dirname, 'intelligence')
  }

  /** @internal */
  unsafeTrackerClient(): JiraTrackerClient { return this.tracker }
  /** @internal */
  unsafeLegacyClient(): JiraClient { return this.legacy }

  // ── Read ────────────────────────────────────────────────────────────────

  async getIssue(key: string): Promise<TrackerIssue> {
    return unwrap(await this.tracker.getIssue(key))
  }

  async listChildren(parentKey: string): Promise<TrackerIssue[]> {
    return unwrap(await this.tracker.listChildren(parentKey))
  }

  // ── Write ───────────────────────────────────────────────────────────────

  async commentIssue(args: TrackerCommentArgs): Promise<void> {
    unwrap(await this.tracker.commentIssue(args))
  }

  async transitionIssue(args: TrackerTransitionArgs): Promise<void> {
    unwrap(await this.tracker.transitionIssue(args))
  }

  async createIssue(args: TrackerCreateIssueArgs): Promise<TrackerIssue> {
    return unwrap(await this.tracker.createIssue({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      ...(args.issueType ? { issueType: args.issueType } : {}),
      ...(args.parentKey ? { parentKey: args.parentKey } : {}),
      ...(args.labels ? { labels: [...args.labels] } : {}),
    }))
  }

  async createEpic(args: TrackerCreateEpicArgs): Promise<TrackerIssue> {
    return unwrap(await this.tracker.createEpic({
      projectKey: args.projectKey,
      summary: args.summary,
      description: args.description,
      ...(args.labels ? { labels: [...args.labels] } : {}),
    }))
  }

  async linkIssues(args: TrackerLinkIssuesArgs): Promise<void> {
    unwrap(await this.tracker.linkIssues(args))
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
      kind: this.toGenericTicketEvent(eventName),
      raw: payload,
      receivedAt: new Date().toISOString(),
    }
  }

  private toGenericTicketEvent(name: string): string {
    if (name.includes('comment')) return 'ticket.commented'
    if (name.includes('updated') || name.includes('transition')) return 'ticket.transitioned'
    if (name.includes('created')) return 'ticket.created'
    if (name.includes('deleted')) return 'ticket.deleted'
    return `ticket.${name}`
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createJiraTrackerPlugin(_args: { config: Record<string, unknown>; logger: Logger }): TrackerPluginRuntime {
  return new JiraTrackerPlugin()
}
