export interface JobSummary {
  id: string
  type: string
  serviceName: string | null
  status: string
  phase: string
  currentFeature: string | null
  triggerSource: string
  prCount: number
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
  sessionId?: string
  createdAt: string
  updatedAt: string
  awaitingEvent?: string
  awaitingPrId?: number
  escalationMessage?: string
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
