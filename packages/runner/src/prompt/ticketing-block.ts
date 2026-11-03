// ── Ticket management prompt block ───────────────────────────────────────────
//
// The ticketing policy is the team's decision about what Coro may do to its
// tickets. The runner does not act on it; it renders it here, every phase,
// as instructions the agent follows with whatever tracker tools are bound.
// Everything the policy does not list is off-limits, so the block is also
// the boundary: an agent that reads it has no reason to improvise.

import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { SOURCE_TICKET_EVENTS, WORK_ITEM_TICKET_EVENTS, ticketingWritesEnabled, type ResolvedTicketingPolicy } from '../config/ticketing'
import {
  SOURCE_EVENT_TRIGGERS,
  WORK_ITEM_EVENT_TRIGGERS,
  describeTicketAction,
  readTicketingPolicy,
  sourceTicketOf,
  workItemTicketsState,
  type SourceTicket,
} from '../jobs/ticketing'
import type { TrackerPromptContext } from './builder'

function trackerLines(tracker: TrackerPromptContext): string[] {
  const lines = [`Tracker: ${tracker.displayName ?? tracker.pluginId} (\`${tracker.pluginId}\`).`]
  if (tracker.source === 'mcp' && tracker.tools) {
    lines.push('Call its tools directly; the `tracker_*` tools only point back at these.')
    for (const [op, tool] of Object.entries(tracker.tools)) lines.push(`- ${op}: \`${tool}\``)
  } else {
    lines.push(
      'Use the `tracker_*` tools for reads, comments, and transitions. For creating or linking tickets use the ' +
      `plugin's own \`mcp__${tracker.pluginId}__*\` tools (its snippet lists them).`,
    )
  }
  for (const note of tracker.notes ?? []) lines.push(`- Note: ${note}`)
  return lines
}

function assigneeText(assignee: string): string {
  if (assignee === 'none') return 'leave them unassigned'
  if (assignee === 'sourceAssignee') return 'assign them to the source ticket\'s assignee'
  if (assignee === 'sourceReporter') return 'assign them to the source ticket\'s reporter'
  return `assign them to account \`${assignee}\``
}

function workItemTicketLines(
  policy: ResolvedTicketingPolicy,
  job: Job,
  source: SourceTicket | undefined,
  tracker: TrackerPromptContext,
  pendingPlan: boolean,
): string[] {
  const wit = policy.workItemTickets
  const unit = wit.grouping === 'repo' ? 'repository (work items in the same repository share one)' : 'work item'
  const when = pendingPlan
    ? 'Right after you register the work items with `set_work_items`'
    : 'If they do not exist yet'
  const lines: string[] = []

  if (wit.mode === 'checklist') {
    lines.push(
      `${when}, post one comment on ${source?.key ?? 'the source ticket'} with a checklist of the work items. ` +
      'Do not create tickets. On each event below, update that checklist (edit the comment, or re-post it if editing is not possible).',
    )
  } else {
    const target = wit.mode === 'subtasks'
      ? `as children of ${source?.key ?? 'the source ticket'}`
      : `linked to ${source?.key ?? 'the source ticket'} ("relates to")`
    const type = wit.issueType ? `type "${wit.issueType}"` : wit.mode === 'subtasks' ? 'the tracker\'s sub-task type' : 'the project\'s default type'
    const project = wit.project ? `project ${wit.project}` : 'the source ticket\'s project'
    lines.push(
      `${when}, create one ticket per ${unit}, ${target}: ${type}, in ${project}, at most ${wit.maxPerJob} for the job.`,
    )
    lines.push('- Summary: the work item name. Description: its goal and acceptance criteria from the plan.')
    const details: string[] = []
    if (wit.labels.length > 0) details.push(`add labels ${wit.labels.map(l => `\`${l}\``).join(', ')}`)
    details.push(assigneeText(wit.assignee))
    if (Object.keys(wit.fields).length > 0) details.push(`set these fields verbatim: \`${JSON.stringify(wit.fields)}\``)
    lines.push(`- ${details.join('; ')}.`.replace(/^- ./, c => c.toUpperCase()))
    if (wit.reuseExisting) {
      lines.push('- Before creating, look for an existing ticket with the same summary under the source ticket and reuse it.')
    }
    if (wit.mode === 'subtasks') {
      lines.push(
        '- If the source ticket cannot have children (for example it is itself a sub-task), create linked tickets instead and `log` that you did.',
      )
    }
    if (tracker.tools?.['createIssue']) lines.push(`- Create with \`${tracker.tools['createIssue']}\`.`)
    lines.push('- Record each key on its work item: `update_work_item({ name, ticketKey, ticketUrl })`.')
  }

  const events = WORK_ITEM_TICKET_EVENTS
    .map(e => [e, describeTicketAction(wit.on[e], policy)] as const)
    .filter((row): row is readonly [typeof row[0], string] => Boolean(row[1]))
  if (events.length > 0) {
    lines.push('', 'Then, on each work item\'s ticket:')
    for (const [e, action] of events) {
      lines.push(`- ${WORK_ITEM_EVENT_TRIGGERS[e]}: ${wit.mode === 'checklist' ? 'update the checklist' : action}.`)
    }
  }

  const ticketed = (job.workItems ?? []).filter(w => w.ticket?.key)
  if (ticketed.length > 0) {
    lines.push('', 'Tickets already recorded:')
    for (const w of ticketed) lines.push(`- ${w.name}: ${w.ticket!.key}`)
  }
  return lines
}

function conventionLines(policy: ResolvedTicketingPolicy, hasTicket: boolean): string[] {
  const lines = [
    '- To move a ticket, read its available transitions first and take the one that lands in the target status. ' +
    'If none does, leave the status alone and `log` it; never pick a different status instead.',
  ]
  const mapped = Object.entries(policy.statusMap)
  if (mapped.length > 0) {
    lines.push(`- This team's status names: ${mapped.map(([k, v]) => `${k} → "${v}"`).join(', ')}.`)
  }
  const c = policy.comments
  const length = c.verbosity === 'brief' ? 'one or two sentences' : 'a short paragraph with links and what changed'
  const prefix = c.prefix ? `, starting with "${c.prefix}"` : ''
  const language = c.language === 'auto' ? 'in the ticket\'s language' : `in ${c.language}`
  lines.push(`- Comments: ${length}${prefix}, ${language}. Skip an update that is already on the ticket (a resumed or retried phase).`)

  if (hasTicket) {
    const key = 'the ticket key (the work item\'s, else the source ticket\'s)'
    if (policy.linking.branchName) lines.push(`- Branch names carry ${key} after the prefix: \`feature/WS-123-<service>-<description>\`.`)
    if (policy.linking.prTitle) lines.push(`- PR titles start with ${key}.`)
    if (policy.linking.prBody) lines.push('- PR descriptions link the ticket(s).')
  }
  return lines
}

export function buildTicketingPromptBlock(job: Job, tracker?: TrackerPromptContext): string | undefined {
  if (job.type !== JobType.Job) return undefined
  const policy = readTicketingPolicy(job)
  if (!policy) return undefined
  const source = sourceTicketOf(job.params)
  const lines: string[] = ['# Ticket management', '']

  if (!tracker?.available) {
    lines.push(
      `No tracker is bound to this job${tracker?.reason ? ` (${tracker.reason})` : ''}. ` +
      'Skip every ticket step, and do not go looking for tracker tools yourself.',
    )
    return lines.join('\n')
  }

  lines.push(...trackerLines(tracker), '')

  if (!ticketingWritesEnabled(policy)) {
    lines.push(
      'Ticket writes are **off** for this job. Reading tickets is fine; do not comment on, transition, create, or edit any.',
    )
    return lines.join('\n')
  }

  lines.push(
    'Follow this policy exactly. It is the team\'s `ticketing` config: anything it does not list (other comments, ' +
    'transitions, new tickets, field edits) is not yours to do. Reading tickets is always fine.',
  )

  if (source) {
    lines.push('', `## Source ticket: ${source.key}${source.url ? ` (${source.url})` : ''}`, '')
    const events = SOURCE_TICKET_EVENTS
      .map(e => [e, describeTicketAction(policy.sourceTicket.on[e], policy)] as const)
      .filter((row): row is readonly [typeof row[0], string] => Boolean(row[1]))
    if (events.length === 0) lines.push('No updates on any event.')
    for (const [e, action] of events) lines.push(`- ${SOURCE_EVENT_TRIGGERS[e]}: ${action}.`)
    const firstPhase = (job.phaseUsage?.length ?? 0) === 0
    if (firstPhase && describeTicketAction(policy.sourceTicket.on.jobStarted, policy)) {
      lines.push('', 'This is the job\'s first phase: make the job-start update now.')
    }
    if (policy.read.commentsAtPhaseStart) {
      lines.push(`At the start of this phase, read ${source.key}'s comments for new guidance.`)
    }
  } else if (policy.createSourceTicket.mode === 'auto') {
    const cst = policy.createSourceTicket
    lines.push(
      '',
      '## Source ticket',
      '',
      `This job has no source ticket. During planning, create one${cst.project ? ` in project ${cst.project}` : ''}` +
      `${cst.issueType ? ` of type "${cst.issueType}"` : ''} describing the job, then record it with ` +
      `\`set_job_params({ trackerRef: { kind: "ticket", pluginId: "${tracker.pluginId}", externalId: "<key>", url: "<url>" } })\`. ` +
      'From then on, the source-ticket events apply to it.',
    )
  } else {
    lines.push('', 'This job has no source ticket, so there are no source-ticket updates.')
  }

  const state = workItemTicketsState(policy, job)
  if (policy.workItemTickets.mode !== 'off') {
    lines.push('', '## Work-item tickets', '')
    if (!state.applies) lines.push(`None for this job: ${state.reason}.`)
    else lines.push(...workItemTicketLines(policy, job, source, tracker, state.pendingPlan))
  }

  lines.push('', '## How', '', ...conventionLines(policy, Boolean(source) || state.applies))
  return lines.join('\n')
}
