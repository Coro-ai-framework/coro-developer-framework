import type { Job } from '@coro-ai/cloud-protocol'
import type { Logger } from 'pino'
import {
  TICKET_STATUS_CATEGORIES,
  resolveTicketingPolicyDetailed,
  ticketingWritesEnabled,
  type ResolvedTicketEventAction,
  type ResolvedTicketingPolicy,
  type SourceTicketEvent,
  type TicketingConfig,
  type WorkItemTicketEvent,
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

// ── Describing the policy to an agent ────────────────────────────────────────
//
// The runner never writes to a tracker itself; it tells the agent what the
// policy asks for at the moment it matters. These helpers are the shared
// wording for the per-phase prompt block and the tool-result reminders.

export const SOURCE_EVENT_TRIGGERS: Record<SourceTicketEvent, string> = {
  jobStarted: 'At the start of the job, before other work',
  planReady: 'When the work-item list is registered (`set_work_items`)',
  prOpened: 'After each PR is opened (include the PR link)',
  awaitingInput: 'Before parking for developer input (`await_event` with `developer-input:`)',
  escalated: 'Before calling `escalate` (say what blocks the job)',
  jobCompleted: 'When the job finishes successfully (summarise what shipped, with PR links)',
  jobFailed: 'When you stop the job unsuccessfully without escalating',
}

export const WORK_ITEM_EVENT_TRIGGERS: Record<WorkItemTicketEvent, string> = {
  workItemStarted: 'Work item first marked `in-progress`',
  prOpened: 'The work item\'s PR is opened (include the link)',
  workItemCompleted: 'Work item marked `complete`',
  reworkRequested: 'Work item reopened for a fix (`incrementLoop: true`)',
  escalated: 'Work item marked `escalated`',
}

export function describeTicketStatus(status: string, policy: ResolvedTicketingPolicy): string {
  if ((TICKET_STATUS_CATEGORIES as readonly string[]).includes(status)) {
    const mapped = policy.statusMap[status]
    return mapped ? `"${mapped}"` : `the ticket's ${status} status`
  }
  return `"${status}"`
}

function labelList(labels: string[]): string {
  return labels.map(l => `\`${l}\``).join(', ')
}

/** `comment, move to "In Review"`, or undefined when the event does nothing. */
export function describeTicketAction(
  action: ResolvedTicketEventAction | undefined,
  policy: ResolvedTicketingPolicy,
): string | undefined {
  if (!action) return undefined
  const parts: string[] = []
  if (action.comment) parts.push('comment')
  if (action.status) parts.push(`move to ${describeTicketStatus(action.status, policy)}`)
  if (action.labels.add.length > 0) parts.push(`add ${labelList(action.labels.add)}`)
  if (action.labels.remove.length > 0) parts.push(`remove ${labelList(action.labels.remove)}`)
  return parts.length > 0 ? parts.join(', ') : undefined
}

export type WorkItemTicketsState =
  | { applies: false; reason: string }
  | { applies: true; pendingPlan: boolean }

/** Whether this job gets work-item tickets, judged from what is known now. */
export function workItemTicketsState(
  policy: ResolvedTicketingPolicy,
  job: Pick<Job, 'params' | 'workItems'>,
): WorkItemTicketsState {
  const wit = policy.workItemTickets
  if (!ticketingWritesEnabled(policy)) return { applies: false, reason: 'ticket writes are off' }
  if (wit.mode === 'off') return { applies: false, reason: 'workItemTickets.mode is off' }
  if (wit.requireSourceTicket && !sourceTicketOf(job.params)) {
    return { applies: false, reason: 'the job has no source ticket' }
  }
  const count = job.workItems?.length ?? 0
  if (count === 0) return { applies: true, pendingPlan: true }
  if (count < wit.minWorkItems) {
    return { applies: false, reason: `the plan has ${count} work item(s); tickets start at ${wit.minWorkItems}` }
  }
  return { applies: true, pendingPlan: false }
}
