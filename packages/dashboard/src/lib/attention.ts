// What is worth interrupting the developer for, as the work list changes.
//
// Only arrivals count: an item that entered "Needs you" since the last poll,
// or a plan-mode turn that finished. Anything already waiting when the app
// opened does not fire, so a reload never replays old notifications.

import {
  conversationHref,
  itemDetail,
  reviewPagePath,
  runPagePath,
  type Worklist,
  type WorklistItem,
} from './worklist'

export interface AttentionEvent {
  key: string
  title: string
  body: string
  path: string
}

function index(worklist: Worklist): Map<string, WorklistItem> {
  const map = new Map<string, WorklistItem>()
  for (const item of [...worklist.conversations, ...worklist.runs, ...worklist.reviews]) {
    map.set(`${item.kind}:${item.id}`, item)
  }
  return map
}

/** Where a notification about this item should land: beside its conversation when it has one. */
export function attentionPath(item: WorklistItem, worklist: Worklist): string {
  if (item.kind === 'conversation') return conversationHref(item.id)
  if (item.kind === 'run') {
    if (item.investigationId && worklist.conversations.some(c => c.id === item.investigationId)) {
      return conversationHref(item.investigationId, { kind: 'run', id: item.id })
    }
    return runPagePath(item.id)
  }
  const owner = worklist.conversations.find(c => c.reviewIds.includes(item.id))
  return owner ? conversationHref(owner.id, { kind: 'review', id: item.id }) : reviewPagePath(item.id)
}

const KIND_TITLE: Record<WorklistItem['kind'], string> = {
  conversation: 'Plan mode needs you',
  run: 'A run needs you',
  review: 'A review needs you',
}

export function diffAttention(previous: Worklist | null, next: Worklist): AttentionEvent[] {
  if (!previous) return []
  const before = index(previous)
  const events: AttentionEvent[] = []
  for (const [key, item] of index(next)) {
    const prior = before.get(key)
    if (item.group === 'needs-you' && prior && prior.group !== 'needs-you') {
      events.push({
        key,
        title: `${KIND_TITLE[item.kind]}: ${item.title}`,
        body: itemDetail(item) ?? 'Open it in Coro.',
        path: attentionPath(item, next),
      })
      continue
    }
    if (item.kind === 'conversation' && prior?.kind === 'conversation' && prior.streaming && !item.streaming && item.group !== 'needs-you') {
      events.push({
        key,
        title: `Plan mode replied: ${item.title}`,
        body: item.openQuestions > 0
          ? `${item.openQuestions} question${item.openQuestions === 1 ? '' : 's'} for you.`
          : item.readinessState === 'ready'
            ? 'Ready to start a run.'
            : 'The turn finished.',
        path: attentionPath(item, next),
      })
    }
  }
  return events
}
