// ── Ticket management policy (`ticketing` in ~/.coro/config.json) ────────────
//
// Teams run very different task-management flows, so Coro does not decide
// on its own when to comment on, transition, or create tracker tickets. The
// install declares it here; the runner resolves one fully-populated policy
// per job, snapshots it onto `job.params.ticketingPolicy`, and agents follow
// the snapshot. Nothing in agent markdown may assume a status name, an issue
// type, or that a write is wanted.
//
// Absent config resolves to the `minimal` preset: read tickets, link the
// branch and PR to the ticket the run is attached to, and leave a few
// comments on that ticket. No status changes, no ticket creation, and no
// writes to any ticket the run is not attached to.
//
// Precedence (later wins, field by field):
//   built-in defaults → preset → top-level fields → matching repo
//   overrides → matching project overrides → per-run `params.ticketing`

import { z } from 'zod'

export const TICKET_STATUS_CATEGORIES = ['todo', 'in-progress', 'in-review', 'done'] as const
export type TicketStatusCategory = typeof TICKET_STATUS_CATEGORIES[number]

export const SOURCE_TICKET_EVENTS = [
  'jobStarted',
  'planReady',
  'prOpened',
  'awaitingInput',
  'escalated',
  'jobCompleted',
  'jobFailed',
] as const
export type SourceTicketEvent = typeof SOURCE_TICKET_EVENTS[number]

export const WORK_ITEM_TICKET_EVENTS = [
  'workItemStarted',
  'prOpened',
  'workItemCompleted',
  'reworkRequested',
  'escalated',
] as const
export type WorkItemTicketEvent = typeof WORK_ITEM_TICKET_EVENTS[number]

export const TICKETING_PRESETS = ['minimal', 'status-sync', 'subtasks', 'custom'] as const
export type TicketingPreset = typeof TICKETING_PRESETS[number]

export const WORK_ITEM_TICKET_MODES = ['off', 'subtasks', 'linked', 'checklist'] as const
export type WorkItemTicketMode = typeof WORK_ITEM_TICKET_MODES[number]

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * `null` means "do not transition". A {@link TicketStatusCategory} is
 * resolved through `statusMap`, then the tracker's own categories; any
 * other string is an exact status name. Names cannot be validated here —
 * they live in the tracker.
 */
const ticketStatusTargetSchema = z.string().trim().min(1).nullable()

const ticketEventActionSchema = z.object({
  comment: z.boolean().optional(),
  status: ticketStatusTargetSchema.optional(),
  labels: z.object({
    add: z.array(z.string().min(1)).optional(),
    remove: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
}).strict()

function eventMapSchema<const E extends readonly string[]>(events: E) {
  const shape = Object.fromEntries(events.map(e => [e, ticketEventActionSchema.optional()])) as {
    [K in E[number]]: z.ZodOptional<typeof ticketEventActionSchema>
  }
  return z.object(shape).strict()
}

const ticketingPolicyShape = {
  enabled: z.boolean().optional(),
  /** `"auto"` | `"<pluginId>"` | `"mcp:<serverId>"` | `"none"`. */
  tracker: z.string().trim().min(1).optional(),
  preset: z.enum(TICKETING_PRESETS).optional(),
  read: z.object({
    planMode: z.boolean().optional(),
    jobs: z.boolean().optional(),
    commentsAtPhaseStart: z.boolean().optional(),
  }).strict().optional(),
  linking: z.object({
    branchName: z.boolean().optional(),
    prTitle: z.boolean().optional(),
    prBody: z.boolean().optional(),
  }).strict().optional(),
  sourceTicket: z.object({
    on: eventMapSchema(SOURCE_TICKET_EVENTS).optional(),
  }).strict().optional(),
  workItemTickets: z.object({
    mode: z.enum(WORK_ITEM_TICKET_MODES).optional(),
    requireSourceTicket: z.boolean().optional(),
    minWorkItems: z.number().int().min(1).optional(),
    maxPerJob: z.number().int().min(1).max(50).optional(),
    grouping: z.enum(['workItem', 'repo']).optional(),
    issueType: z.string().trim().min(1).nullable().optional(),
    project: z.string().trim().min(1).nullable().optional(),
    /** `"none"` | `"sourceAssignee"` | `"sourceReporter"` | a tracker account id. */
    assignee: z.string().trim().min(1).optional(),
    labels: z.array(z.string().min(1)).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    reuseExisting: z.boolean().optional(),
    on: eventMapSchema(WORK_ITEM_TICKET_EVENTS).optional(),
  }).strict().optional(),
  statusMap: z.record(z.string().min(1), z.string().trim().min(1)).optional(),
  createSourceTicket: z.object({
    mode: z.enum(['off', 'ask', 'auto']).optional(),
    project: z.string().trim().min(1).nullable().optional(),
    issueType: z.string().trim().min(1).nullable().optional(),
  }).strict().optional(),
  comments: z.object({
    verbosity: z.enum(['brief', 'detailed']).optional(),
    prefix: z.string().optional(),
    language: z.string().trim().min(1).optional(),
  }).strict().optional(),
}

/** A partial policy: the shape of `params.ticketing` and of each override. */
export const ticketingPolicyPatchSchema = z.object(ticketingPolicyShape).strict()
export type TicketingPolicyPatch = z.infer<typeof ticketingPolicyPatchSchema>

const ticketingOverrideSchema = z.object({
  ...ticketingPolicyShape,
  match: z.object({
    project: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
  }).strict().refine(m => Boolean(m.project || m.repo), {
    message: 'an override must match on project, repo, or both',
  }),
}).strict()
export type TicketingOverride = z.infer<typeof ticketingOverrideSchema>

export const ticketingConfigSchema = z.object({
  ...ticketingPolicyShape,
  overrides: z.array(ticketingOverrideSchema).optional(),
}).strict()
export type TicketingConfig = z.infer<typeof ticketingConfigSchema>

// ── Resolved shape ───────────────────────────────────────────────────────────

export interface ResolvedTicketEventAction {
  comment: boolean
  status: string | null
  labels: { add: string[]; remove: string[] }
}

export interface ResolvedTicketingPolicy {
  enabled: boolean
  tracker: string
  preset: TicketingPreset
  read: { planMode: boolean; jobs: boolean; commentsAtPhaseStart: boolean }
  linking: { branchName: boolean; prTitle: boolean; prBody: boolean }
  sourceTicket: { on: Record<SourceTicketEvent, ResolvedTicketEventAction> }
  workItemTickets: {
    mode: WorkItemTicketMode
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
    on: Record<WorkItemTicketEvent, ResolvedTicketEventAction>
  }
  statusMap: Record<string, string>
  createSourceTicket: { mode: 'off' | 'ask' | 'auto'; project: string | null; issueType: string | null }
  comments: { verbosity: 'brief' | 'detailed'; prefix: string; language: string }
  /** Overrides that matched this job, e.g. `["repo:acme/payments", "project:WS"]`. */
  appliedOverrides: string[]
  /** True when `params.ticketing` changed anything for this run. */
  runOverride: boolean
}

function action(comment: boolean, status: string | null = null): ResolvedTicketEventAction {
  return { comment, status, labels: { add: [], remove: [] } }
}

function defaultPolicy(): ResolvedTicketingPolicy {
  return {
    enabled: true,
    tracker: 'auto',
    preset: 'minimal',
    read: { planMode: true, jobs: true, commentsAtPhaseStart: false },
    linking: { branchName: true, prTitle: true, prBody: true },
    sourceTicket: {
      on: {
        jobStarted: action(true),
        planReady: action(false),
        prOpened: action(true),
        awaitingInput: action(false),
        escalated: action(true),
        jobCompleted: action(true),
        jobFailed: action(true),
      },
    },
    workItemTickets: {
      mode: 'off',
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
      on: {
        workItemStarted: action(false),
        prOpened: action(true),
        workItemCompleted: action(true),
        reworkRequested: action(true),
        escalated: action(true),
      },
    },
    statusMap: {},
    createSourceTicket: { mode: 'off', project: null, issueType: null },
    comments: { verbosity: 'brief', prefix: 'Coro:', language: 'auto' },
    appliedOverrides: [],
    runOverride: false,
  }
}

const STATUS_SYNC_PATCH: TicketingPolicyPatch = {
  sourceTicket: {
    on: {
      jobStarted: { status: 'in-progress' },
      prOpened: { status: 'in-review' },
    },
  },
}

const SUBTASKS_PATCH: TicketingPolicyPatch = {
  sourceTicket: STATUS_SYNC_PATCH.sourceTicket,
  workItemTickets: {
    mode: 'subtasks',
    on: {
      workItemStarted: { status: 'in-progress' },
      workItemCompleted: { status: 'done' },
    },
  },
}

const PRESET_PATCHES: Record<TicketingPreset, TicketingPolicyPatch> = {
  minimal: {},
  'status-sync': STATUS_SYNC_PATCH,
  subtasks: SUBTASKS_PATCH,
  custom: {},
}

// ── Merge ────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `undefined` keeps the base value; `null`, arrays, and scalars replace it;
 * plain objects merge key by key. `fields` is the one record that replaces
 * wholesale, because it is passed to the tracker verbatim and a stale key
 * from a lower layer would be sent without anyone having written it.
 */
function mergeInto(base: Record<string, unknown>, patch: Record<string, unknown>, path = ''): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const here = path ? `${path}.${key}` : key
    const current = base[key]
    if (here !== 'workItemTickets.fields' && isPlainObject(value) && isPlainObject(current)) {
      mergeInto(current, value, here)
    } else {
      base[key] = Array.isArray(value) ? [...value] : isPlainObject(value) ? structuredClone(value) : value
    }
  }
}

function applyLayer(policy: ResolvedTicketingPolicy, layer: TicketingPolicyPatch): void {
  const { preset, ...fields } = layer
  if (preset) {
    mergeInto(policy as unknown as Record<string, unknown>, PRESET_PATCHES[preset] as Record<string, unknown>)
    policy.preset = preset
  }
  mergeInto(policy as unknown as Record<string, unknown>, fields as Record<string, unknown>)
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** Project key of a ticket: `WS-123` → `WS`, `owner/repo#7` → `owner/repo`. */
export function ticketProjectFromKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim()
  if (!trimmed) return undefined
  const hash = trimmed.indexOf('#')
  if (hash > 0) return trimmed.slice(0, hash)
  const match = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(trimmed)
  return match ? match[1]!.toUpperCase() : undefined
}

function repoMatches(pattern: string, repo: string | undefined): boolean {
  if (!repo) return false
  const p = pattern.trim().toLowerCase()
  const r = repo.trim().toLowerCase()
  if (p === r) return true
  const slug = r.includes('/') ? r.slice(r.lastIndexOf('/') + 1) : r
  return !p.includes('/') && p === slug
}

function overrideMatches(o: TicketingOverride, repo: string | undefined, project: string | undefined): boolean {
  if (o.match.repo && !repoMatches(o.match.repo, repo)) return false
  if (o.match.project && o.match.project.toUpperCase() !== project?.toUpperCase()) return false
  return true
}

function overrideRank(o: TicketingOverride): number {
  if (o.match.repo && o.match.project) return 3
  return o.match.project ? 2 : 1
}

function overrideLabel(o: TicketingOverride): string {
  return [o.match.repo ? `repo:${o.match.repo}` : null, o.match.project ? `project:${o.match.project}` : null]
    .filter(Boolean)
    .join('+')
}

// ── Resolve ──────────────────────────────────────────────────────────────────

export interface TicketingResolveContext {
  repo?: string
  /** Project key of the run's ticket, or the full key (`WS-123`) to derive it from. */
  ticketProject?: string
  /** Per-run patch, typically `job.params.ticketing`. Invalid input is ignored. */
  runOverride?: unknown
}

export interface TicketingResolveResult {
  policy: ResolvedTicketingPolicy
  /** Why `runOverride` was ignored, when it was. */
  runOverrideError?: string
}

export function resolveTicketingPolicyDetailed(
  config: TicketingConfig | undefined | null,
  context: TicketingResolveContext = {},
): TicketingResolveResult {
  const policy = defaultPolicy()
  const project = ticketProjectFromKey(context.ticketProject) ?? context.ticketProject?.trim().toUpperCase()

  if (config) {
    const { overrides, ...top } = config
    applyLayer(policy, top)
    const matching = (overrides ?? [])
      .map((o, index) => ({ o, index }))
      .filter(({ o }) => overrideMatches(o, context.repo, project))
      .sort((a, b) => overrideRank(a.o) - overrideRank(b.o) || a.index - b.index)
    for (const { o } of matching) {
      const { match: _match, ...fields } = o
      applyLayer(policy, fields)
      policy.appliedOverrides.push(overrideLabel(o))
    }
  }

  let runOverrideError: string | undefined
  if (context.runOverride !== undefined && context.runOverride !== null) {
    const parsed = ticketingPolicyPatchSchema.safeParse(context.runOverride)
    if (parsed.success) {
      if (Object.keys(parsed.data).length > 0) {
        applyLayer(policy, parsed.data)
        policy.runOverride = true
      }
    } else {
      runOverrideError = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
    }
  }

  return { policy, ...(runOverrideError ? { runOverrideError } : {}) }
}

export function resolveTicketingPolicy(
  config: TicketingConfig | undefined | null,
  context: TicketingResolveContext = {},
): ResolvedTicketingPolicy {
  return resolveTicketingPolicyDetailed(config, context).policy
}

/** Each preset expanded over the built-in defaults, for the settings UI. */
export function describeTicketingPresets(): Record<TicketingPreset, ResolvedTicketingPolicy> {
  return Object.fromEntries(
    TICKETING_PRESETS.map(preset => [preset, resolveTicketingPolicy({ preset })]),
  ) as Record<TicketingPreset, ResolvedTicketingPolicy>
}

/** True when the policy allows any tracker write at all. */
export function ticketingWritesEnabled(policy: ResolvedTicketingPolicy): boolean {
  return policy.enabled && policy.tracker !== 'none'
}
