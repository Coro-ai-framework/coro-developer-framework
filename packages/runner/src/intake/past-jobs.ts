import type { Artifact, Job } from '@coro-ai/cloud-protocol'
import { JobType } from '@coro-ai/cloud-protocol'
import {
  ArtifactPathEscapeError,
  readJobArtifactFile,
} from '../jobs/artifact-content'
import type { StateBackend } from '../state/backend'
import { buildJobReport, clamp, jobRepo, type JobReport } from '../tools/job-history'

export const PAST_JOB_LIST_DEFAULT_LIMIT = 10
export const PAST_JOB_LIST_MAX_LIMIT = 25
export const PAST_JOB_DESCRIPTION_MAX_CHARS = 240
export const PAST_JOB_MAX_CONTENT_BYTES = 64 * 1024

/**
 * Artefact kinds whose bodies are useful in plan mode when the caller
 * does not name a filter. Skips opaque/huge blobs.
 */
export const DEFAULT_PAST_JOB_ARTIFACT_KINDS = [
  'plan-md',
  'implementation-plan-md',
  'evaluation-md',
  'report-md',
  'test-results',
  'pr-link',
  'pr-preview',
] as const

export interface ListPastJobsArgs {
  repo?: string
  status?: string
  limit?: number
  since?: string
}

export interface PastJobListEntry {
  id: string
  status: string
  phase: string
  repo: string
  workflowPath: string
  createdAt: string
  durationMs: number
  description: string
  workItemCount: number
  artifactKinds: string[]
}

export interface ListPastJobsResult {
  total: number
  returned: number
  jobs: PastJobListEntry[]
}

export interface GetPastJobArgs {
  jobId: string
  artifactKinds?: string[]
  includeContent?: boolean
}

export interface PastJobArtifactContent {
  artifactId: string
  kind: string
  title: string
  path?: string
  text?: string
  truncated?: boolean
  missing?: boolean
}

export interface GetPastJobResult {
  summary: JobReport
  artifacts: Artifact[]
  contents?: PastJobArtifactContent[]
}

export async function listPastJobs(
  args: ListPastJobsArgs,
  deps: { stateBackend: Pick<StateBackend, 'listJobs'> },
): Promise<ListPastJobsResult> {
  const all = await deps.stateBackend.listJobs()
  const sinceMs = parseSince(args.since)
  const repoNeedle = args.repo?.trim() ?? ''
  const status = args.status?.trim() ?? ''

  const matching = all.filter(job => {
    if (job.type !== JobType.Job) return false
    if (status && job.status !== status) return false
    if (sinceMs !== null && Date.parse(job.createdAt) < sinceMs) return false
    if (repoNeedle && !jobMatchesRepo(job, repoNeedle)) return false
    return true
  })

  const limit = clamp(args.limit ?? PAST_JOB_LIST_DEFAULT_LIMIT, 1, PAST_JOB_LIST_MAX_LIMIT)
  const page = matching
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)

  return {
    total: matching.length,
    returned: page.length,
    jobs: page.map(summarizePastJob),
  }
}

export async function getPastJob(
  args: GetPastJobArgs,
  deps: {
    stateBackend: Pick<StateBackend, 'getJob'>
    workingDir?: string
    maxContentBytes?: number
  },
): Promise<GetPastJobResult> {
  const jobId = args.jobId?.trim()
  if (!jobId) throw new Error('get_past_job requires a jobId.')

  const job = await deps.stateBackend.getJob(jobId)
  if (!job) throw new Error(`get_past_job: no job found with id "${jobId}".`)

  const artifacts = job.artifacts ?? []
  const includeContent = args.includeContent !== false
  const result: GetPastJobResult = {
    summary: buildJobReport(job, null),
    artifacts,
  }
  if (!includeContent) return result

  const kinds = normalizeKindFilter(args.artifactKinds)
  const selected = artifacts.filter(artifact => kinds.has(artifact.kind))
  const maxBytes = deps.maxContentBytes ?? PAST_JOB_MAX_CONTENT_BYTES
  result.contents = await Promise.all(
    selected.map(artifact => readArtifactContent(artifact, jobId, deps.workingDir, maxBytes)),
  )
  return result
}

function summarizePastJob(job: Job): PastJobListEntry {
  const kinds = [...new Set((job.artifacts ?? []).map(a => a.kind))]
  const rawDescription = jobParamString(job, 'description')
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    repo: jobRepo(job),
    workflowPath: job.workflowPath,
    createdAt: job.createdAt,
    durationMs: elapsedMs(job.createdAt, job.updatedAt),
    description: truncateChars(rawDescription, PAST_JOB_DESCRIPTION_MAX_CHARS).text,
    workItemCount: job.workItems?.length ?? 0,
    artifactKinds: kinds,
  }
}

function jobMatchesRepo(job: Job, repo: string): boolean {
  const needle = repo.trim().toLowerCase()
  if (!needle) return true
  const candidates = [jobRepo(job), jobParamString(job, 'repoSlug'), jobParamString(job, 'repo')]
  for (const value of candidates) {
    const hay = value.toLowerCase()
    if (!hay) continue
    if (hay === needle || hay.endsWith(`/${needle}`)) return true
  }
  return false
}

function jobParamString(job: Job, key: string): string {
  const value = job.params?.[key]
  return typeof value === 'string' ? value : ''
}

function normalizeKindFilter(artifactKinds?: string[]): Set<string> {
  if (!artifactKinds || artifactKinds.length === 0) {
    return new Set(DEFAULT_PAST_JOB_ARTIFACT_KINDS)
  }
  return new Set(artifactKinds.map(k => k.trim()).filter(Boolean))
}

async function readArtifactContent(
  artifact: Artifact,
  jobId: string,
  workingDir: string | undefined,
  maxBytes: number,
): Promise<PastJobArtifactContent> {
  const base: PastJobArtifactContent = {
    artifactId: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
  }
  const rawPath = artifact.data?.['path']
  if (typeof rawPath === 'string' && rawPath.trim()) {
    base.path = rawPath
    if (!workingDir) {
      return { ...base, missing: true }
    }
    try {
      const text = await readJobArtifactFile(workingDir, jobId, rawPath)
      const clipped = truncateToBytes(text, maxBytes)
      return {
        ...base,
        text: clipped.text,
        ...(clipped.truncated ? { truncated: true } : {}),
      }
    } catch (err) {
      if (err instanceof ArtifactPathEscapeError) {
        return { ...base, missing: true }
      }
      return { ...base, missing: true }
    }
  }

  const serialized = JSON.stringify(artifact.data ?? {}, null, 2)
  const clipped = truncateToBytes(serialized, maxBytes)
  return {
    ...base,
    text: clipped.text,
    ...(clipped.truncated ? { truncated: true } : {}),
  }
}

function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}\n…[truncated]`, truncated: true }
}

function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return { text, truncated: false }
  let end = Math.min(text.length, maxBytes)
  let slice = text.slice(0, end)
  while (end > 0 && Buffer.byteLength(slice, 'utf-8') > maxBytes) {
    end -= 1
    slice = text.slice(0, end)
  }
  return { text: `${slice}\n…[truncated]`, truncated: true }
}

function elapsedMs(from: string, to: string): number {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, end - start)
}

function parseSince(since?: string): number | null {
  if (!since?.trim()) return null
  const parsed = Date.parse(since)
  if (!Number.isFinite(parsed)) {
    throw new Error(`list_past_jobs: "since" must be an ISO timestamp, got "${since}".`)
  }
  return parsed
}
