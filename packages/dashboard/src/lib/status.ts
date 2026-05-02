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
  queued: { label: 'Queued', category: 'running', tone: 'neutral', pulse: true },
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
  'campaign-planning': { label: 'Campaign Planning', category: 'running', tone: 'accent', pulse: true },
  coordinating: { label: 'Coordinating', category: 'running', tone: 'accent', pulse: true },
  aggregating: { label: 'Aggregating', category: 'running', tone: 'accent', pulse: true },
  'awaiting-plan-approval': { label: 'Awaiting Plan Approval', category: 'waiting', tone: 'warning' },
  'awaiting-pr-merge': { label: 'Awaiting PR Merge', category: 'waiting', tone: 'warning' },
  'awaiting-developer-input': { label: 'Awaiting Input', category: 'waiting', tone: 'warning', pulse: true },
  'awaiting-children': { label: 'Awaiting Children', category: 'waiting', tone: 'warning' },
  complete: { label: 'Complete', category: 'terminal', tone: 'success' },
  failed: { label: 'Failed', category: 'terminal', tone: 'danger' },
  escalated: { label: 'Escalated', category: 'terminal', tone: 'danger' },
}

const CONNECTION_MAP: Record<ConnectionStatus, StatusMeta> = {
  connecting: { label: 'Connecting', category: 'waiting', tone: 'warning', pulse: true },
  connected: { label: 'Live', category: 'running', tone: 'success', pulse: true },
  disconnected: { label: 'Stream Ended', category: 'idle', tone: 'neutral' },
  error: { label: 'Connection Lost', category: 'terminal', tone: 'danger' },
}

export function getStatusMeta(status: string): StatusMeta {
  return STATUS_MAP[status] ?? {
    label: status
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    category: 'idle',
    tone: 'neutral',
  }
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
