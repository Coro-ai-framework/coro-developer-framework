import type { Artifact, Job } from '@coro-ai/cloud-protocol'
import { JobType } from '@coro-ai/cloud-protocol'
import {
  ArtifactPathEscapeError,
  jobWorkspaceExists,
  listJobWorkingDir,
  readJobFileSlice,
  type JobDirEntry,
} from '../jobs/artifact-content'
import type { StateBackend } from '../state/backend'
import { clamp, jobRepo } from '../tools/job-history'

export const PAST_JOB_LIST_DEFAULT_LIMIT = 10
export const PAST_JOB_LIST_MAX_LIMIT = 25
export const PAST_JOB_DESCRIPTION_MAX_CHARS = 240
export const PAST_JOB_DETAIL_DESCRIPTION_MAX_CHARS = 4_000
export const PAST_JOB_READ_DEFAULT_CHARS = 24 * 1024
export const PAST_JOB_READ_MAX_CHARS = 64 * 1024
export const PAST_JOB_LIST_FILES_MAX = 200
export const PAST_JOB_ARTIFACT_DATA_MAX_CHARS = 1_500
export const PAST_JOB_INSIGHT_MAX = 12

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
}

export interface PastJobArtifactRef {
  id: string
  phase: string
  kind: string
  title: string
  path?: string
  /** Small non-file payload (PR urls, ids). Truncated if large. */
  data?: Record<string, unknown>
  dataTruncated?: boolean
}

export interface PastJobSummary {
  id: string
  status: string
  phase: string
  repo: string
  workflowPath: string
  createdAt: string
  durationMs: number
  description: string
  workItems: Array<{ name: string; status: string }>
  insights: Array<{ category: string; summary: string }>
  prs: Array<{ workItem: string; openedAt: string; mergedAt?: string }>
}

export interface GetPastJobResult {
  summary: PastJobSummary
  artifacts: PastJobArtifactRef[]
  /** False when `{workingDir}/{jobId}` is gone (GC'd) — file reads will miss. */
  workspaceAvailable: boolean
}

export interface ReadPastJobArtifactArgs {
  jobId: string
  artifactId: string
  offset?: number
  limit?: number
}

export interface PastJobReadResult {
  jobId: string
  artifactId?: string
  kind?: string
  title?: string
  path?: string
  text?: string
  truncated?: boolean
  offset?: number
  nextOffset?: number
  totalChars?: number
  missing?: boolean
  binary?: boolean
}

export interface ListPastJobFilesArgs {
  jobId: string
  path?: string
}

export interface ListPastJobFilesResult {
  jobId: string
  path: string
  missing?: boolean
  entries: JobDirEntry[]
}

export interface ReadPastJobFileArgs {
  jobId: string
  path: string
  offset?: number
  limit?: number
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
  },
): Promise<GetPastJobResult> {
  const job = await loadJob(args.jobId, deps.stateBackend, 'get_past_job')
  const workspaceAvailable = deps.workingDir
    ? await jobWorkspaceExists(deps.workingDir, job.id)
    : false

  return {
    summary: detailSummary(job),
    artifacts: (job.artifacts ?? []).map(catalogArtifact),
    workspaceAvailable,
  }
}

export async function readPastJobArtifact(
  args: ReadPastJobArtifactArgs,
  deps: {
    stateBackend: Pick<StateBackend, 'getJob'>
    workingDir?: string
  },
): Promise<PastJobReadResult> {
  const job = await loadJob(args.jobId, deps.stateBackend, 'read_past_job_artifact')
  const artifactId = args.artifactId?.trim()
  if (!artifactId) throw new Error('read_past_job_artifact requires artifactId.')

  const artifact = (job.artifacts ?? []).find(a => a.id === artifactId)
  if (!artifact) {
    throw new Error(`read_past_job_artifact: no artefact "${artifactId}" on job "${job.id}".`)
  }

  const limit = clamp(args.limit ?? PAST_JOB_READ_DEFAULT_CHARS, 1, PAST_JOB_READ_MAX_CHARS)
  const offset = Math.max(0, Math.trunc(args.offset ?? 0))
  const base: PastJobReadResult = {
    jobId: job.id,
    artifactId: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    offset,
  }

  const rawPath = artifact.data?.['path']
  if (typeof rawPath === 'string' && rawPath.trim()) {
    base.path = rawPath
    return readPathSlice(base, deps.workingDir, job.id, rawPath, offset, limit)
  }

  const serialized = JSON.stringify(artifact.data ?? {}, null, 2)
  return applySlice(base, serialized, offset, limit)
}

export async function listPastJobFiles(
  args: ListPastJobFilesArgs,
  deps: {
    stateBackend: Pick<StateBackend, 'getJob'>
    workingDir?: string
  },
): Promise<ListPastJobFilesResult> {
  const job = await loadJob(args.jobId, deps.stateBackend, 'list_past_job_files')
  const rel = args.path?.trim() ?? ''
  if (!deps.workingDir) {
    return { jobId: job.id, path: rel || '.', missing: true, entries: [] }
  }
  try {
    const entries = await listJobWorkingDir(deps.workingDir, job.id, rel)
    return {
      jobId: job.id,
      path: rel || '.',
      entries: entries.slice(0, PAST_JOB_LIST_FILES_MAX),
    }
  } catch (err) {
    if (err instanceof ArtifactPathEscapeError) throw err
    return { jobId: job.id, path: rel || '.', missing: true, entries: [] }
  }
}

export async function readPastJobFile(
  args: ReadPastJobFileArgs,
  deps: {
    stateBackend: Pick<StateBackend, 'getJob'>
    workingDir?: string
  },
): Promise<PastJobReadResult> {
  const job = await loadJob(args.jobId, deps.stateBackend, 'read_past_job_file')
  const rel = args.path?.trim()
  if (!rel) throw new Error('read_past_job_file requires path.')

  const limit = clamp(args.limit ?? PAST_JOB_READ_DEFAULT_CHARS, 1, PAST_JOB_READ_MAX_CHARS)
  const offset = Math.max(0, Math.trunc(args.offset ?? 0))
  const base: PastJobReadResult = { jobId: job.id, path: rel, offset }
  return readPathSlice(base, deps.workingDir, job.id, rel, offset, limit)
}

/**
 * The run this investigation dispatched, if any. The plan-mode session id
 * *is* the investigation id, so no dashboard-supplied job id is involved —
 * `dispatchedJobId` on the durable record is the authority.
 *
 * Only the id is returned on purpose. Status and phase belong to
 * `get_past_job`: this value is framed into the prompt every turn, and a
 * replay executor persists what it was sent, so volatile state here would
 * accumulate as contradictory snapshots across a conversation.
 */
export async function resolveDispatchedRunId(
  investigationId: string,
  deps: { stateBackend: Pick<StateBackend, 'getInvestigation'> },
): Promise<string | null> {
  const id = investigationId.trim()
  if (!id) return null
  const investigation = await deps.stateBackend.getInvestigation(id)
  const jobId = investigation?.dispatchedJobId?.trim()
  return jobId ? jobId : null
}

async function loadJob(
  jobId: string | undefined,
  stateBackend: Pick<StateBackend, 'getJob'>,
  toolName: string,
): Promise<Job> {
  const id = jobId?.trim()
  if (!id) throw new Error(`${toolName} requires a jobId.`)
  const job = await stateBackend.getJob(id)
  if (!job) throw new Error(`${toolName}: no job found with id "${id}".`)
  return job
}

async function readPathSlice(
  base: PastJobReadResult,
  workingDir: string | undefined,
  jobId: string,
  rawPath: string,
  offset: number,
  limit: number,
): Promise<PastJobReadResult> {
  if (!workingDir) return { ...base, missing: true }
  try {
    const slice = await readJobFileSlice({
      workingDirRoot: workingDir,
      jobId,
      rawPath,
      offset,
      limit,
    })
    if (slice.binary) return { ...base, binary: true }
    return {
      ...base,
      text: slice.text,
      truncated: slice.truncated,
      offset: slice.offset,
      totalChars: slice.totalChars,
      ...(slice.nextOffset !== undefined ? { nextOffset: slice.nextOffset } : {}),
    }
  } catch (err) {
    if (err instanceof ArtifactPathEscapeError) return { ...base, missing: true }
    return { ...base, missing: true }
  }
}

function applySlice(
  base: PastJobReadResult,
  text: string,
  offset: number,
  limit: number,
): PastJobReadResult {
  const slice = text.slice(offset, offset + limit)
  const truncated = offset + slice.length < text.length
  return {
    ...base,
    text: slice,
    truncated,
    offset,
    totalChars: text.length,
    ...(truncated ? { nextOffset: offset + slice.length } : {}),
  }
}

function detailSummary(job: Job): PastJobSummary {
  const insights = (job.insights ?? []).slice(0, PAST_JOB_INSIGHT_MAX).map(insight => ({
    category: insight.category,
    summary: truncateChars(insight.editedSummary ?? insight.summary, 280).text,
  }))
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    repo: jobRepo(job),
    workflowPath: job.workflowPath,
    createdAt: job.createdAt,
    durationMs: elapsedMs(job.createdAt, job.updatedAt),
    description: truncateChars(jobParamString(job, 'description'), PAST_JOB_DETAIL_DESCRIPTION_MAX_CHARS).text,
    workItems: (job.workItems ?? []).map(item => ({ name: item.name, status: item.status })),
    insights,
    prs: (job.prMappings ?? []).map(pr => ({
      workItem: pr.workItem,
      openedAt: pr.openedAt,
      ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
    })),
  }
}

function catalogArtifact(artifact: Artifact): PastJobArtifactRef {
  const rawPath = artifact.data?.['path']
  const filePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined
  const rest: Record<string, unknown> = { ...(artifact.data ?? {}) }
  if (filePath) delete rest['path']

  const ref: PastJobArtifactRef = {
    id: artifact.id,
    phase: artifact.phase,
    kind: artifact.kind,
    title: artifact.title,
    ...(filePath ? { path: filePath } : {}),
  }

  if (Object.keys(rest).length === 0) return ref
  const serialized = JSON.stringify(rest)
  if (serialized.length <= PAST_JOB_ARTIFACT_DATA_MAX_CHARS) {
    return { ...ref, data: rest }
  }
  return {
    ...ref,
    data: { _truncated: serialized.slice(0, PAST_JOB_ARTIFACT_DATA_MAX_CHARS) },
    dataTruncated: true,
  }
}

function summarizePastJob(job: Job): PastJobListEntry {
  const kinds = [...new Set((job.artifacts ?? []).map(a => a.kind))]
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    repo: jobRepo(job),
    workflowPath: job.workflowPath,
    createdAt: job.createdAt,
    durationMs: elapsedMs(job.createdAt, job.updatedAt),
    description: truncateChars(jobParamString(job, 'description'), PAST_JOB_DESCRIPTION_MAX_CHARS).text,
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

function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}\n…[truncated]`, truncated: true }
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
