import type { ConnectionStatus } from '../types'

type StatusCategory = 'running' | 'waiting' | 'terminal' | 'idle'

/**
 * Semantic tone vocabulary. Five working tones — anything more makes lists
 * read as a candy box and dilutes the meaning of the *real* signal colors
 * (warning = needs you, danger = failed, success = done).
 *
 * Running phases all share `accent`. The phase name communicates the phase;
 * a unique color per phase added noise, not signal.
 */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/**
 * Legacy tone names from the old palette. Kept as a type alias so existing
 * call sites compile while we migrate them to the semantic vocabulary above.
 * `normalizeTone` collapses these to the new tones.
 */
export type LegacyTone = 'indigo' | 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose'
export type AnyTone = Tone | LegacyTone

export interface StatusMeta {
  label: string
  category: StatusCategory
  tone: Tone
  pulse?: boolean
}

const STATUS_MAP: Record<string, StatusMeta> = {
  queued: { label: 'Starting', category: 'running', tone: 'neutral', pulse: true },
  planning: { label: 'Planning', category: 'running', tone: 'accent', pulse: true },
  coding: { label: 'Coding', category: 'running', tone: 'accent', pulse: true },
  reviewing: { label: 'Reviewing', category: 'running', tone: 'accent', pulse: true },
  review: { label: 'Reviewing', category: 'running', tone: 'accent', pulse: true },
  testing: { label: 'Testing', category: 'running', tone: 'accent', pulse: true },
  evaluating: { label: 'Evaluating', category: 'running', tone: 'accent', pulse: true },
  analysis: { label: 'Analysis', category: 'running', tone: 'accent', pulse: true },
  'repo-setup': { label: 'Repo Setup', category: 'running', tone: 'accent', pulse: true },
  reporting: { label: 'Reporting', category: 'running', tone: 'accent', pulse: true },
  'spec-writing': { label: 'Spec Writing', category: 'running', tone: 'accent', pulse: true },
  'campaign-architecture': { label: 'Campaign Architecture', category: 'running', tone: 'accent', pulse: true },
  'campaign-planning': { label: 'Campaign Planning', category: 'running', tone: 'accent', pulse: true },
  coordinating: { label: 'Coordinating', category: 'running', tone: 'accent', pulse: true },
  integrating: { label: 'Integrating', category: 'running', tone: 'accent', pulse: true },
  aggregating: { label: 'Aggregating', category: 'running', tone: 'accent', pulse: true },
  'awaiting-plan-approval': { label: 'Needs you', category: 'waiting', tone: 'warning', pulse: true },
  'awaiting-pr-merge': { label: 'Waiting on PR', category: 'waiting', tone: 'warning' },
  'awaiting-developer-input': { label: 'Needs you', category: 'waiting', tone: 'warning', pulse: true },
  'awaiting-children': { label: 'Waiting on sub-runs', category: 'waiting', tone: 'warning' },
  'awaiting-rate-limit': { label: 'Slowed', category: 'waiting', tone: 'warning' },
  complete: { label: 'Done', category: 'terminal', tone: 'success' },
  cancelled: { label: 'Cancelled', category: 'terminal', tone: 'neutral' },
  canceled: { label: 'Cancelled', category: 'terminal', tone: 'neutral' },
  failed: { label: 'Failed', category: 'terminal', tone: 'danger' },
  escalated: { label: 'Needs escalation', category: 'terminal', tone: 'danger' },
  // Coordinator states for sub-runs. Live job status wins when the child
  // has been started; these are the fallbacks before that.
  pending: { label: 'Starting', category: 'running', tone: 'neutral', pulse: true },
  ready: { label: 'Waiting to start', category: 'waiting', tone: 'warning' },
  dispatched: { label: 'Working', category: 'running', tone: 'accent', pulse: true },
  skipped: { label: 'Skipped', category: 'terminal', tone: 'neutral' },
}

/** Plan-mode conversation — not a job yet. */
export const READINESS_META = {
  investigating: { label: 'Investigating', category: 'running', tone: 'warning' },
  ready: { label: 'Ready to start', category: 'idle', tone: 'accent' },
  'no-run-needed': { label: 'No run needed', category: 'idle', tone: 'neutral' },
} as const satisfies Record<string, StatusMeta>

export const PAUSED_META: StatusMeta = { label: 'Paused', category: 'waiting', tone: 'warning' }
export const CLOSED_META: StatusMeta = { label: 'Closed', category: 'idle', tone: 'neutral' }
/** A conversation with a turn in flight, including one not on screen. */
export const CONVERSATION_WORKING_META: StatusMeta = {
  label: 'Working',
  category: 'running',
  tone: 'accent',
  pulse: true,
}

const CONNECTION_MAP: Record<ConnectionStatus, StatusMeta> = {
  connecting: { label: 'Connecting', category: 'waiting', tone: 'warning', pulse: true },
  connected: { label: 'Live', category: 'running', tone: 'success', pulse: true },
  disconnected: { label: 'Stream Ended', category: 'idle', tone: 'neutral' },
  error: { label: 'Connection Lost', category: 'terminal', tone: 'danger' },
}

export function getStatusMeta(status: string): StatusMeta {
  const known = STATUS_MAP[status]
  if (known) return known

  const label = status
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

  // Workflow markdown declares arbitrary per-phase `status:` strings, so
  // unknown statuses are almost certainly active phases from a custom
  // workflow. The waiting/terminal sets are closed (cloud-protocol
  // STATUS_* constants); the only open-ended namespace is running phases.
  // Treating unknowns as 'idle' silently disabled run controls (steering
  // composer, Pause) for custom-workflow phases.
  if (status.startsWith('awaiting-')) {
    return { label, category: 'waiting', tone: 'warning' }
  }
  return { label, category: 'running', tone: 'accent', pulse: true }
}

export function getConnectionMeta(status: ConnectionStatus): StatusMeta {
  return CONNECTION_MAP[status]
}

export function isTerminalStatus(status: string): boolean {
  return getStatusMeta(status).category === 'terminal'
}

export function isWaitingStatus(status: string): boolean {
  return getStatusMeta(status).category === 'waiting'
}

export function isRunningStatus(status: string): boolean {
  return getStatusMeta(status).category === 'running'
}

export function isResumableStatus(status: string): boolean {
  return status !== 'complete' && status !== 'cancelled'
}

export function isCancellableStatus(status: string): boolean {
  return status !== 'complete' && status !== 'cancelled'
}

/** Marker `awaitingEvent` set by the runner when a developer pauses a job. */
export const PAUSED_AWAITING_EVENT = 'developer-input: paused by developer'

/**
 * A job is "developer-paused" when the runner parked it via the Pause
 * button (status `awaiting-developer-input` + the marker awaitingEvent).
 * Distinct from agent-initiated parks, which render as "Needs you".
 */
export function isPausedStatus(status: string, awaitingEvent?: string | null): boolean {
  return status === 'awaiting-developer-input' && awaitingEvent === PAUSED_AWAITING_EVENT
}

export interface StatusSource {
  status: string
  awaitingEvent?: string | null
}

/** User-facing status for a job, including the Pause overlay. */
export function getJobDisplayStatus(job: StatusSource): StatusMeta {
  if (isPausedStatus(job.status, job.awaitingEvent)) return PAUSED_META
  return getStatusMeta(job.status)
}

export type RunIndicator = 'running' | 'waiting' | 'paused' | 'done' | 'failed'

/**
 * Which live-state glyph a run surface should show. Derived from the same
 * status vocabulary as the badge, so a card and the Recents rail can never
 * disagree: a running phase spins, anything parked (including a developer
 * pause) is static, and terminal states resolve to done / failed.
 */
export function getRunIndicator(job: StatusSource): RunIndicator {
  if (isPausedStatus(job.status, job.awaitingEvent)) return 'paused'
  const meta = getStatusMeta(job.status)
  if (meta.category === 'terminal') return meta.tone === 'danger' ? 'failed' : 'done'
  if (meta.category === 'waiting' || meta.category === 'idle') return 'waiting'
  return 'running'
}

export function getReadinessMeta(state?: string | null): StatusMeta {
  if (state === 'ready') return READINESS_META.ready
  if (state === 'no-run-needed') return READINESS_META['no-run-needed']
  return READINESS_META.investigating
}

/**
 * Recents-rail status. A turn in flight wins — it is the only transient state
 * here, and a conversation the developer switched away from has no other way
 * to say it is still working. Then a linked live job; otherwise this is still
 * a conversation (investigating / ready to start / closed).
 */
export function getConversationDisplayStatus(
  row: {
    status: string
    readiness?: { state: string } | null
    dispatchedJobId?: string | null
  },
  job?: StatusSource | null,
  opts?: { running?: boolean },
): StatusMeta {
  if (opts?.running) return CONVERSATION_WORKING_META
  if (job) return getJobDisplayStatus(job)
  if (row.status === 'dispatched') return getStatusMeta('dispatched')
  if (row.status === 'closed') return CLOSED_META
  return getReadinessMeta(row.readiness?.state)
}

export interface TabStatusSignal {
  label: string
  tone: Tone
  pulse: boolean
  attention: boolean
}

/** Compact signal for an open-run tab. Same labels as StatusBadge. */
export function getTabStatus(job: StatusSource): TabStatusSignal {
  const meta = getJobDisplayStatus(job)
  const paused = isPausedStatus(job.status, job.awaitingEvent)
  const attention =
    paused
    || job.status === 'awaiting-developer-input'
    || job.status === 'awaiting-plan-approval'
    || job.status === 'escalated'
  const calm = paused || job.status === 'awaiting-rate-limit'
  return {
    label: meta.label,
    tone: meta.tone,
    pulse: !calm && ((meta.pulse ?? false) || attention),
    attention,
  }
}

/**
 * Pause is only meaningful while the job is actively running. Stopped
 * jobs (terminal or failed/escalated) and parked jobs should not show
 * the Pause button.
 */
export function isPausableStatus(status: string, awaitingEvent?: string | null): boolean {
  if (isPausedStatus(status, awaitingEvent)) return false
  return getStatusMeta(status).category === 'running'
}

/**
 * Map a legacy tone to its semantic equivalent. Lets components accept either
 * vocabulary while we migrate call sites.
 */
export function normalizeTone(tone: AnyTone | undefined): Tone {
  switch (tone) {
    case 'accent':
    case 'indigo':
    case 'cyan':
    case 'violet':
      return 'accent'
    case 'success':
    case 'emerald':
      return 'success'
    case 'warning':
    case 'amber':
      return 'warning'
    case 'danger':
    case 'rose':
      return 'danger'
    case 'neutral':
    default:
      return 'neutral'
  }
}

export function toneClasses(tone: AnyTone): string {
  switch (normalizeTone(tone)) {
    case 'accent':
      return 'border-accent-500/30 bg-accent-500/10 text-accent-300'
    case 'success':
      return 'border-success-500/30 bg-success-500/10 text-success-400'
    case 'warning':
      return 'border-warning-500/30 bg-warning-500/10 text-warning-400'
    case 'danger':
      return 'border-danger-500/30 bg-danger-500/10 text-danger-400'
    case 'neutral':
    default:
      return 'border-line-strong bg-overlay text-fg-muted'
  }
}

export function toneDotClasses(tone: AnyTone): string {
  switch (normalizeTone(tone)) {
    case 'accent':
      return 'bg-accent-400'
    case 'success':
      return 'bg-success-400'
    case 'warning':
      return 'bg-warning-400'
    case 'danger':
      return 'bg-danger-400'
    case 'neutral':
    default:
      return 'bg-fg-subtle'
  }
}
