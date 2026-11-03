import { describe, it, expect } from 'vitest'
import type { Job, WorkItem } from '@coro-ai/cloud-protocol'
import { resolveTicketingPolicy, type TicketingConfig } from '../../src/config/ticketing'
import { buildTicketingPromptBlock } from '../../src/prompt/ticketing-block'
import { ticketingReminders } from '../../src/jobs/ticketing-reminders'
import type { TrackerPromptContext } from '../../src/prompt/builder'
import { createMcpToolHandlers } from '../../src/mcp-handlers'
import { mcpTrackerBinding } from '../../src/trackers/binding'
import { makeMockToolContextWithSpies } from '../mcp/fixtures'

const ATLASSIAN: TrackerPromptContext = {
  available: true,
  pluginId: 'mcp:claude.ai Atlassian',
  source: 'mcp',
  provider: 'jira',
  displayName: 'Atlassian (Jira) via claude.ai Atlassian',
  tools: {
    getIssue: 'mcp__claude_ai_Atlassian__getJiraIssue',
    comment: 'mcp__claude_ai_Atlassian__addCommentToJiraIssue',
    createIssue: 'mcp__claude_ai_Atlassian__createJiraIssue',
  },
  notes: ['Every Jira call needs `cloudId`.'],
}

function wi(name: string, extra: Partial<WorkItem> = {}): WorkItem {
  return { name, status: 'pending', loopCount: 0, ...extra }
}

function job(config: TicketingConfig | undefined, extra: Partial<Job> & { params?: Record<string, unknown> } = {}): Job {
  return {
    id: 'job-1',
    type: 'job',
    phase: 'planning',
    workItems: [],
    phaseUsage: [],
    ...extra,
    params: {
      trackerRef: { kind: 'ticket', pluginId: 'jira', externalId: 'WS-1', url: 'https://x.atlassian.net/browse/WS-1' },
      ticketingPolicy: resolveTicketingPolicy(config),
      ...extra.params,
    },
  } as unknown as Job
}

describe('buildTicketingPromptBlock', () => {
  it('renders the default policy against an MCP tracker', () => {
    const block = buildTicketingPromptBlock(job(undefined), ATLASSIAN)!
    expect(block).toContain('# Ticket management')
    expect(block).toContain('`mcp__claude_ai_Atlassian__addCommentToJiraIssue`')
    expect(block).toContain('Every Jira call needs `cloudId`.')
    expect(block).toContain('## Source ticket: WS-1')
    expect(block).toMatch(/At the start of the job.*: comment\./)
    expect(block).toMatch(/After each PR is opened.*: comment\./)
    // Defaults never move a ticket and create no work-item tickets.
    expect(block).not.toMatch(/move to/)
    expect(block).not.toContain('## Work-item tickets')
    expect(block).toContain('This is the job\'s first phase')
    expect(block).toContain('starting with "Coro:"')
  })

  it('does not repeat the job-start nudge after the first phase', () => {
    const block = buildTicketingPromptBlock(job(undefined, { phaseUsage: [{} as never] }), ATLASSIAN)!
    expect(block).not.toContain('first phase')
  })

  it('maps status categories through statusMap', () => {
    const block = buildTicketingPromptBlock(
      job({ preset: 'status-sync', statusMap: { 'in-review': 'Code Review' } }),
      ATLASSIAN,
    )!
    expect(block).toContain('move to "Code Review"')
    expect(block).toContain('move to the ticket\'s in-progress status')
  })

  it('describes work-item sub-tickets when the subtasks preset applies', () => {
    const block = buildTicketingPromptBlock(
      job({ preset: 'subtasks', workItemTickets: { labels: ['coro', 'auto'], assignee: 'sourceAssignee' } }),
      ATLASSIAN,
    )!
    expect(block).toContain('## Work-item tickets')
    expect(block).toContain('Right after you register the work items')
    expect(block).toContain('as children of WS-1')
    expect(block).toContain('`coro`, `auto`')
    expect(block).toContain('assign them to the source ticket\'s assignee')
    expect(block).toContain('`mcp__claude_ai_Atlassian__createJiraIssue`')
    expect(block).toContain('Work item marked `complete`: comment, move to the ticket\'s done status.')
  })

  it('explains why there are no work-item tickets', () => {
    const block = buildTicketingPromptBlock(job({ preset: 'subtasks' }, { workItems: [wi('only')] }), ATLASSIAN)!
    expect(block).toContain('None for this job: the plan has 1 work item(s)')
  })

  it('lists tickets already recorded on work items', () => {
    const block = buildTicketingPromptBlock(
      job({ preset: 'subtasks' }, { workItems: [wi('a', { ticket: { key: 'WS-2' } }), wi('b')] }),
      ATLASSIAN,
    )!
    expect(block).toContain('- a: WS-2')
  })

  it('says writes are off when the policy disables them', () => {
    const block = buildTicketingPromptBlock(job({ enabled: false }), ATLASSIAN)!
    expect(block).toContain('Ticket writes are **off**')
    expect(block).not.toContain('## Source ticket')
  })

  it('tells the agent to skip tickets when no tracker is bound', () => {
    const block = buildTicketingPromptBlock(job(undefined), { available: false, pluginId: 'none', reason: 'no tracker plugin or tracker MCP server found' })!
    expect(block).toContain('No tracker is bound to this job (no tracker plugin or tracker MCP server found)')
  })

  it('offers to create a source ticket only in auto mode', () => {
    const noTicket = { params: { trackerRef: undefined } }
    expect(buildTicketingPromptBlock(job(undefined, noTicket), ATLASSIAN)).toContain('no source-ticket updates')
    const auto = buildTicketingPromptBlock(job({ createSourceTicket: { mode: 'auto', project: 'WS' } }, noTicket), ATLASSIAN)!
    expect(auto).toContain('create one in project WS')
    expect(auto).toContain('pluginId: "mcp:claude.ai Atlassian"')
  })

  it('is omitted for jobs without a policy snapshot or of another type', () => {
    expect(buildTicketingPromptBlock({ ...job(undefined), params: {} } as Job, ATLASSIAN)).toBeUndefined()
    expect(buildTicketingPromptBlock({ ...job(undefined), type: 'retrospective' } as unknown as Job, ATLASSIAN)).toBeUndefined()
  })
})

describe('ticketingReminders', () => {
  const subtasks: TicketingConfig = { preset: 'subtasks' }

  it('asks for work-item tickets once the plan is registered', () => {
    const j = job(subtasks, { workItems: [wi('a'), wi('b')] })
    const lines = ticketingReminders(j, { kind: 'workItemsSet' }, true)
    expect(lines.join('\n')).toMatch(/Create the work-item tickets now \(2 without one/)
  })

  it('names the work item ticket and action on status changes', () => {
    const before = wi('a', { status: 'in-progress', ticket: { key: 'WS-2' } })
    const after = { ...before, status: 'complete' as const }
    const lines = ticketingReminders(job(subtasks, { workItems: [after] }), { kind: 'workItemStatus', before, after }, true)
    expect(lines).toEqual(['WS-2: comment, move to the ticket\'s done status (Work item marked `complete`).'])
  })

  it('treats a reopened item as rework', () => {
    const before = wi('a', { status: 'complete', ticket: { key: 'WS-2' } })
    const after = { ...before, status: 'in-progress' as const, loopCount: 1 }
    const lines = ticketingReminders(
      job({ preset: 'subtasks', workItemTickets: { on: { reworkRequested: { comment: true } } } }),
      { kind: 'workItemStatus', before, after, incrementLoop: true },
      true,
    )
    expect(lines[0]).toMatch(/^WS-2: comment.*reopened/)
  })

  it('reminds about the source ticket when a PR opens', () => {
    const lines = ticketingReminders(job(undefined), { kind: 'prOpened', url: 'https://gh/pr/1' }, true)
    expect(lines).toEqual(['WS-1: comment, linking https://gh/pr/1 (PR opened).'])
  })

  it('stays quiet without a tracker or with writes off', () => {
    expect(ticketingReminders(job(undefined), { kind: 'prOpened' }, false)).toEqual([])
    expect(ticketingReminders(job({ enabled: false }), { kind: 'prOpened' }, true)).toEqual([])
  })
})

describe('work-item tools record tickets', () => {
  function setup(config: TicketingConfig | undefined) {
    const { ctx } = makeMockToolContextWithSpies()
    let stored = job(config)
    ctx.job = stored
    ctx.stateBackend = {
      ...ctx.stateBackend,
      getJob: async () => stored,
      updateJob: async (_id: string, patch: Partial<Job>) => {
        stored = { ...stored, ...patch } as Job
      },
    } as never
    ctx.trackerBinding = mcpTrackerBinding({
      name: 'claude.ai Atlassian',
      toolPrefix: 'mcp__claude_ai_Atlassian__',
      status: 'connected',
      url: 'https://mcp.atlassian.com/v1/mcp',
      tools: [],
    })
    return { ctx, h: createMcpToolHandlers(ctx, {}), current: () => stored }
  }

  it('accepts ticket keys in set_work_items and keeps them across a re-plan', async () => {
    const { h, current } = setup({ preset: 'subtasks' })
    await h.set_work_items({ workItems: [{ name: 'a', ticketKey: 'WS-2' }, 'b'] })
    expect(current().workItems[0]!.ticket).toEqual({ key: 'WS-2' })
    await h.set_work_items({ workItems: ['a', 'c'] })
    expect(current().workItems.map(w => w.ticket?.key)).toEqual(['WS-2', undefined])
  })

  it('records a ticket with update_work_item and returns the policy reminder', async () => {
    const { h, current } = setup({ preset: 'subtasks' })
    const set = await h.set_work_items({ workItems: ['a', 'b'] })
    expect(JSON.parse(set.content[0]!.text).ticketing.join('\n')).toContain('Create the work-item tickets now')
    await h.update_work_item({ name: 'a', ticketKey: 'WS-2', ticketUrl: 'https://x/WS-2' })
    expect(current().workItems[0]!.ticket).toEqual({ key: 'WS-2', url: 'https://x/WS-2' })
    const out = await h.update_work_item({ name: 'a', status: 'in-progress' })
    const body = JSON.parse(out.content[0]!.text)
    expect(body.ticketing).toEqual(['WS-2: move to the ticket\'s in-progress status (Work item first marked `in-progress`).'])
  })
})
