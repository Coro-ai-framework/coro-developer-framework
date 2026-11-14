// Workflow types + remote discovery used by the new-run page and any
// future workflow pickers. The runner exposes `GET /workflows` which
// walks the layered intelligence stack — so dropping a new
// `.claude/commands/coro/<my-flow>.md` into a tenant overlay surfaces it
// here without a code change.

import { requestJson } from './lib/http'
import { workflowPathForSlug, workflowSlugFromPath } from './lib/workflow-paths'

export type WorkflowKind = 'job' | 'campaign' | 'internal'

export type IntelligenceLayer = 'base' | 'tenant' | 'repo'

export interface WorkflowPhaseSummary {
  name: string
  status: string
  agent: string | null
  model: 'planning' | 'coding'
  interactiveCheckpoint: boolean
  subagents: string[]
}

export interface WorkflowOption {
  id: string
  name: string
  workflowPath: string
  description: string
  kind: WorkflowKind
  source?: string
  /** Which intelligence layer the served file came from. */
  layer?: IntelligenceLayer
  /** Lower-priority layer this entry is shadowing, if any. */
  overrides?: IntelligenceLayer
  phases?: WorkflowPhaseSummary[]
  initialPhase?: string
}

interface WorkflowsResponse {
  workflows: WorkflowOption[]
}

/**
 * Sensible fallback used while the discovery request is in flight, or
 * if the runner is unreachable. Keeps the new-run page functional with
 * the canonical implementation workflow.
 */
export const FALLBACK_JOB_WORKFLOW: WorkflowOption = {
  id: 'job',
  name: 'Implementation Job',
  workflowPath: workflowPathForSlug('job'),
  description:
    'General-purpose work-item workflow for scoped changes in an existing repository.',
  kind: 'job',
  layer: 'base',
}

/** Legacy export retained for any caller that still imports the static list. */
export const IMPLEMENTATION_WORKFLOWS: WorkflowOption[] = [FALLBACK_JOB_WORKFLOW]

export async function fetchLaunchableWorkflows(): Promise<WorkflowOption[]> {
  const data = await requestJson<WorkflowsResponse>('/workflows?kind=job')
  return data.workflows
}

/** Keyed by workflow id, so a tenant overlay that overrides a workflow keeps its band. */
const DURATION_BANDS: Record<string, string> = {
  job: '15–35 minutes',
  'job-fast': '5–15 minutes',
  'job-deep': '45–90 minutes',
  campaign: '1–4 hours, sometimes much longer',
}

/** Coarse duration estimate for the pre-submit preview card. */
export function durationBandFor(workflowPath: string, phaseCount: number): string {
  const band = DURATION_BANDS[workflowSlugFromPath(workflowPath)]
  if (band) return band
  if (phaseCount <= 0) return 'Duration varies'
  return `${phaseCount * 8}–${phaseCount * 15} minutes (estimate)`
}
