// Work list: the sidebar's model of everything on the runner.
//
// The runner decides each item's group and attention (GET /worklist,
// `packages/runner/src/runner/worklist.ts`). This module only threads items
// into conversations → runs → sub-runs, filters them, and picks labels from
// the same vocabulary the rest of the dashboard uses.
//
// Wire types are mirrored by hand from `@coro-ai/cloud-protocol/worklist`.

import { getWorkflowSlug } from './run-labels'
import {
  CLOSED_META,
  CONVERSATION_WORKING_META,
  getJobDisplayStatus,
  getReadinessMeta,
  type StatusMeta,
} from './status'
import { reviewStatusLabel } from './reviews'

export type WorkGroup = 'needs-you' | 'working' | 'waiting' | 'recent'

export type WorkAttentionReason =
  | 'permission'
  | 'input'
  | 'plan-approval'
  | 'escalated'
  | 'failed'
  | 'review-draft'
  | 'review-verdict'
  | 'review-failed'
  | 'review-held'

export interface WorkConversation {
  kind: 'conversation'
  id: string
  title: string
  status: 'active' | 'dispatched' | 'closed'
  readinessState: 'investigating' | 'ready' | 'no-run-needed' | null
  openQuestions: number
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
  type: string
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
  prLabel: string
  prUrl: string
  scm: string
  prState: 'open' | 'merged' | 'declined'
  status: string
  pauseReason?: string
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
  needsYou: number
  conversations: WorkConversation[]
  runs: WorkRun[]
  reviews: WorkReview[]
}

export const EMPTY_WORKLIST: Worklist = { needsYou: 0, conversations: [], runs: [], reviews: [] }

export const WORK_GROUPS: WorkGroup[] = ['needs-you', 'working', 'waiting', 'recent']

export const WORK_GROUP_LABEL: Record<WorkGroup, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  waiting: 'Waiting',
  recent: 'Recent',
}

const GROUP_RANK: Record<WorkGroup, number> = { 'needs-you': 0, working: 1, waiting: 2, recent: 3 }

export interface WorkThread {
  item: WorklistItem
  children: WorkThread[]
  /** Original navigation context when a pinned ancestor was moved out of the tree. */
  navigationAncestors?: WorklistItem[]
  /** Most urgent group of the item and everything under it. */
  group: WorkGroup
  /** Newest `updatedAt` in the thread, for ordering. */
  updatedAt: string
}

export function itemKey(item: Pick<WorklistItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`
}

/** Nesting deeper than this is a data loop, not a real campaign. */
const MAX_DEPTH = 4

/**
 * Conversation → its runs and reviews; run → its campaign sub-runs. A run
 * nests under its campaign parent before its conversation, because campaign
 * children inherit the parent's `investigationId`.
 */
export function buildThreads(worklist: Worklist): WorkThread[] {
  const runIds = new Set(worklist.runs.map(run => run.id))
  const conversationIds = new Set(worklist.conversations.map(c => c.id))
  const runsByParent = new Map<string, WorkRun[]>()
  const runsByConversation = new Map<string, WorkRun[]>()
  const reviewOwner = new Map<string, string>()

  for (const conversation of worklist.conversations) {
    for (const reviewId of conversation.reviewIds) {
      if (!reviewOwner.has(reviewId)) reviewOwner.set(reviewId, conversation.id)
    }
  }

  const topLevelRuns: WorkRun[] = []
  for (const run of worklist.runs) {
    if (run.campaignParentId && run.campaignParentId !== run.id && runIds.has(run.campaignParentId)) {
      push(runsByParent, run.campaignParentId, run)
    } else if (run.investigationId && conversationIds.has(run.investigationId)) {
      push(runsByConversation, run.investigationId, run)
    } else {
      topLevelRuns.push(run)
    }
  }

  const reviewsById = new Map(worklist.reviews.map(review => [review.id, review]))

  const runThread = (run: WorkRun, depth: number, seen: Set<string>): WorkThread => {
    const nextSeen = new Set(seen).add(run.id)
    const children = depth >= MAX_DEPTH
      ? []
      : (runsByParent.get(run.id) ?? [])
          .filter(child => !nextSeen.has(child.id))
          .map(child => runThread(child, depth + 1, nextSeen))
    return thread(run, sortChildren(children))
  }

  const threads: WorkThread[] = []
  for (const conversation of worklist.conversations) {
    const runs = (runsByConversation.get(conversation.id) ?? []).map(run => runThread(run, 1, new Set()))
    const reviews = conversation.reviewIds
      .filter(id => reviewOwner.get(id) === conversation.id)
      .map(id => reviewsById.get(id))
      .filter((review): review is WorkReview => Boolean(review))
      .map(review => thread(review, []))
    threads.push(thread(conversation, sortChildren([...runs, ...reviews])))
  }
  for (const run of topLevelRuns) threads.push(runThread(run, 0, new Set()))
  for (const review of worklist.reviews) {
    if (!reviewOwner.has(review.id)) threads.push(thread(review, []))
  }
  return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}

function thread(item: WorklistItem, children: WorkThread[]): WorkThread {
  let group = item.group
  let updatedAt = item.updatedAt
  for (const child of children) {
    if (GROUP_RANK[child.group] < GROUP_RANK[group]) group = child.group
    if (child.updatedAt > updatedAt) updatedAt = child.updatedAt
  }
  return { item, children, group, updatedAt }
}

/** Children read in the order they were started. */
function sortChildren(children: WorkThread[]): WorkThread[] {
  return children.sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt))
}

export function groupThreads(threads: WorkThread[]): Record<WorkGroup, WorkThread[]> {
  const grouped: Record<WorkGroup, WorkThread[]> = { 'needs-you': [], working: [], waiting: [], recent: [] }
  for (const t of threads) grouped[t.group].push(t)
  return grouped
}

/** Move pinned items individually, retaining the original navigation context for their descendants. */
export function partitionPinnedThreads(
  threads: WorkThread[],
  pinnedKeys: ReadonlySet<string>,
): { pinned: WorkThread[]; remaining: WorkThread[] } {
  const pinned: WorkThread[] = []
  const visit = (t: WorkThread, ancestors: WorklistItem[]): WorkThread[] => {
    const children = t.children.flatMap(child => visit(child, [...ancestors, t.item]))
    if (pinnedKeys.has(itemKey(t.item))) {
      pinned.push({ ...thread(t.item, []), navigationAncestors: ancestors })
      return children
    }
    return [{ ...thread(t.item, children), navigationAncestors: ancestors }]
  }
  const remaining = threads.flatMap(t => visit(t, []))
  const byUpdated = (a: WorkThread, b: WorkThread) => b.updatedAt.localeCompare(a.updatedAt)
  return { pinned: pinned.sort(byUpdated), remaining: remaining.sort(byUpdated) }
}

export type KindFilter = 'all' | 'conversation' | 'run' | 'review'

function itemSearchText(item: WorklistItem): string {
  const parts: Array<string | null | undefined> = [item.title, item.id]
  if (item.kind === 'run') parts.push(item.repo, item.currentWorkItem, item.phase)
  if (item.kind === 'review') parts.push(item.prLabel)
  return parts.filter(Boolean).join(' ').toLowerCase()
}

/** A thread stays when it or anything under it matches; non-matching ancestors keep their place for context. */
export function filterThreads(threads: WorkThread[], kind: KindFilter, query: string): WorkThread[] {
  const needle = query.trim().toLowerCase()
  if (kind === 'all' && !needle) return threads
  const matches = (item: WorklistItem) =>
    (kind === 'all' || item.kind === kind) && (!needle || itemSearchText(item).includes(needle))
  const visit = (t: WorkThread): WorkThread | null => {
    const children = t.children.map(visit).filter((child): child is WorkThread => child !== null)
    if (matches(t.item)) return { ...t, children: needle || kind !== 'all' ? children : t.children }
    return children.length > 0 ? { ...t, children } : null
  }
  return threads.map(visit).filter((t): t is WorkThread => t !== null)
}

/**
 * What a group header counts: the items that are in that group themselves,
 * not the parents shown around them for context. A thread always counts once.
 */
export function countInGroup(threads: WorkThread[], group: WorkGroup): number {
  const own = (t: WorkThread): number =>
    (t.item.group === group ? 1 : 0) + t.children.reduce((sum, child) => sum + own(child), 0)
  return threads.reduce((sum, t) => sum + Math.max(1, own(t)), 0)
}

// ── Navigation ───────────────────────────────────────────────────────────────

export type InspectorTarget = { kind: 'run'; id: string } | { kind: 'review'; id: string }

/** `?run=` wins over `?review=`; anything else is no inspector. */
export function parseInspector(search: string): InspectorTarget | null {
  const params = new URLSearchParams(search)
  const run = params.get('run')?.trim()
  if (run) return { kind: 'run', id: run }
  const review = params.get('review')?.trim()
  if (review) return { kind: 'review', id: review }
  return null
}

export function withInspector(search: string, target: InspectorTarget | null): string {
  const params = new URLSearchParams(search)
  params.delete('run')
  params.delete('review')
  if (target) params.set(target.kind, target.id)
  const next = params.toString()
  return next ? `?${next}` : ''
}

export function conversationPath(conversationId: string): string {
  return `/plans/${encodeURIComponent(conversationId)}`
}

export function conversationHref(conversationId: string, target?: InspectorTarget | null): string {
  return `${conversationPath(conversationId)}${withInspector('', target ?? null)}`
}

export function runPagePath(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`
}

export function reviewPagePath(reviewId: string): string {
  return `/reviews/${encodeURIComponent(reviewId)}`
}

/**
 * Where a row goes. Anything that lives under a conversation opens beside it;
 * work no conversation started opens on its own page.
 */
export function itemHref(item: WorklistItem, ancestors: WorklistItem[]): string {
  if (item.kind === 'conversation') return conversationPath(item.id)
  const conversation = ancestors.find((a): a is WorkConversation => a.kind === 'conversation')
  if (conversation) return conversationHref(conversation.id, { kind: item.kind, id: item.id })
  return item.kind === 'run' ? runPagePath(item.id) : reviewPagePath(item.id)
}

/** The row that matches what is on screen, as an `itemKey`. */
export function activeItemKey(pathname: string, search: string): string | null {
  const conversation = /^\/plans\/([^/]+)\/?$/.exec(pathname)
  if (conversation) {
    const target = parseInspector(search)
    return target ? `${target.kind}:${target.id}` : `conversation:${decodeURIComponent(conversation[1]!)}`
  }
  const run = /^\/jobs\/([^/]+)\/?$/.exec(pathname)
  if (run && run[1] !== 'new') return `run:${decodeURIComponent(run[1]!)}`
  const review = /^\/reviews\/([^/]+)\/?$/.exec(pathname)
  if (review) return `review:${decodeURIComponent(review[1]!)}`
  return null
}

export function findItem(worklist: Worklist, key: string | null): WorklistItem | null {
  if (!key) return null
  const [kind, ...rest] = key.split(':')
  const id = rest.join(':')
  if (kind === 'conversation') return worklist.conversations.find(c => c.id === id) ?? null
  if (kind === 'run') return worklist.runs.find(r => r.id === id) ?? null
  if (kind === 'review') return worklist.reviews.find(r => r.id === id) ?? null
  return null
}

// ── Presentation ─────────────────────────────────────────────────────────────

const NEEDS_APPROVAL_META: StatusMeta = { label: 'Needs approval', category: 'waiting', tone: 'warning', pulse: true }
const DISPATCHED_META: StatusMeta = { label: 'Dispatched', category: 'idle', tone: 'neutral' }

export function itemStatusMeta(item: WorklistItem): StatusMeta {
  switch (item.kind) {
    case 'run':
      return getJobDisplayStatus(item)
    case 'review':
      return reviewStatusLabel({
        status: item.status,
        pauseReason: item.pauseReason,
        awaitingApproval: Boolean(item.awaitingApprovalJobId),
        hasPendingVerdict: Boolean(item.pendingVerdict),
        prState: item.prState,
      })
    case 'conversation':
      if (item.pendingPermissions > 0) return NEEDS_APPROVAL_META
      if (item.streaming) return CONVERSATION_WORKING_META
      if (item.status === 'closed') return CLOSED_META
      if (item.status === 'dispatched') return DISPATCHED_META
      if (item.readinessState === 'investigating' && item.openQuestions > 0) {
        return {
          label: `${item.openQuestions} question${item.openQuestions === 1 ? '' : 's'}`,
          category: 'waiting',
          tone: 'warning',
        }
      }
      return getReadinessMeta(item.readinessState)
  }
}

const ATTENTION_LABEL: Record<WorkAttentionReason, string> = {
  permission: 'Approve a tool call',
  input: 'Waiting for your answer',
  'plan-approval': 'Plan waiting for approval',
  escalated: 'Escalated',
  failed: 'Failed',
  'review-draft': 'Draft ready to approve',
  'review-verdict': 'Verdict waiting for you',
  'review-failed': 'Last round failed',
  'review-held': 'Held by a limit',
}

/** The one-line context under a row's title. */
export function itemDetail(item: WorklistItem): string | null {
  if (item.attention) {
    if (item.kind === 'run' && item.attention === 'escalated' && item.escalationMessage) {
      return firstLine(item.escalationMessage)
    }
    if (item.kind === 'run' && item.attention === 'input' && item.awaitingEvent?.startsWith('developer-input:')) {
      const reason = item.awaitingEvent.slice('developer-input:'.length).trim()
      if (reason) return firstLine(reason)
    }
    return ATTENTION_LABEL[item.attention]
  }
  switch (item.kind) {
    case 'run':
      return item.currentWorkItem || item.repo || getWorkflowSlug(item.workflowPath)
    case 'review':
      return item.prLabel
    case 'conversation':
      return null
  }
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? text
}

export function isRetrospectiveRun(item: WorklistItem): boolean {
  return item.kind === 'run' && getWorkflowSlug(item.workflowPath) === 'retrospective'
}

/** "now", "4m", "3h", "2d", "5w" — row timestamps have no room for "2 minutes ago". */
export function compactAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 45_000) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d`
  return `${Math.round(days / 7)}w`
}

const PAUSED_EVENT = 'developer-input: paused by developer'

/**
 * Why a run is waiting on the developer, or null when it is not. The same
 * states the runner groups under "Needs you"; a developer's own pause is not
 * a question for them.
 */
export function runWaitingReason(
  job: { status: string; awaitingEvent?: string | null; escalationMessage?: string | null },
): { title: string; detail: string | null } | null {
  switch (job.status) {
    case 'awaiting-developer-input': {
      if (job.awaitingEvent === PAUSED_EVENT) return null
      const reason = job.awaitingEvent?.startsWith('developer-input:')
        ? job.awaitingEvent.slice('developer-input:'.length).trim()
        : ''
      return { title: 'Waiting for your answer', detail: reason || null }
    }
    case 'awaiting-plan-approval':
      return { title: 'Plan waiting for your approval', detail: null }
    case 'escalated':
      return { title: 'Escalated', detail: job.escalationMessage?.trim() || null }
    case 'failed':
      return { title: 'Failed', detail: job.escalationMessage?.trim() || null }
    default:
      return null
  }
}
