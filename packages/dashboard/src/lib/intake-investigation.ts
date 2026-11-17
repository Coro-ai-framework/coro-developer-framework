import type { ActivityItem } from '../components/activity/types'
import type { Readiness } from './intake-readiness'
import { ApiError, jsonRequest, requestJson } from './http'

export const INVESTIGATION_TITLE_MAX = 40

export type InvestigationStatus = 'active' | 'dispatched' | 'closed'

export type ToolAccessMode = 'off' | 'ask' | 'allow'
export type IntakeBuiltinCapability = 'files' | 'filesWrite' | 'shell' | 'web' | 'runs'
export type IntakeCapability = IntakeBuiltinCapability | `mcp:${string}`
export type IntakePermissionDecision = 'once' | 'conversation' | 'always' | 'deny'
export type IntakePermissionRisk = 'normal' | 'mutating' | 'outside-scratch'

export interface InvestigationToolAccess {
  capabilities: Partial<Record<IntakeBuiltinCapability, ToolAccessMode>>
  mcp: Record<string, ToolAccessMode>
  allow: string[]
  deny: string[]
}

export interface IntakePermissionRequest {
  requestId: string
  sessionId: string
  kind: 'tool' | 'capability'
  capability: IntakeCapability
  toolName: string
  title: string
  subject: string
  detail?: unknown
  risk: IntakePermissionRisk
  suggestedRule?: string
  allowedDecisions: IntakePermissionDecision[]
  createdAt: string
  expiresAt: string
}

export interface ResolvedToolAccess {
  capabilities: Record<IntakeBuiltinCapability, ToolAccessMode>
  mcp: Record<string, ToolAccessMode>
  allow: string[]
  deny: string[]
}

export interface ToolAccessView {
  toolAccess: InvestigationToolAccess | null
  resolved: ResolvedToolAccess
  catalog: { mcpServers: Array<{ id: string; planMode: boolean }> }
  globalAllow: string[]
}

export interface ToolAccessPatch {
  capabilities?: Partial<Record<IntakeBuiltinCapability, ToolAccessMode | null>>
  mcp?: Record<string, ToolAccessMode | null>
  allow?: string[]
  deny?: string[]
}

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
  findings: string | null
  turnCount: number
  tokens: number
  contextUsed: number
  /**
   * Context window of the conversation's model, resolved by the runner on
   * read (covers the planning-tier default the picker cannot resolve).
   */
  contextWindow?: number
  dispatchedJobId?: string | null
  /** True while the runner is still inside this conversation's turn. */
  streaming?: boolean
  toolAccess?: InvestigationToolAccess | null
  pendingPermissions?: IntakePermissionRequest[]
  createdAt: string
  updatedAt: string
}


export interface InvestigationPutBody {
  items: ActivityItem[]
  readiness: Readiness | null
  findings: string | null
  modelChoice: InvestigationModelChoice
  turnCount: number
  tokens: number
  contextUsed: number
  title: string
  status?: InvestigationStatus
  dispatchedJobId?: string | null
  reviewIds?: string[]
}

export function truncateInvestigationTitle(
  text: string,
  max = INVESTIGATION_TITLE_MAX,
): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'Draft'
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** Shared by the workspace tab subtitle, PUT title, and Recents rail. */
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





export async function getInvestigation(id: string): Promise<InvestigationRecord> {
  return requestJson<InvestigationRecord>(`/intake/sessions/${encodeURIComponent(id)}`)
}

export async function putInvestigation(
  id: string,
  body: InvestigationPutBody,
): Promise<{ persisted: boolean; session: InvestigationRecord | null }> {
  return requestJson(`/intake/sessions/${encodeURIComponent(id)}`, jsonRequest(body, { method: 'PUT' }))
}

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  body: { decision: IntakePermissionDecision; rule?: string; mode?: ToolAccessMode; message?: string },
): Promise<{ resolved: boolean }> {
  return requestJson(
    `/intake/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
    jsonRequest(body, { method: 'POST' }),
  )
}

export async function getToolAccess(sessionId: string): Promise<ToolAccessView> {
  return requestJson<ToolAccessView>(`/intake/sessions/${encodeURIComponent(sessionId)}/tool-access`)
}

export async function putToolAccess(sessionId: string, patch: ToolAccessPatch): Promise<ToolAccessView> {
  return requestJson<ToolAccessView>(
    `/intake/sessions/${encodeURIComponent(sessionId)}/tool-access`,
    jsonRequest(patch, { method: 'PUT' }),
  )
}

export async function deleteInvestigation(id: string): Promise<void> {
  try {
    await requestJson(`/intake/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return
    throw err
  }
}

