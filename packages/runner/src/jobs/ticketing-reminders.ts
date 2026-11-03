// ── Ticketing reminders in tool results ──────────────────────────────────────
//
// The prompt block states the whole policy once per phase; by the time a
// work item flips to `complete` forty turns later it is easy to forget.
// The tools that mark those moments (`set_work_items`, `update_work_item`,
// `scm_create_pr`) echo the matching policy line in their result, so the
// reminder lands exactly when the agent can act on it.

import type { Job, WorkItem } from '@coro-ai/cloud-protocol'
import { ticketingWritesEnabled, type WorkItemTicketEvent } from '../config/ticketing'
import {
  WORK_ITEM_EVENT_TRIGGERS,
  describeTicketAction,
  readTicketingPolicy,
  sourceTicketOf,
  workItemTicketsState,
} from './ticketing'

export type TicketingTrigger =
  | { kind: 'workItemsSet' }
  | { kind: 'workItemStatus'; before?: WorkItem; after: WorkItem; incrementLoop?: boolean }
  | { kind: 'prOpened'; url?: string }

function workItemEvent(before: WorkItem | undefined, after: WorkItem, incrementLoop?: boolean): WorkItemTicketEvent | undefined {
  if (before?.status === after.status && !incrementLoop) return undefined
  switch (after.status) {
    case 'in-progress':
      if (incrementLoop || before?.status === 'complete' || (before && after.loopCount > before.loopCount)) return 'reworkRequested'
      return 'workItemStarted'
    case 'complete':
      return 'workItemCompleted'
    case 'escalated':
      return 'escalated'
    default:
      return undefined
  }
}

/**
 * Policy lines that apply to what just happened, or an empty list. Only
 * produced when a tracker is bound and the policy allows writes at all.
 */
export function ticketingReminders(
  job: Pick<Job, 'params' | 'workItems' | 'currentWorkItem'>,
  trigger: TicketingTrigger,
  trackerBound: boolean,
): string[] {
  const policy = readTicketingPolicy(job)
  if (!policy || !trackerBound || !ticketingWritesEnabled(policy)) return []
  const source = sourceTicketOf(job.params)
  const wit = policy.workItemTickets
  const out: string[] = []

  if (trigger.kind === 'workItemsSet') {
    const planReady = describeTicketAction(policy.sourceTicket.on.planReady, policy)
    if (source && planReady) out.push(`${source.key}: ${planReady} (plan ready).`)
    const state = workItemTicketsState(policy, job)
    const missing = (job.workItems ?? []).filter(w => !w.ticket?.key)
    if (state.applies && missing.length > 0) {
      out.push(
        wit.mode === 'checklist'
          ? `Post the work-item checklist on ${source?.key ?? 'the source ticket'} now.`
          : `Create the work-item tickets now (${missing.length} without one; see "Work-item tickets" in your instructions) ` +
            'and record each with `update_work_item({ name, ticketKey, ticketUrl })`.',
      )
    }
    return out
  }

  if (trigger.kind === 'workItemStatus') {
    const event = workItemEvent(trigger.before, trigger.after, trigger.incrementLoop)
    if (!event) return out
    const action = describeTicketAction(wit.on[event], policy)
    if (!action) return out
    if (wit.mode === 'checklist' && source) {
      out.push(`${source.key}: update the work-item checklist (${WORK_ITEM_EVENT_TRIGGERS[event]}).`)
    } else if (wit.mode !== 'off' && trigger.after.ticket?.key) {
      out.push(`${trigger.after.ticket.key}: ${action} (${WORK_ITEM_EVENT_TRIGGERS[event]}).`)
    }
    return out
  }

  const link = trigger.url ? `, linking ${trigger.url}` : ''
  const sourceAction = describeTicketAction(policy.sourceTicket.on.prOpened, policy)
  if (source && sourceAction) out.push(`${source.key}: ${sourceAction}${link} (PR opened).`)
  const current = (job.workItems ?? []).find(w => w.name === job.currentWorkItem)
  const wiAction = describeTicketAction(wit.on.prOpened, policy)
  if (wit.mode !== 'off' && wit.mode !== 'checklist' && current?.ticket?.key && wiAction) {
    out.push(`${current.ticket.key}: ${wiAction}${link} (PR opened).`)
  }
  return out
}
