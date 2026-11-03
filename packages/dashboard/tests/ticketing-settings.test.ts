import { describe, expect, it } from 'vitest'
import {
  effectiveValue,
  eventPath,
  setField,
  setPath,
  setPreset,
  setStatusMapping,
  ticketingDraftOf,
  ticketingPayload,
  type ResolvedTicketEventAction,
  type ResolvedTicketingPolicy,
  type TicketingPresets,
} from '../src/lib/ticketing-settings'

function action(comment: boolean, status: string | null = null): ResolvedTicketEventAction {
  return { comment, status, labels: { add: [], remove: [] } }
}

function policy(preset: ResolvedTicketingPolicy['preset'], jobStartedStatus: string | null): ResolvedTicketingPolicy {
  return {
    enabled: true,
    tracker: 'auto',
    preset,
    read: { planMode: true, jobs: true, commentsAtPhaseStart: false },
    linking: { branchName: true, prTitle: true, prBody: true },
    sourceTicket: { on: { jobStarted: action(true, jobStartedStatus), planReady: action(false) } },
    workItemTickets: {
      mode: preset === 'subtasks' ? 'subtasks' : 'off',
      requireSourceTicket: true,
      minWorkItems: 2,
      maxPerJob: 10,
      grouping: 'workItem',
      issueType: null,
      project: null,
      assignee: 'none',
      labels: ['coro'],
      fields: {},
      reuseExisting: true,
      on: {},
    },
    statusMap: {},
    createSourceTicket: { mode: 'off', project: null, issueType: null },
    comments: { verbosity: 'brief', prefix: 'Coro:', language: 'auto' },
    appliedOverrides: [],
    runOverride: false,
  }
}

const presets: TicketingPresets = {
  minimal: policy('minimal', null),
  'status-sync': policy('status-sync', 'in-progress'),
  subtasks: policy('subtasks', 'in-progress'),
  custom: policy('custom', null),
}

const jobStartedStatus = eventPath('sourceTicket', 'jobStarted', 'status')

describe('setPath', () => {
  it('sets nested values and prunes emptied objects', () => {
    const doc = setPath({}, ['sourceTicket', 'on', 'jobStarted', 'comment'], false)
    expect(doc).toEqual({ sourceTicket: { on: { jobStarted: { comment: false } } } })
    expect(setPath(doc, ['sourceTicket', 'on', 'jobStarted', 'comment'], undefined)).toEqual({})
  })
})

describe('effectiveValue / setField', () => {
  it('reads through to the chosen preset', () => {
    expect(effectiveValue({}, presets, jobStartedStatus)).toBeNull()
    expect(effectiveValue({ preset: 'status-sync' }, presets, jobStartedStatus)).toBe('in-progress')
  })

  it('stores only values that differ from the preset', () => {
    const doc = setField({ preset: 'status-sync' }, presets, jobStartedStatus, null)
    expect(doc).toEqual({ preset: 'status-sync', sourceTicket: { on: { jobStarted: { status: null } } } })
    expect(setField(doc, presets, jobStartedStatus, 'in-progress')).toEqual({ preset: 'status-sync' })
  })

  it('keeps explicit fields across a preset switch', () => {
    const doc = setField({}, presets, ['comments', 'verbosity'], 'detailed')
    const switched = setPreset(doc, 'subtasks')
    expect(switched).toEqual({ preset: 'subtasks', comments: { verbosity: 'detailed' } })
    expect(effectiveValue(switched, presets, ['workItemTickets', 'mode'])).toBe('subtasks')
    expect(setPreset(switched, 'minimal')).toEqual({ comments: { verbosity: 'detailed' } })
  })

  it('treats false and null as set values', () => {
    const doc = setField({}, presets, ['enabled'], false)
    expect(effectiveValue(doc, presets, ['enabled'])).toBe(false)
  })
})

describe('statusMap', () => {
  it('drops blank mappings and keeps typed text', () => {
    const doc = setStatusMapping({}, 'in-progress', 'In ')
    expect(doc).toEqual({ statusMap: { 'in-progress': 'In ' } })
    expect(setStatusMapping(doc, 'in-progress', '  ')).toEqual({})
  })
})

describe('ticketing payload', () => {
  it('round-trips the stored block', () => {
    const stored = { preset: 'subtasks', overrides: [{ match: { repo: 'acme/web' }, enabled: false }] }
    const { doc, overridesText } = ticketingDraftOf(stored)
    expect(doc).toEqual({ preset: 'subtasks' })
    expect(ticketingPayload(doc, overridesText)).toEqual(stored)
  })

  it('removes the block when nothing is set', () => {
    expect(ticketingPayload({}, '[]')).toBeNull()
    expect(ticketingPayload({}, '')).toBeNull()
  })

  it('rejects overrides that are not a JSON array', () => {
    expect(() => ticketingPayload({}, '{')).toThrow(/invalid/)
    expect(() => ticketingPayload({}, '{}')).toThrow(/JSON array/)
  })

  it('starts empty for an install with no block', () => {
    expect(ticketingDraftOf(undefined)).toEqual({ doc: {}, overridesText: '[]' })
  })
})
