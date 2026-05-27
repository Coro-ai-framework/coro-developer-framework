export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalCostUsd: number
}

export interface PhaseUsage {
  phase: string
  /** Work item this phase execution was attributed to, when one was active. */
  workItem?: string
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

export type InsightLayer = 'tenant' | 'repo'
export type InsightStatus = 'pending' | 'approved' | 'rejected'

export interface Insight {
  id?: string
  phase: string
  category: string
  summary: string
  detail: string
  suggestion?: string
  sourceChildName?: string
  status?: InsightStatus
  suggestedLayer?: InsightLayer
  userLayer?: InsightLayer
  editedSummary?: string
  editedDetail?: string
  editedSuggestion?: string
  editedBy?: string
  editedAt?: string
  decidedBy?: string
  decidedAt?: string
}

export interface Artifact {
  id: string
  phase: string
  kind: string
  title: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  editedAt?: string
  editedBy?: string
}

export interface WorkflowPhase {
  name: string
  status: string
  interactiveCheckpoint?: boolean
  /**
   * Owning agent for the phase, or `null` for runner-managed
   * (“agent-less”) phases such as `coordinating`. The dashboard uses
   * this to suppress agent-centric UI (e.g. approval prompts) on
   * phases the user can't actually talk to.
   */
  agent?: string | null
}

export type CampaignChildStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'complete'
  | 'failed'
  | 'escalated'
  | 'skipped'
  | 'cancelled'

export interface TrackerRef {
  provider: 'jira' | 'github' | 'linear'
  key: string
  url: string
}

/**
 * A registered child of a campaign job. Mirrors the shape returned by
 * `GET /jobs/:campaignJobId` on the runner: the server enriches each
 * entry with a `summary` snapshot of the dispatched child Job so the
 * campaign view doesn't have to fan out to N additional fetches.
 */
export interface CampaignChild {
  name: string
  description: string
  params: Record<string, unknown>
  dependsOn: string[]
  trackerRef?: TrackerRef
  jobId?: string
  status: CampaignChildStatus
  startedAt?: string
  completedAt?: string
  summary?: {
    jobId: string
    type: string
    status: string
    phase: string
    workflowPath: string
    tokenUsage: TokenUsage
    prMappings: PrMapping[]
    createdAt: string
    updatedAt: string
    awaitingEvent?: string
    /**
     * Mirrors {@link Job.rateLimitInfo} for the underlying child Job.
     * Populated by the server's campaign-children projection so the
     * campaign table can render the countdown without a follow-up fetch.
     */
    rateLimitInfo?: {
      provider: string
      kind: 'rate-limit' | 'overloaded'
      resumeAt: number
      retryAttempt: number
      source: string
      lastErrorMessage?: string
    }
  } | null
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
  /**
   * Populated by the runner when the job is parked in
   * `awaiting-rate-limit`. Drives the countdown banner and the
   * dashboard's "Resume now" override action.
   */
  rateLimitInfo?: {
    provider: string
    kind: 'rate-limit' | 'overloaded'
    resumeAt: number
    retryAttempt: number
    source: string
    lastErrorMessage?: string
  }
  /** Attached by the server when fetched via GET /jobs/:jobId. */
  workflowPhases?: WorkflowPhase[] | null
  /**
   * Per-phase model override set by the developer from Job Detail.
   * Populated by `PATCH /jobs/:id/phase-overrides`. The runner consults
   * this map (keyed by phase name) before falling back to the workflow's
   * declared `model:` / `tier:` resolution.
   */
  phaseModelOverrides?: Record<string, { model: string; provider?: string }>
  /** Present only on campaign jobs. */
  campaignChildren?: CampaignChild[]
  /** Present only on child jobs spawned by a campaign. */
  campaignParentId?: string
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
