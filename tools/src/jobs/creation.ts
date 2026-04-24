import { getPhaseConfig, loadWorkflowConfig, resolveInitialPhase } from '../workflow-parser'
import {
  emptyTokenUsage,
  type Job,
  type JobInput,
  type JobType,
  type PrMapping,
  STATUS_QUEUED,
} from './types'

type WorkflowLogger = {
  warn?: (obj: object, msg: string) => void
  debug?: (obj: object, msg: string) => void
}

export interface CreateJobRequest {
  workflowPath: string
  triggerSource?: Job['triggerSource']
  repo?: string
  serviceName?: string
  description?: string
  reviewers?: string[]
  gitProvider?: 'bitbucket' | 'github'
  jiraTicketId?: string
  interactive?: boolean
  params?: Record<string, unknown>
  type?: JobInput['type']
}

export interface JobBootstrapOptions {
  a5aiDir?: string
  logger?: WorkflowLogger
  now?: string
}

export function normalizeGitProvider(explicit: unknown): 'bitbucket' | 'github' | undefined {
  if (explicit === 'github') return 'github'
  if (explicit === 'bitbucket') return 'bitbucket'
  return undefined
}

export function createJobInput(request: CreateJobRequest): JobInput {
  const workflowPath = request.workflowPath.trim()
  if (!workflowPath) {
    throw new Error('workflowPath is required')
  }

  const params = {
    ...(request.params ?? {}),
  }

  if (request.repo) {
    params['repo'] = request.repo
    params['repoSlug'] = request.repo
  }
  if (request.serviceName) params['serviceName'] = request.serviceName
  if (request.description) params['description'] = request.description
  if (request.reviewers) params['reviewers'] = request.reviewers
  if (request.gitProvider) params['gitProvider'] = request.gitProvider
  if (request.jiraTicketId) params['jiraTicketId'] = request.jiraTicketId
  if (request.interactive === true) params['interactive'] = true

  const triggerSource = request.triggerSource ?? (request.jiraTicketId ? 'jira' : 'cli')

  return {
    type: request.type ?? 'job',
    workflowPath,
    triggerSource,
    params,
  }
}

export async function buildJobRecord(
  input: JobInput,
  jobType: JobType,
  workflowPath: string,
  options: JobBootstrapOptions = {},
): Promise<Job> {
  const now = options.now ?? new Date().toISOString()
  const triggerSource = input.triggerSource ?? 'cli'

  const config = workflowPath && options.a5aiDir
    ? await loadWorkflowConfig(workflowPath, options.a5aiDir, options.logger as Parameters<typeof loadWorkflowConfig>[2])
    : null

  const initialPhase = config
    ? resolveInitialPhase(config, triggerSource)
    : 'init'
  const phaseConfig = config ? getPhaseConfig(config, initialPhase) : null
  const initialStatus = phaseConfig?.status ?? config?.initialStatus ?? STATUS_QUEUED

  const label = (input.params['serviceName'] as string)
    ?? (input.params['jiraTicketId'] as string)
    ?? 'job'
  const id = `${sanitizeLabel(label)}-${jobType}-${Date.now()}`

  const prMappings = buildPrMappings(input.params, now)

  return {
    id,
    type: jobType,
    workflowPath,
    params: input.params,
    triggerSource,
    status: initialStatus,
    phase: initialPhase,
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings,
    interactive: input.params['interactive'] === true,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function resolveWorkflowPath(input: JobInput, fallback: string): string {
  const explicit = typeof input.workflowPath === 'string' ? input.workflowPath.trim() : ''
  const resolved = explicit || fallback
  if (!resolved) {
    throw new Error('workflowPath is required')
  }
  return resolved
}

function buildPrMappings(params: Record<string, unknown>, now: string): PrMapping[] {
  if (!params['prId'] || !params['branchName']) {
    return []
  }

  return [{
    prId: params['prId'] as number,
    workItem: params['branchName'] as string,
    repoSlug: (params['repoSlug'] as string) ?? '',
    openedAt: now,
  }]
}

function sanitizeLabel(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'job'
}