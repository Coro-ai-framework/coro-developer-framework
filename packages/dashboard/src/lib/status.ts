import type { ConnectionStatus } from '../types'

type StatusCategory = 'running' | 'waiting' | 'terminal' | 'idle'
type StatusTone = 'neutral' | 'indigo' | 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose'

export interface StatusMeta {
  label: string
  category: StatusCategory
  tone: StatusTone
  pulse?: boolean
}

const STATUS_MAP: Record<string, StatusMeta> = {
  queued: { label: 'Queued', category: 'running', tone: 'neutral', pulse: true },
  planning: { label: 'Planning', category: 'running', tone: 'violet', pulse: true },
  coding: { label: 'Coding', category: 'running', tone: 'indigo', pulse: true },
  reviewing: { label: 'Reviewing', category: 'running', tone: 'amber', pulse: true },
  review: { label: 'Reviewing', category: 'running', tone: 'amber', pulse: true },
  testing: { label: 'Testing', category: 'running', tone: 'cyan', pulse: true },
  evaluating: { label: 'Evaluating', category: 'running', tone: 'emerald', pulse: true },
  analysis: { label: 'Analysis', category: 'running', tone: 'violet', pulse: true },
  'repo-setup': { label: 'Repo Setup', category: 'running', tone: 'neutral', pulse: true },
  reporting: { label: 'Reporting', category: 'running', tone: 'cyan', pulse: true },
  'spec-writing': { label: 'Spec Writing', category: 'running', tone: 'violet', pulse: true },
  'campaign-planning': { label: 'Campaign Planning', category: 'running', tone: 'violet', pulse: true },
  coordinating: { label: 'Coordinating', category: 'running', tone: 'cyan', pulse: true },
  aggregating: { label: 'Aggregating', category: 'running', tone: 'emerald', pulse: true },
  'awaiting-plan-approval': { label: 'Awaiting Plan Approval', category: 'waiting', tone: 'amber' },
  'awaiting-pr-merge': { label: 'Awaiting PR Merge', category: 'waiting', tone: 'amber' },
  'awaiting-developer-input': { label: 'Awaiting Input', category: 'waiting', tone: 'amber', pulse: true },
  'awaiting-children': { label: 'Awaiting Children', category: 'waiting', tone: 'cyan' },
  complete: { label: 'Complete', category: 'terminal', tone: 'emerald' },
  failed: { label: 'Failed', category: 'terminal', tone: 'rose' },
  escalated: { label: 'Escalated', category: 'terminal', tone: 'rose' },
}

const CONNECTION_MAP: Record<ConnectionStatus, StatusMeta> = {
  connecting: { label: 'Connecting', category: 'waiting', tone: 'amber', pulse: true },
  connected: { label: 'Live', category: 'running', tone: 'emerald', pulse: true },
  disconnected: { label: 'Stream Ended', category: 'idle', tone: 'neutral' },
  error: { label: 'Connection Lost', category: 'terminal', tone: 'rose' },
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

export function toneClasses(tone: StatusTone) {
  switch (tone) {
    case 'indigo':
      return 'border-indigo-500/35 bg-indigo-500/12 text-indigo-100 shadow-[inset_0_0_0_1px_rgba(99,102,241,0.12)]'
    case 'cyan':
      return 'border-cyan-500/35 bg-cyan-500/12 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.12)]'
    case 'violet':
      return 'border-violet-500/35 bg-violet-500/12 text-violet-100 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.12)]'
    case 'emerald':
      return 'border-emerald-500/35 bg-emerald-500/12 text-emerald-100 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.12)]'
    case 'amber':
      return 'border-amber-500/35 bg-amber-500/12 text-amber-100 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.12)]'
    case 'rose':
      return 'border-rose-500/35 bg-rose-500/12 text-rose-100 shadow-[inset_0_0_0_1px_rgba(251,113,133,0.12)]'
    case 'neutral':
    default:
      return 'border-white/12 bg-white/6 text-slate-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]'
  }
}

export function toneDotClasses(tone: StatusTone) {
  switch (tone) {
    case 'indigo':
      return 'bg-indigo-400'
    case 'cyan':
      return 'bg-cyan-400'
    case 'violet':
      return 'bg-violet-400'
    case 'emerald':
      return 'bg-emerald-400'
    case 'amber':
      return 'bg-amber-400'
    case 'rose':
      return 'bg-rose-400'
    case 'neutral':
    default:
      return 'bg-slate-400'
  }
}