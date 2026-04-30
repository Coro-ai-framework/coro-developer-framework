import { getBaseLayerRoot } from '@coro/intelligence-base'
import { getPhaseConfig, loadWorkflowConfigFromRoots, resolveInitialPhase } from '../workflow-parser'
import {
  emptyTokenUsage,
  type Job,
  type JobInput,
  type JobType,
  type PrMapping,
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
  /**
   * Tenant overlay's locally materialised intelligence (typically
   * `~/.coro/intelligence/` or the test fixture root). Searched first
   * so tenant customisations override base.
   */
  coroIntelligenceDir?: string
  /**
   * Base layer shipped with `@coro/intelligence-base`. Searched as a
   * deterministic fallback so a missing/empty tenant overlay does not
   * cause workflow-resolution to fail. Defaults to `getBaseLayerRoot()`
   * if omitted — supplying it explicitly is recommended for tests that
   * pin a specific base layer fixture.
   */
  baseLayerDir?: string
  logger?: WorkflowLogger
  now?: string
}

/**
 * Thrown by {@link buildJobRecord} when the workflow file cannot be
 * resolved from any of the supplied roots. We surface this loudly
 * rather than silently stamping a placeholder phase — a job with no
 * workflow has no agent role and no model assignment we can reason
 * about, so creating it would just burn tokens on a phantom phase.
 */
export class WorkflowResolutionError extends Error {
  constructor(
    public readonly workflowPath: string,
    public readonly searchedRoots: ReadonlyArray<string>,
  ) {
    super(
      `Cannot resolve workflow file '${workflowPath}'. Searched roots: ` +
        `${searchedRoots.length === 0 ? '(none)' : searchedRoots.join(', ')}. ` +
        `Verify that paths.coroIntelligenceDir points at an intelligence ` +
        `tree containing this workflow, or that @coro/intelligence-base ` +
        `ships it at the same path.`,
    )
    this.name = 'WorkflowResolutionError'
  }
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

  if (!workflowPath) {
    throw new Error(
      'buildJobRecord requires a non-empty workflowPath. ' +
        'Use defaultWorkflowPath(jobType) for the canonical default.',
    )
  }

  // Resolve the workflow against the layered intelligence stack — same
  // ordering the runtime resolver uses (tenant overrides base). The
  // result is required: if neither root resolves the workflow, we
  // throw rather than fabricate a placeholder phase.
  const searchRoots = [options.coroIntelligenceDir, options.baseLayerDir ?? getBaseLayerRoot()]
    .filter((r): r is string => typeof r === 'string' && r.length > 0)

  const resolution = await loadWorkflowConfigFromRoots(
    workflowPath,
    searchRoots,
    options.logger as Parameters<typeof loadWorkflowConfigFromRoots>[2],
  )

  if (!resolution) {
    throw new WorkflowResolutionError(workflowPath, searchRoots)
  }

  const config = resolution.config
  const initialPhase = resolveInitialPhase(config, triggerSource)
  const phaseConfig = getPhaseConfig(config, initialPhase)
  if (!phaseConfig) {
    // initial_phase points at a phase that doesn't exist in the
    // declared phase list — workflow file is internally inconsistent.
    throw new Error(
      `Workflow '${workflowPath}' resolved from '${resolution.resolvedFrom}' ` +
        `declares initial_phase='${initialPhase}' but no matching phase ` +
        `entry exists. Fix the workflow file's frontmatter.`,
    )
  }
  const initialStatus = phaseConfig.status ?? config.initialStatus

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