// Centralised UI labels for the unified "Run" surface.
//
// The dashboard treats every Job as a Run regardless of underlying workflow.
// Run shapes are distinguished by the workflow attribute (campaign vs job vs
// future workflows) and by whether the run hosts sub-runs.
//
// Every page imports its user-facing strings from this module so a future
// re-brand (Runs -> Tasks, etc.) is a one-file change.

import type { Job } from '../types'
import { isCampaignJob } from './jobs'

export const RUN_NOUN = {
  singular: 'Run',
  singularLower: 'run',
  plural: 'Runs',
  pluralLower: 'runs',
} as const

export const SUB_RUN_NOUN = {
  singular: 'Sub-run',
  singularLower: 'sub-run',
  plural: 'Sub-runs',
  pluralLower: 'sub-runs',
} as const

export const PAGE_TITLES = {
  runsList: 'Runs',
  runsListDescription: `Every ${RUN_NOUN.singularLower} on this runner. Filter by workflow or status.`,
  newRun: `New ${RUN_NOUN.singularLower}`,
  recents: 'Recents',
  recentsDescription: 'Conversations on this runner.',
  backToRuns: `Back to ${RUN_NOUN.pluralLower}`,
  newConversation: 'New conversation',
  generateRun: 'Generate run',
  runGenerated: 'Run generated',
  viewRun: 'View run',
  startRun: 'Start run',
} as const

export const CONVERSATION_COPY = {
  switchBusy: 'Coro is still working. Switch conversations? The current one stays in Recents.',
  newBusy: 'Coro is still working. Start a new conversation? This one stays in Recents.',
  newConfirm: 'Start a new conversation? This one stays in Recents.',
} as const

/** Composer home — New run. */
export const HOME_PATH = '/'
/** Canonical job inventory. */
export const RUNS_LIST_PATH = '/jobs'

/**
 * Workflow display labels. The dashboard renders these from the workflow
 * path (e.g. "workflows/job/workflow.md" -> "job") so new workflows show up
 * automatically with no code change. WORKFLOW_LABEL_OVERRIDES gives a small
 * surface for prettier copy on workflows we know about today.
 */
const WORKFLOW_LABEL_OVERRIDES: Record<string, string> = {
  job: 'job',
  campaign: 'campaign',
  'self-update': 'self-update',
}

/** Slug parsed out of "workflows/<slug>/workflow.md". */
export function getWorkflowSlug(workflowPath: string): string {
  const segments = workflowPath.split('/').filter(Boolean)
  if (segments.length >= 2) return segments[segments.length - 2]
  return segments[segments.length - 1] ?? 'workflow'
}

/** Human-readable workflow tag used in tables and badges. */
export function getWorkflowLabel(workflowPath: string): string {
  const slug = getWorkflowSlug(workflowPath)
  return WORKFLOW_LABEL_OVERRIDES[slug] ?? slug
}

/**
 * Whether this Run hosts sub-runs. The dashboard uses workflow shape (the
 * runner's `campaignChildren` field is the underlying signal today, but new
 * workflows can opt in via the same field name once the runner exposes a
 * workflow-extension contract — see plan B/C).
 */
export function hostsSubRuns(job: Pick<Job, 'workflowPath' | 'campaignChildren'>): boolean {
  return isCampaignJob(job)
}

/**
 * Parent Run id when this Run was dispatched as a sub-run of another.
 * Internally still routed via `campaignParentId` until the runner generic
 * extension surface lands.
 */
export function getParentRunId(job: Pick<Job, 'campaignParentId'>): string | null {
  return job.campaignParentId ?? null
}

export type WorkflowFilter = 'all' | string

export interface WorkflowFilterOption {
  value: WorkflowFilter
  label: string
}

/**
 * Build the workflow filter options from the set of workflows currently
 * present in the job list. Always includes "All". Future-proof: a new
 * workflow appearing in the runner's job stream surfaces here automatically.
 */
export function deriveWorkflowFilterOptions(jobs: Pick<Job, 'workflowPath'>[]): WorkflowFilterOption[] {
  const seen = new Set<string>()
  for (const job of jobs) {
    seen.add(getWorkflowSlug(job.workflowPath))
  }
  const options: WorkflowFilterOption[] = [{ value: 'all', label: 'All workflows' }]
  for (const slug of Array.from(seen).sort()) {
    options.push({ value: slug, label: WORKFLOW_LABEL_OVERRIDES[slug] ?? slug })
  }
  return options
}

/**
 * Tag short label used inside Run rows (e.g. the workflow chip on the
 * left-hand cell of the Runs table).
 */
export function getRunWorkflowTag(job: Pick<Job, 'workflowPath'>): string {
  return getWorkflowLabel(job.workflowPath)
}

/** Long-form description for the parent-run breadcrumb shown on a sub-run. */
export function getParentRunBreadcrumbLabel(): string {
  return `Parent ${RUN_NOUN.singularLower}`
}