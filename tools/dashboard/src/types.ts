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
  currentWorkItem: string | null
  triggerSource: string
  interactive?: boolean
  artifactCount?: number
  prCount: number
  totalCostUsd: number | null
  createdAt: string
  updatedAt: string
}

export interface WorkItem {
  name: string
  status: 'pending' | 'in-progress' | 'complete' | 'escalated'
  loopCount: number
}

export interface PrMapping {
  prId: number
  workItem: string
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

export interface Artifact {
  id: string
  phase: string
  kind: string
  title: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
}

export interface WorkflowPhase {
  name: string
  status: string
  interactiveCheckpoint?: boolean
}

export interface Job {
  id: string
  type: string
  workflowPath: string
  params: Record<string, unknown>
  triggerSource: string
  status: string
  phase: string
  currentWorkItem: string | null
  workItems: WorkItem[]
  workItemLoopCount: number
  prMappings: PrMapping[]
  interactive: boolean
  artifacts: Artifact[]
  awaitingNextPhase?: string
  insights: Insight[]
  tokenUsage?: TokenUsage
  phaseUsage?: PhaseUsage[]
  sessionId?: string
  createdAt: string
  updatedAt: string
  awaitingEvent?: string
  awaitingPrId?: number
  escalationMessage?: string
  /** Attached by the server when fetched via GET /jobs/:jobId. */
  workflowPhases?: WorkflowPhase[] | null
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
