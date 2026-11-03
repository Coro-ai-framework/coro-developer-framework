import type { Job } from '@coro-ai/cloud-protocol'
import type { Logger } from 'pino'
import {
  resolveTicketingPolicyDetailed,
  type ResolvedTicketingPolicy,
  type TicketingConfig,
} from '../config/ticketing'

export const TICKETING_POLICY_PARAM = 'ticketingPolicy'

export interface SourceTicket {
  key: string
  url?: string
  pluginId?: string
}

/**
 * The ticket a job is attached to. Webhook-triggered jobs carry an
 * `ExternalRef` (`externalId`), campaign children a `TrackerRef` (`key`),
 * and pre-plugin callers a bare `jiraTicketId`.
 */
export function sourceTicketOf(params: Record<string, unknown>): SourceTicket | undefined {
  const ref = params['trackerRef']
  if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
    const r = ref as Record<string, unknown>
    const key = typeof r['externalId'] === 'string' ? r['externalId'] : typeof r['key'] === 'string' ? r['key'] : ''
    if (key.trim()) {
      return {
        key: key.trim(),
        ...(typeof r['url'] === 'string' && r['url'] ? { url: r['url'] } : {}),
        ...(typeof r['pluginId'] === 'string' && r['pluginId'] ? { pluginId: r['pluginId'] } : {}),
      }
    }
  }
  const legacy = params['jiraTicketId']
  return typeof legacy === 'string' && legacy.trim() ? { key: legacy.trim(), pluginId: 'jira' } : undefined
}

function repoOf(params: Record<string, unknown>): string | undefined {
  for (const key of ['repo', 'repoSlug']) {
    const v = params[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

export function readTicketingPolicy(job: Pick<Job, 'params'>): ResolvedTicketingPolicy | undefined {
  const raw = job.params[TICKETING_POLICY_PARAM]
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as ResolvedTicketingPolicy : undefined
}

/**
 * Resolve the policy for a job that does not carry one yet. The snapshot
 * is what every phase reads, so a config edit mid-job cannot change what
 * a running job does to its tickets.
 */
export function computeTicketingPolicySnapshot(
  job: Pick<Job, 'id' | 'params'>,
  config: TicketingConfig | undefined | null,
  logger?: Logger,
): ResolvedTicketingPolicy | undefined {
  if (readTicketingPolicy(job)) return undefined
  const repo = repoOf(job.params)
  const ticket = sourceTicketOf(job.params)
  const { policy, runOverrideError } = resolveTicketingPolicyDetailed(config, {
    ...(repo ? { repo } : {}),
    ...(ticket ? { ticketProject: ticket.key } : {}),
    runOverride: job.params['ticketing'],
  })
  if (runOverrideError) {
    logger?.warn({ jobId: job.id, error: runOverrideError }, 'Ignoring invalid params.ticketing for this run')
  }
  return policy
}
