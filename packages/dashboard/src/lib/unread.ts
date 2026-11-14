// "Updated since you last looked" for work-list rows.
//
// A row is unread when its signature changed while it was not on screen.
// The signature deliberately ignores `updatedAt`: a working run touches its
// record constantly, and a dot that never goes away means nothing. What
// counts is a change a developer would want to see — a run moving phase or
// parking, a plan turn finishing, a review round landing.

import { itemKey, type Worklist, type WorklistItem } from './worklist'

export type SeenMap = Record<string, string>

export function itemSignature(item: WorklistItem): string {
  switch (item.kind) {
    case 'run':
      return `${item.status}|${item.awaitingEvent ?? ''}`
    case 'conversation':
      return `${item.status}|${item.streaming ? 1 : 0}|${item.readinessState ?? ''}|${item.openQuestions}|${item.pendingPermissions > 0 ? 1 : 0}`
    case 'review':
      return `${item.status}|${item.rounds}|${item.awaitingApprovalJobId ?? ''}|${item.pendingVerdict ?? ''}`
  }
}

export function worklistItems(worklist: Worklist): WorklistItem[] {
  return [...worklist.conversations, ...worklist.runs, ...worklist.reviews]
}

/**
 * Items seen for the first time are recorded as read, so opening the app does
 * not light up everything. Visible items are marked read. Keys that left the
 * work list are dropped so the stored map stays bounded.
 */
export function reconcileSeen(
  seen: SeenMap,
  items: WorklistItem[],
  visibleKeys: ReadonlySet<string>,
): { seen: SeenMap; unread: Set<string>; changed: boolean } {
  const next: SeenMap = {}
  const unread = new Set<string>()
  let changed = false
  for (const item of items) {
    const key = itemKey(item)
    const signature = itemSignature(item)
    const previous = seen[key]
    if (previous === undefined || visibleKeys.has(key)) {
      next[key] = signature
      if (previous !== signature) changed = true
    } else {
      next[key] = previous
      if (previous !== signature) unread.add(key)
    }
  }
  if (!changed && Object.keys(seen).length !== Object.keys(next).length) changed = true
  return { seen: next, unread, changed }
}
