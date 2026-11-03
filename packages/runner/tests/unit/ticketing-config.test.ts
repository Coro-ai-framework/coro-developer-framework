import { describe, it, expect } from 'vitest'
import {
  describeTicketingPresets,
  resolveTicketingPolicy,
  resolveTicketingPolicyDetailed,
  ticketingConfigSchema,
  ticketProjectFromKey,
  type TicketingConfig,
} from '../../src/config/ticketing'
import { validateLocalConfig } from '../../src/config/local-config'
import { computeTicketingPolicySnapshot, sourceTicketOf, TICKETING_POLICY_PARAM } from '../../src/jobs/ticketing'

describe('resolveTicketingPolicy — defaults', () => {
  it('with no config, reads and comments but never transitions or creates', () => {
    const p = resolveTicketingPolicy(undefined)
    expect(p.enabled).toBe(true)
    expect(p.tracker).toBe('auto')
    expect(p.preset).toBe('minimal')
    expect(p.read).toEqual({ planMode: true, jobs: true, commentsAtPhaseStart: false })
    expect(p.linking).toEqual({ branchName: true, prTitle: true, prBody: true })
    expect(p.sourceTicket.on.jobStarted).toEqual({ comment: true, status: null, labels: { add: [], remove: [] } })
    expect(p.sourceTicket.on.planReady.comment).toBe(false)
    expect(p.sourceTicket.on.awaitingInput.comment).toBe(false)
    for (const action of Object.values(p.sourceTicket.on)) expect(action.status).toBeNull()
    expect(p.sourceTicket.on.jobCompleted).toMatchObject({ comment: true, status: null })
    expect(p.workItemTickets.mode).toBe('off')
    expect(p.createSourceTicket.mode).toBe('off')
    expect(p.appliedOverrides).toEqual([])
    expect(p.runOverride).toBe(false)
  })

  it('returns a fresh object every time', () => {
    const a = resolveTicketingPolicy(undefined)
    a.workItemTickets.labels.push('mutated')
    expect(resolveTicketingPolicy(undefined).workItemTickets.labels).toEqual(['coro'])
  })
})

describe('resolveTicketingPolicy — presets', () => {
  it('status-sync moves the source ticket but leaves completion alone', () => {
    const p = resolveTicketingPolicy({ preset: 'status-sync' })
    expect(p.preset).toBe('status-sync')
    expect(p.sourceTicket.on.jobStarted).toMatchObject({ comment: true, status: 'in-progress' })
    expect(p.sourceTicket.on.prOpened).toMatchObject({ comment: true, status: 'in-review' })
    expect(p.sourceTicket.on.jobCompleted.status).toBeNull()
    expect(p.workItemTickets.mode).toBe('off')
  })

  it('subtasks turns on work-item tickets with status sync', () => {
    const p = resolveTicketingPolicy({ preset: 'subtasks' })
    expect(p.workItemTickets.mode).toBe('subtasks')
    expect(p.workItemTickets.requireSourceTicket).toBe(true)
    expect(p.workItemTickets.minWorkItems).toBe(2)
    expect(p.workItemTickets.on.workItemStarted.status).toBe('in-progress')
    expect(p.workItemTickets.on.workItemCompleted.status).toBe('done')
  })

  it('explicit fields win over the preset', () => {
    const p = resolveTicketingPolicy({
      preset: 'status-sync',
      sourceTicket: { on: { jobStarted: { status: null }, jobCompleted: { status: 'Ready for QA' } } },
    })
    expect(p.sourceTicket.on.jobStarted.status).toBeNull()
    expect(p.sourceTicket.on.jobStarted.comment).toBe(true)
    expect(p.sourceTicket.on.prOpened.status).toBe('in-review')
    expect(p.sourceTicket.on.jobCompleted.status).toBe('Ready for QA')
  })

  it('describeTicketingPresets expands every preset', () => {
    const presets = describeTicketingPresets()
    expect(Object.keys(presets).sort()).toEqual(['custom', 'minimal', 'status-sync', 'subtasks'])
    expect(presets.subtasks.workItemTickets.mode).toBe('subtasks')
    expect(presets.minimal.workItemTickets.mode).toBe('off')
  })
})

describe('resolveTicketingPolicy — overrides and run patch', () => {
  const config: TicketingConfig = {
    statusMap: { done: 'Done' },
    workItemTickets: { fields: { components: [{ name: 'Backend' }] } },
    overrides: [
      { match: { project: 'WS' }, preset: 'subtasks', statusMap: { 'in-review': 'Code Review' } },
      { match: { repo: 'acme/payments' }, sourceTicket: { on: { jobCompleted: { status: 'done' } } }, statusMap: { 'in-review': 'Peer Review' } },
      { match: { repo: 'other/thing' }, enabled: false },
    ],
  }

  it('applies nothing when no override matches', () => {
    const p = resolveTicketingPolicy(config, { repo: 'acme/web', ticketProject: 'OPS-1' })
    expect(p.appliedOverrides).toEqual([])
    expect(p.workItemTickets.mode).toBe('off')
    expect(p.statusMap).toEqual({ done: 'Done' })
  })

  it('matches project from a full ticket key, case-insensitively', () => {
    const p = resolveTicketingPolicy(config, { ticketProject: 'ws-4088' })
    expect(p.appliedOverrides).toEqual(['project:WS'])
    expect(p.preset).toBe('subtasks')
    expect(p.workItemTickets.mode).toBe('subtasks')
    expect(p.statusMap).toEqual({ done: 'Done', 'in-review': 'Code Review' })
  })

  it('applies repo overrides before project overrides', () => {
    const p = resolveTicketingPolicy(config, { repo: 'acme/payments', ticketProject: 'WS-1' })
    expect(p.appliedOverrides).toEqual(['repo:acme/payments', 'project:WS'])
    expect(p.statusMap['in-review']).toBe('Code Review')
    expect(p.sourceTicket.on.jobCompleted.status).toBe('done')
  })

  it('matches a bare repo slug against owner/repo', () => {
    const p = resolveTicketingPolicy({ overrides: [{ match: { repo: 'payments' }, enabled: false }] }, { repo: 'acme/payments' })
    expect(p.enabled).toBe(false)
  })

  it('replaces fields wholesale instead of merging stale keys', () => {
    const p = resolveTicketingPolicy(
      { workItemTickets: { fields: { components: [{ name: 'Backend' }], priority: 'High' } } },
      { runOverride: { workItemTickets: { fields: { priority: 'Low' } } } },
    )
    expect(p.workItemTickets.fields).toEqual({ priority: 'Low' })
  })

  it('applies the per-run patch last and records it', () => {
    const p = resolveTicketingPolicy(config, { ticketProject: 'WS-1', runOverride: { preset: 'minimal', workItemTickets: { mode: 'off' } } })
    expect(p.workItemTickets.mode).toBe('off')
    expect(p.preset).toBe('minimal')
    expect(p.runOverride).toBe(true)
  })

  it('ignores an invalid per-run patch and reports why', () => {
    const r = resolveTicketingPolicyDetailed(undefined, { runOverride: { sourceTicket: { on: { jobStartd: { comment: false } } } } })
    expect(r.policy.runOverride).toBe(false)
    expect(r.policy.sourceTicket.on.jobStarted.comment).toBe(true)
    expect(r.runOverrideError).toBeTruthy()
  })
})

describe('ticketing schema', () => {
  it('rejects a misspelled event name', () => {
    expect(ticketingConfigSchema.safeParse({ sourceTicket: { on: { jobStartd: { comment: true } } } }).success).toBe(false)
  })

  it('rejects an override without a match key', () => {
    expect(ticketingConfigSchema.safeParse({ overrides: [{ match: {}, enabled: false }] }).success).toBe(false)
  })

  it('accepts the documented example and round-trips through the local config schema', () => {
    const ticketing = {
      enabled: true,
      tracker: 'mcp:claude_ai_Atlassian',
      preset: 'status-sync',
      workItemTickets: { mode: 'subtasks', grouping: 'repo', issueType: null, assignee: 'sourceAssignee', labels: ['coro'] },
      statusMap: { 'in-progress': 'In Progress' },
      overrides: [{ match: { project: 'WS' }, preset: 'subtasks' }],
    }
    const result = validateLocalConfig({ ticketing })
    expect(result.success).toBe(true)
  })

  it('local config without a ticketing block stays valid', () => {
    expect(validateLocalConfig({}).success).toBe(true)
  })
})

describe('ticketProjectFromKey', () => {
  it.each([
    ['WS-4088', 'WS'],
    ['eng-42', 'ENG'],
    ['acme/web#7', 'acme/web'],
    ['not a key', undefined],
    [undefined, undefined],
  ])('%s → %s', (key, project) => {
    expect(ticketProjectFromKey(key)).toBe(project)
  })
})

describe('job ticketing snapshot', () => {
  it('reads the source ticket from every ref shape', () => {
    expect(sourceTicketOf({ trackerRef: { kind: 'ticket', pluginId: 'jira', externalId: 'WS-1', url: 'u' } }))
      .toEqual({ key: 'WS-1', url: 'u', pluginId: 'jira' })
    expect(sourceTicketOf({ trackerRef: { pluginId: 'linear', key: 'ENG-2', url: '' } })).toEqual({ key: 'ENG-2', pluginId: 'linear' })
    expect(sourceTicketOf({ jiraTicketId: 'OPS-3' })).toEqual({ key: 'OPS-3', pluginId: 'jira' })
    expect(sourceTicketOf({})).toBeUndefined()
  })

  it('resolves against the job repo, ticket, and run patch', () => {
    const policy = computeTicketingPolicySnapshot(
      { id: 'j1', params: { repo: 'acme/payments', trackerRef: { externalId: 'WS-9' }, ticketing: { comments: { verbosity: 'detailed' } } } },
      { overrides: [{ match: { project: 'WS' }, preset: 'subtasks' }] },
    )
    expect(policy?.appliedOverrides).toEqual(['project:WS'])
    expect(policy?.comments.verbosity).toBe('detailed')
  })

  it('does not replace an existing snapshot', () => {
    const existing = resolveTicketingPolicy(undefined)
    expect(computeTicketingPolicySnapshot({ id: 'j1', params: { [TICKETING_POLICY_PARAM]: existing } }, { enabled: false })).toBeUndefined()
  })
})
