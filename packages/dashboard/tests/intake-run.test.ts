import { describe, expect, it } from 'vitest'
import {
  createsSourceTicket,
  inspectRun,
  parseRun,
  runTicketParams,
  ticketUpdatesOf,
  withCreateSourceTicket,
  withTicketUpdates,
} from '../src/lib/intake-run'
import { toIntakeMessages } from '../src/lib/intake-stream'

const WORKFLOW = '.claude/commands/coro/job.md'

function runBlock(extra: Record<string, unknown>): string {
  return `<run>${JSON.stringify({
    repo: 'acme/payments',
    serviceName: 'payments',
    description: 'Add idempotency keys to the refund endpoint.',
    reviewers: ['alice'],
    workflowPath: WORKFLOW,
    interactive: true,
    ...extra,
  })}</run>`
}

describe('parseRun ticket fields', () => {
  it('reads trackerRef and ticketing', () => {
    const run = parseRun(
      runBlock({
        trackerRef: { pluginId: 'mcp:claude.ai Atlassian', externalId: ' WS-12 ', url: 'https://x.atlassian.net/browse/WS-12' },
        ticketing: { preset: 'subtasks' },
      }),
      [WORKFLOW],
    )
    expect(run?.trackerRef).toEqual({
      pluginId: 'mcp:claude.ai Atlassian',
      externalId: 'WS-12',
      url: 'https://x.atlassian.net/browse/WS-12',
    })
    expect(run?.ticketing).toEqual({ preset: 'subtasks' })
  })

  it('accepts `key` for the ticket and drops empty or malformed fields', () => {
    expect(parseRun(runBlock({ trackerRef: { key: 'WS-3' } }), [WORKFLOW])?.trackerRef).toEqual({ externalId: 'WS-3' })
    const run = parseRun(runBlock({ trackerRef: { externalId: '' }, ticketing: {} }), [WORKFLOW])
    expect(run).not.toHaveProperty('trackerRef')
    expect(run).not.toHaveProperty('ticketing')
    expect(parseRun(runBlock({ ticketing: ['x'] }), [WORKFLOW])).not.toHaveProperty('ticketing')
  })
})

// Plan-mode conversations started before workflows moved to
// `.claude/commands/coro/` resume a model session whose system prompt still
// names `workflows/<id>/workflow.md`. Rejecting that silently left the reply
// saying "check the run below" with nothing below it.
describe('parseRun workflow paths', () => {
  it('maps a pre-move workflow path to the current one', () => {
    expect(parseRun(runBlock({ workflowPath: 'workflows/job/workflow.md' }), [WORKFLOW])?.workflowPath)
      .toBe(WORKFLOW)
  })

  it('still rejects a legacy path whose workflow does not exist, and says why', () => {
    expect(inspectRun(runBlock({ workflowPath: 'workflows/gone/workflow.md' }), [WORKFLOW])).toEqual({
      ok: false,
      reason: 'workflow "workflows/gone/workflow.md" is not one this runner knows',
    })
  })
})

describe('run-card ticket updates', () => {
  it('summarises the ticketing patch', () => {
    expect(ticketUpdatesOf(undefined)).toBe('default')
    expect(ticketUpdatesOf({ enabled: false })).toBe('off')
    expect(ticketUpdatesOf({ preset: 'status-sync' })).toBe('status-sync')
    expect(ticketUpdatesOf({ preset: 'subtasks', createSourceTicket: { mode: 'auto' } })).toBe('subtasks')
    expect(ticketUpdatesOf({ createSourceTicket: { mode: 'auto' } })).toBe('default')
    expect(ticketUpdatesOf({ preset: 'subtasks', comments: { verbosity: 'detailed' } })).toBe('custom')
  })

  it('keeps a create-ticket request across choices, except off', () => {
    const create = { createSourceTicket: { mode: 'auto' } }
    expect(withTicketUpdates(create, 'subtasks')).toEqual({ preset: 'subtasks', ...create })
    expect(withTicketUpdates(create, 'default')).toEqual(create)
    expect(withTicketUpdates(create, 'off')).toEqual({ enabled: false })
    expect(withTicketUpdates(undefined, 'default')).toBeUndefined()
  })

  it('toggles createSourceTicket', () => {
    const on = withCreateSourceTicket({ preset: 'status-sync' }, true)
    expect(createsSourceTicket(on)).toBe(true)
    expect(withCreateSourceTicket(on, false)).toEqual({ preset: 'status-sync' })
    expect(withCreateSourceTicket({ createSourceTicket: { mode: 'auto' } }, false)).toBeUndefined()
  })

  it('builds the POST /jobs params', () => {
    expect(runTicketParams({})).toEqual({})
    expect(runTicketParams({
      trackerRef: { pluginId: 'jira', externalId: ' WS-1 ' },
      ticketing: { enabled: false },
    })).toEqual({
      trackerRef: { kind: 'ticket', pluginId: 'jira', externalId: 'WS-1' },
      ticketing: { enabled: false },
    })
    expect(runTicketParams({ trackerRef: { externalId: '  ' } })).toEqual({})
  })
})

describe('run card replay', () => {
  it('replays ticket fields into the seed transcript', () => {
    const [message] = toIntakeMessages([
      {
        kind: 'card',
        id: 'r',
        card: {
          type: 'run',
          data: {
            state: 'draft',
            run: {
              repo: 'acme/payments',
              serviceName: 'payments',
              description: 'Add idempotency keys to the refund endpoint.',
              reviewers: '',
              workflowPath: WORKFLOW,
              interactive: true,
              trackerRef: { externalId: 'WS-1' },
              ticketing: { enabled: false },
            },
          },
        },
      },
    ])
    expect(message?.content).toContain('"trackerRef":{"externalId":"WS-1"}')
    expect(message?.content).toContain('"ticketing":{"enabled":false}')
  })
})
