// Editing helpers for the `ticketing` block of ~/.coro/config.json.
//
// The form edits the top-level document only; repo/project overrides are
// edited as JSON. A field shows the document's value when set and the
// chosen preset's value otherwise (from `resolved.ticketingPresets`, which
// the runner expands), and setting a field back to the preset's value
// removes it — so the saved document holds only what the operator changed.

export const TICKETING_PRESET_IDS = ['minimal', 'status-sync', 'subtasks', 'custom'] as const
export type TicketingPresetId = typeof TICKETING_PRESET_IDS[number]

export const SOURCE_TICKET_EVENT_IDS = [
  'jobStarted',
  'planReady',
  'prOpened',
  'awaitingInput',
  'escalated',
  'jobCompleted',
  'jobFailed',
] as const

export const WORK_ITEM_TICKET_EVENT_IDS = [
  'workItemStarted',
  'prOpened',
  'workItemCompleted',
  'reworkRequested',
  'escalated',
] as const

export const TICKET_STATUS_CATEGORY_IDS = ['todo', 'in-progress', 'in-review', 'done'] as const

export type TicketEventScope = 'sourceTicket' | 'workItemTickets'

export interface ResolvedTicketEventAction {
  comment: boolean
  status: string | null
  labels: { add: string[]; remove: string[] }
}

export interface ResolvedTicketingPolicy {
  enabled: boolean
  tracker: string
  preset: TicketingPresetId
  read: { planMode: boolean; jobs: boolean; commentsAtPhaseStart: boolean }
  linking: { branchName: boolean; prTitle: boolean; prBody: boolean }
  sourceTicket: { on: Record<string, ResolvedTicketEventAction> }
  workItemTickets: {
    mode: 'off' | 'subtasks' | 'linked' | 'checklist'
    requireSourceTicket: boolean
    minWorkItems: number
    maxPerJob: number
    grouping: 'workItem' | 'repo'
    issueType: string | null
    project: string | null
    assignee: string
    labels: string[]
    fields: Record<string, unknown>
    reuseExisting: boolean
    on: Record<string, ResolvedTicketEventAction>
  }
  statusMap: Record<string, string>
  createSourceTicket: { mode: 'off' | 'ask' | 'auto'; project: string | null; issueType: string | null }
  comments: { verbosity: 'brief' | 'detailed'; prefix: string; language: string }
  appliedOverrides: string[]
  runOverride: boolean
}

export type TicketingPresets = Record<TicketingPresetId, ResolvedTicketingPolicy>

/** The top-level `ticketing` document without `overrides`. */
export type TicketingDoc = Record<string, unknown>

export const PRESET_LABELS: Record<TicketingPresetId, { title: string; description: string }> = {
  minimal: {
    title: 'Minimal',
    description: 'Read tickets, link branches and PRs, and comment on the run\'s ticket. No status changes or new tickets.',
  },
  'status-sync': {
    title: 'Status sync',
    description: 'Minimal, plus move the run\'s ticket to in progress when the job starts and to in review when the PR opens.',
  },
  subtasks: {
    title: 'Sub-tickets',
    description: 'Status sync, plus a sub-ticket per work item kept in step with the work item\'s status.',
  },
  custom: {
    title: 'Custom',
    description: 'Start from the built-in defaults and set every event yourself.',
  },
}

export const EVENT_LABELS: Record<string, string> = {
  jobStarted: 'Job started',
  planReady: 'Plan ready',
  prOpened: 'PR opened',
  awaitingInput: 'Waiting for input',
  escalated: 'Escalated',
  jobCompleted: 'Job completed',
  jobFailed: 'Job failed',
  workItemStarted: 'Work item started',
  workItemCompleted: 'Work item completed',
  reworkRequested: 'Rework requested',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function getPath(doc: unknown, path: readonly string[]): unknown {
  let current: unknown = doc
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/** Immutable set. `undefined` deletes the key and prunes objects left empty. */
export function setPath(doc: TicketingDoc, path: readonly string[], value: unknown): TicketingDoc {
  const [head, ...rest] = path
  if (head === undefined) return doc
  const next: TicketingDoc = { ...doc }
  if (rest.length === 0) {
    if (value === undefined) delete next[head]
    else next[head] = value
    return next
  }
  const child = setPath(isRecord(doc[head]) ? doc[head] : {}, rest, value)
  if (Object.keys(child).length === 0) delete next[head]
  else next[head] = child
  return next
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function presetOf(doc: TicketingDoc): TicketingPresetId {
  const preset = doc['preset']
  return (TICKETING_PRESET_IDS as readonly string[]).includes(preset as string) ? (preset as TicketingPresetId) : 'minimal'
}

export function basePolicy(doc: TicketingDoc, presets: TicketingPresets): ResolvedTicketingPolicy {
  return presets[presetOf(doc)]
}

/** The document's value, else the preset's. */
export function effectiveValue<T>(doc: TicketingDoc, presets: TicketingPresets, path: readonly string[]): T {
  const own = getPath(doc, path)
  return (own !== undefined ? own : getPath(basePolicy(doc, presets), path)) as T
}

/** Sets a field, removing it when it matches the preset. */
export function setField(doc: TicketingDoc, presets: TicketingPresets, path: readonly string[], value: unknown): TicketingDoc {
  const base = getPath(basePolicy(doc, presets), path)
  return setPath(doc, path, value === undefined || sameValue(value, base) ? undefined : value)
}

export function setPreset(doc: TicketingDoc, preset: TicketingPresetId): TicketingDoc {
  return setPath(doc, ['preset'], preset === 'minimal' ? undefined : preset)
}

export function eventPath(scope: TicketEventScope, event: string, field: 'comment' | 'status'): string[] {
  return [scope, 'on', event, field]
}

/**
 * `statusMap` stores only mapped categories. Blank means "use the
 * tracker's own status for this category". Text is kept as typed (the
 * schema trims on save) so a controlled input can hold a trailing space.
 */
export function setStatusMapping(doc: TicketingDoc, category: string, name: string): TicketingDoc {
  return setPath(doc, ['statusMap', category], name.trim() ? name : undefined)
}

/** Labels as typed: comma-separated. */
export function parseLabels(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean)
}

/** `null` for a blank field (the schema's "unset" for project/issue type). */
export function blankToNull(text: string): string | null {
  return text.trim() ? text : null
}

/** What `PUT /config` gets: `null` removes the block. Throws on bad overrides JSON. */
export function ticketingPayload(doc: TicketingDoc, overridesText: string): TicketingDoc | null {
  const trimmed = overridesText.trim()
  let overrides: unknown = []
  if (trimmed) {
    try {
      overrides = JSON.parse(trimmed)
    } catch (err) {
      throw new Error(`Ticket management overrides JSON is invalid: ${(err as Error).message}`)
    }
  }
  if (!Array.isArray(overrides)) throw new Error('Ticket management overrides must be a JSON array.')
  const payload: TicketingDoc = { ...doc, ...(overrides.length > 0 ? { overrides } : {}) }
  return Object.keys(payload).length > 0 ? payload : null
}

/** Splits the stored block into the form document and the overrides text. */
export function ticketingDraftOf(stored: unknown): { doc: TicketingDoc; overridesText: string } {
  if (!isRecord(stored)) return { doc: {}, overridesText: '[]' }
  const { overrides, ...doc } = stored
  return { doc, overridesText: JSON.stringify(Array.isArray(overrides) ? overrides : [], null, 2) }
}
