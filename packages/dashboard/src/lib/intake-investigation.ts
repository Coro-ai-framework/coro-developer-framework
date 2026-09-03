import type { ActivityItem } from '../components/activity/types'
import type { Readiness } from './intake-readiness'
import { ApiError, jsonRequest, requestJson } from './http'

export const INVESTIGATION_LIST_PAGE_SIZE = 5
export const INVESTIGATION_TITLE_MAX = 40

export type InvestigationStatus = 'active' | 'dispatched' | 'closed'

export interface InvestigationModelChoice {
  provider: string
  model: string
}

export interface InvestigationSummary {
  id: string
  title: string
  status: InvestigationStatus
  readiness: Readiness | null
  turnCount: number
  dispatchedJobId?: string | null
  updatedAt: string
}

export interface InvestigationRecord {
  id: string
  title: string
  status: InvestigationStatus
  items: unknown[]
  turns: unknown[]
  modelChoice: InvestigationModelChoice
  readiness: Readiness | null
  turnCount: number
  tokens: number
  contextUsed: number
  dispatchedJobId?: string | null
  createdAt: string
  updatedAt: string
}

export interface InvestigationListResult {
  sessions: InvestigationSummary[]
  total: number
  limit: number
  offset: number
}

export interface InvestigationPutBody {
  items: ActivityItem[]
  readiness: Readiness | null
  modelChoice: InvestigationModelChoice
  turnCount: number
  tokens: number
  contextUsed: number
  title: string
  status?: InvestigationStatus
  dispatchedJobId?: string | null
}

export function truncateInvestigationTitle(
  text: string,
  max = INVESTIGATION_TITLE_MAX,
): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'Draft'
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** Shared by the workspace tab subtitle, PUT title, and history rail. */
export function investigationTitleFromItems(items: ActivityItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'card' && item.card.type === 'run') {
      const data = item.card.data as { run?: { serviceName?: string } }
      const name = data.run?.serviceName?.trim()
      if (name) return name
    }
  }
  const firstUser = items.find(item => item.kind === 'message' && item.role === 'user')
  if (firstUser && firstUser.kind === 'message') {
    return truncateInvestigationTitle(firstUser.text)
  }
  return 'Draft'
}

export function investigationHasProgress(items: ActivityItem[]): boolean {
  return items.some(item => (item.kind === 'message' && item.role === 'user') || item.kind === 'card')
}

export function asActivityItems(value: unknown): ActivityItem[] {
  return Array.isArray(value) ? (value as ActivityItem[]) : []
}

export function mergeInvestigationSummaries(
  list: InvestigationSummary[],
  summary: InvestigationSummary,
): InvestigationSummary[] {
  const rest = list.filter(item => item.id !== summary.id)
  return [summary, ...rest].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )
}

export function dropInvestigationSummary(
  list: InvestigationSummary[],
  id: string,
): InvestigationSummary[] {
  return list.filter(item => item.id !== id)
}

export async function listInvestigations(options?: {
  limit?: number
  offset?: number
}): Promise<InvestigationListResult> {
  const limit = options?.limit ?? INVESTIGATION_LIST_PAGE_SIZE
  const offset = options?.offset ?? 0
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  })
  return requestJson<InvestigationListResult>(`/intake/sessions?${params.toString()}`)
}

export async function getInvestigation(id: string): Promise<InvestigationRecord> {
  return requestJson<InvestigationRecord>(`/intake/sessions/${encodeURIComponent(id)}`)
}

export async function putInvestigation(
  id: string,
  body: InvestigationPutBody,
): Promise<{ persisted: boolean; session: InvestigationRecord | null }> {
  return requestJson(`/intake/sessions/${encodeURIComponent(id)}`, jsonRequest(body, { method: 'PUT' }))
}

export async function deleteInvestigation(id: string): Promise<void> {
  try {
    await requestJson(`/intake/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return
    throw err
  }
}

export function toInvestigationSummary(record: InvestigationRecord): InvestigationSummary {
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
