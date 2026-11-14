// ── Work list ────────────────────────────────────────────────────────────────
//
// One lightweight projection of everything on a runner that a developer may
// want to look at: plan-mode conversations, runs, and pull-request reviews.
// The dashboard's sidebar polls it; detail views fetch their own records.
// Grouping and attention are decided by the runner so every surface agrees.

import type { InvestigationStatus } from './investigation'
import type { JobType } from './job-types'

export type WorkGroup = 'needs-you' | 'working' | 'waiting' | 'recent'

export type WorkAttentionReason =
  /** Conversation: a tool permission prompt is waiting. */
  | 'permission'
  /** Run parked on a question or checkpoint for the developer. */
  | 'input'
  | 'plan-approval'
  | 'escalated'
  | 'failed'
  /** Review round draft waiting for approval before anything is posted. */
  | 'review-draft'
  | 'review-verdict'
  | 'review-failed'
  /** Review paused by budget, round limit, removed request, or a draft PR. */
  | 'review-held'

export interface WorkConversation {
  kind: 'conversation'
  id: string
  title: string
  status: InvestigationStatus
  readinessState: 'investigating' | 'ready' | 'no-run-needed' | null
  openQuestions: number
  /** A plan-mode turn is in flight. */
  streaming: boolean
  pendingPermissions: number
  reviewIds: string[]
  createdAt: string
  updatedAt: string
  group: WorkGroup
  attention: WorkAttentionReason | null
}

export interface WorkRun {
  kind: 'run'
  id: string
  type: JobType
  workflowPath: string
  title: string
  repo: string | null
  status: string
  phase: string
  awaitingEvent?: string
  escalationMessage?: string
  currentWorkItem: string | null
  interactive: boolean
  investigationId?: string
  campaignParentId?: string
  costUsd: number
  createdAt: string
  updatedAt: string
  group: WorkGroup
  attention: WorkAttentionReason | null
}

export interface WorkReview {
  kind: 'review'
  id: string
  title: string
  /** e.g. "org/repo#103" */
  prLabel: string
  prUrl: string
  scm: string
  prState: 'open' | 'merged' | 'declined'
  status: string
  pauseReason?: string
  /** Job id of a round whose draft waits for approval. */
  awaitingApprovalJobId?: string
  pendingVerdict?: string
  lastError?: string
  openFindings: { blocker: number; major: number; minor: number; nit: number }
  rounds: number
  createdAt: string
  updatedAt: string
  group: WorkGroup
  attention: WorkAttentionReason | null
}

export type WorklistItem = WorkConversation | WorkRun | WorkReview

export interface Worklist {
  /** Items in `needs-you`, counting runs and reviews nested under a conversation. */
  needsYou: number
  conversations: WorkConversation[]
  runs: WorkRun[]
  reviews: WorkReview[]
}

/** Finished items kept per kind; anything that is not finished is always kept. */
export const WORKLIST_RECENT_CONVERSATIONS = 30
export const WORKLIST_RECENT_RUNS = 30
export const WORKLIST_RECENT_REVIEWS = 20
/** A plan conversation untouched this long stops waiting and drops to recent. */
export const WORKLIST_STALE_CONVERSATION_MS = 7 * 24 * 60 * 60 * 1000
