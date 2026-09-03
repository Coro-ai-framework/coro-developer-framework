import {
  INVESTIGATION_LIST_DEFAULT_LIMIT,
  INVESTIGATION_LIST_MAX_LIMIT,
  type Investigation,
  type InvestigationListQuery,
  type InvestigationPatch,
  type InvestigationSummary,
  type InvestigationTurn,
} from '@coro-ai/cloud-protocol'

export const INVESTIGATION_TITLE_MAX = 40

export function clampInvestigationListQuery(
  query?: Partial<InvestigationListQuery>,
): InvestigationListQuery {
  const rawLimit = query?.limit ?? INVESTIGATION_LIST_DEFAULT_LIMIT
  const rawOffset = query?.offset ?? 0
  return {
    limit: Math.min(
      INVESTIGATION_LIST_MAX_LIMIT,
      Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : INVESTIGATION_LIST_DEFAULT_LIMIT),
    ),
    offset: Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0),
  }
}

export function truncateInvestigationTitle(
  text: string,
  max = INVESTIGATION_TITLE_MAX,
): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'Draft'
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

export function titleFromTurns(turns: InvestigationTurn[]): string {
  const first = turns.find(turn => turn.user.trim())
  return first ? truncateInvestigationTitle(first.user) : 'Draft'
}

function itemsHaveProgress(items: unknown[]): boolean {
  return items.some(item => {
    if (!item || typeof item !== 'object') return false
    const rec = item as Record<string, unknown>
    if (rec.kind === 'message' && rec.role === 'user') return true
    return rec.kind === 'card'
  })
}

/** Empty greeting-only chats must never be inserted. */
export function investigationIsPersistable(record: Investigation): boolean {
  if (record.turns.length > 0) return true
  if (record.status === 'dispatched') return true
  return itemsHaveProgress(record.items)
}

export function toInvestigationSummary(record: Investigation): InvestigationSummary {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    readiness: record.readiness,
    turnCount: record.turnCount,
    ...(record.dispatchedJobId ? { dispatchedJobId: record.dispatchedJobId } : {}),
    updatedAt: record.updatedAt,
  }
}

function hasOwn<K extends string>(obj: object, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * Merge a patch onto an existing row. Stream turns must not wipe the UI
 * transcript, and a dashboard PUT must not wipe runner turns / resume state.
 * `null` on `executorSession` / `executorId` / `dispatchedJobId` clears.
 */
export function mergeInvestigation(
  existing: Investigation | null,
  patch: InvestigationPatch,
  now: string,
): Investigation {
  const turns = patch.turns ?? existing?.turns ?? []
  const title = patch.title
    ?? existing?.title
    ?? titleFromTurns(turns)

  let executorSession = existing?.executorSession
  if (hasOwn(patch, 'executorSession')) {
    executorSession = patch.executorSession ?? undefined
  }

  let executorId = existing?.executorId
  if (hasOwn(patch, 'executorId')) {
    executorId = patch.executorId ?? undefined
  }

  let dispatchedJobId = existing?.dispatchedJobId
  if (hasOwn(patch, 'dispatchedJobId')) {
    dispatchedJobId = patch.dispatchedJobId ?? undefined
  }

  const readiness = hasOwn(patch, 'readiness')
    ? (patch.readiness ?? null)
    : (existing?.readiness ?? null)

  return {
    id: patch.id,
    title: title.trim() ? title : 'Draft',
    status: patch.status ?? existing?.status ?? 'active',
    items: patch.items ?? existing?.items ?? [],
    turns,
    ...(executorSession ? { executorSession } : {}),
    ...(executorId ? { executorId } : {}),
    modelChoice: patch.modelChoice ?? existing?.modelChoice ?? { provider: '', model: '' },
    readiness,
    turnCount: patch.turnCount ?? existing?.turnCount ?? turns.length,
    tokens: patch.tokens ?? existing?.tokens ?? 0,
    contextUsed: patch.contextUsed ?? existing?.contextUsed ?? 0,
    ...(dispatchedJobId ? { dispatchedJobId } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}
