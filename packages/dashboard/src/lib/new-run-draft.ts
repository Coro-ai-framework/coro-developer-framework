import type { BriefDraft } from './intake-brief'
import type { IntakeChatMessage } from '../hooks/useIntakeStream'
import { FALLBACK_JOB_WORKFLOW } from '../workflows'

export const NEW_RUN_DRAFT_KEY = 'coro.newRun.draft'

export interface NewRunPlanDraft {
  messages: IntakeChatMessage[]
  brief: BriefDraft | null
  modelChoice: { provider: string; model: string }
}

export interface NewRunDraft {
  mode: 'manual' | 'ticket'
  serviceName: string
  repo: string
  description: string
  reviewers: string
  ticketId: string
  interactive: boolean
  workflowId: string
  scmId: string
  trackerId: string
  plan?: NewRunPlanDraft
}

export const EMPTY_NEW_RUN_DRAFT: NewRunDraft = {
  mode: 'manual',
  serviceName: '',
  repo: '',
  description: '',
  reviewers: '',
  ticketId: '',
  interactive: false,
  workflowId: FALLBACK_JOB_WORKFLOW.id,
  scmId: '',
  trackerId: '',
}

export function hasNewRunProgress(draft: NewRunDraft): boolean {
  if (
    draft.serviceName.trim() ||
    draft.repo.trim() ||
    draft.description.trim() ||
    draft.reviewers.trim() ||
    draft.ticketId.trim()
  ) {
    return true
  }
  const plan = draft.plan
  if (!plan) return false
  if (plan.brief) return true
  return plan.messages.some(m => m.role === 'user')
}

export function clearNewRunDraftStorage(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(NEW_RUN_DRAFT_KEY)
  } catch {
    // ignore
  }
}
