export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalCostUsd: number
}

export interface PhaseUsage {
  phase: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
  durationMs: number
  durationApiMs: number
  numTurns: number
  model: string
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
}

export interface JobSummary {
  id: string
  type: string
  serviceName: string | null
  status: string
  phase: string
  currentFeature: string | null
  triggerSource: string
  prCount: number
  totalCostUsd: number | null
  createdAt: string
  updatedAt: string
}

export interface FeatureItem {
  name: string
  status: 'pending' | 'in-progress' | 'complete' | 'escalated'
  loopCount: number
}

export interface PrMapping {
  prId: number
  feature: string
  repoSlug: string
  openedAt: string
  mergedAt?: string
}

export interface Insight {
  phase: string
  category: string
  summary: string
  detail: string
  suggestion?: string
}

export interface Job {
  id: string
  type: string
  workflowPath: string
  params: Record<string, unknown>
  triggerSource: string
  status: string
  phase: string
  currentFeature: string | null
  features: FeatureItem[]
  featureLoopCount: number
  prMappings: PrMapping[]
  insights: Insight[]
  tokenUsage?: TokenUsage
  phaseUsage?: PhaseUsage[]
  sessionId?: string
  createdAt: string
  updatedAt: string
  awaitingEvent?: string
  awaitingPrId?: number
  escalationMessage?: string
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
