import type { ChatTool } from '@coro-ai/plugin-sdk'
import { parseMcpToolName } from '@coro-ai/plugin-sdk'
import {
  isScmPlugin,
  isTrackerPlugin,
  type PluginRegistry,
} from '../plugins/registry'
import type { ScmPluginRuntime, TrackerComment, TrackerIssue, TrackerPluginRuntime } from '../plugins/types'
import type { StateBackend } from '../state/backend'
import {
  getPastJob,
  listPastJobFiles,
  listPastJobs,
  PAST_JOB_LIST_DEFAULT_LIMIT,
  PAST_JOB_LIST_MAX_LIMIT,
  PAST_JOB_READ_DEFAULT_CHARS,
  PAST_JOB_READ_MAX_CHARS,
  readPastJobArtifact,
  readPastJobFile,
} from './past-jobs'

export const INTAKE_MAX_FILE_BYTES = 64 * 1024
export const INTAKE_MAX_SEARCH_RESULTS = 20
export const INTAKE_TOOL_TIMEOUT_MS = 15_000
/**
 * The per-turn tool loop is the only place plan mode spends without a
 * developer between steps, so this ceiling stays even though the session
 * turn/token caps are gone. Sized for an investigation that has to walk a
 * repo it has never seen rather than for a three-question intake.
 */
export const INTAKE_MAX_TOOL_ROUNDS = 25
/** Hard cap on a single tracker description we hand back to the LLM. */
export const INTAKE_MAX_TRACKER_DESCRIPTION_CHARS = 8 * 1024
/** Hard cap on how many comments a single tracker_get_comments call returns. */
export const INTAKE_MAX_TRACKER_COMMENTS = 50
/** Hard cap on a single comment body we hand back to the LLM. */
export const INTAKE_MAX_TRACKER_COMMENT_CHARS = 4 * 1024

const PLUGIN_ID_SCHEMA = {
  type: 'string',
  description: 'Optional plugin id when multiple trackers or SCM providers are installed (e.g. "jira", "github").',
}

function hasTrackerMethod(
  registry: PluginRegistry,
  method: keyof Pick<TrackerPluginRuntime, 'getIssue' | 'searchIssues' | 'getComments'>,
): boolean {
  return registry.all().some(p => isTrackerPlugin(p) && typeof p[method] === 'function')
}

function hasScmMethod(
  registry: PluginRegistry,
  method: keyof Pick<ScmPluginRuntime, 'readFile' | 'searchCode' | 'listFiles'>,
): boolean {
  return registry.all().some(p => isScmPlugin(p) && typeof p[method] === 'function')
}

/** Hard cap on entries returned to the LLM in a single list_files call. */
export const INTAKE_MAX_LIST_FILES = 200

export interface IntakeToolDeps {
  stateBackend?: StateBackend
  workingDir?: string
}

export function buildIntakeTools(
  registry: PluginRegistry,
  deps?: Pick<IntakeToolDeps, 'stateBackend'>,
): ChatTool[] {
  const tools: ChatTool[] = []

  if (hasTrackerMethod(registry, 'getIssue')) {
    tools.push({
      name: 'tracker_get_issue',
      description: 'Fetch a tracker issue by key (e.g. PROJ-123, ENG-42, owner/repo#7). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Issue key or identifier.' },
          pluginId: PLUGIN_ID_SCHEMA,
        },
        required: ['key'],
      },
    })
  }

  if (hasTrackerMethod(registry, 'getComments')) {
    tools.push({
      name: 'tracker_get_comments',
      description:
        'Read the comment thread on a tracker issue (human guidance, ' +
        'clarifications, follow-up requests). Comments are NOT included in ' +
        'tracker_get_issue, so call this when a ticket likely has discussion ' +
        'that shapes the work. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Issue key or identifier.' },
          pluginId: PLUGIN_ID_SCHEMA,
        },
        required: ['key'],
      },
    })
  }

  if (hasTrackerMethod(registry, 'searchIssues')) {
    tools.push({
      name: 'tracker_search_issues',
      description: 'Search tracker issues by free-text query. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms.' },
          maxResults: { type: 'number', description: 'Max results (default 10, cap 20).' },
          pluginId: PLUGIN_ID_SCHEMA,
        },
        required: ['query'],
      },
    })
  }

  if (hasScmMethod(registry, 'readFile')) {
    tools.push({
      name: 'scm_read_file',
      description: 'Read a single file from a repository via the SCM API. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository slug or owner/repo.' },
          path: { type: 'string', description: 'File path within the repo.' },
          ref: { type: 'string', description: 'Git ref (branch, tag, commit). Defaults to HEAD.' },
          pluginId: PLUGIN_ID_SCHEMA,
        },
        required: ['repo', 'path'],
      },
    })
  }

  if (hasScmMethod(registry, 'searchCode')) {
    tools.push({
      name: 'scm_search_code',
      description:
        'Search code in a repository for a symbol or string. Read-only. ' +
        'On Bitbucket Cloud this can return 0 hits even for code that exists ' +
        '(workspaces below Standard plan are not indexed) — if that happens, ' +
        'switch to scm_list_files to discover the repo structure instead of retrying.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository slug or owner/repo.' },
          query: { type: 'string', description: 'Code search query.' },
          maxResults: { type: 'number', description: 'Max results (default 10, cap 20).' },
          pluginId: PLUGIN_ID_SCHEMA,
        },
        required: ['repo', 'query'],
      },
    })
  }

  if (hasScmMethod(registry, 'listFiles')) {
    tools.push({
      name: 'scm_list_files',
      description:
        'List entries in a repository directory. Read-only. Use this when ' +
        'you do not know the layout — call once on the repo root, then ' +
        'descend into the subdirectories that look relevant. Prefer this ' +
        'over guessing file paths.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository slug or owner/repo.' },
          path: {
            type: 'string',
            description: 'Directory path within the repo. Omit or use "" / "/" for the repo root.',
          },
          ref: { type: 'string', description: 'Git ref (branch, tag, commit). Defaults to the default branch.' },
          pluginId: PLUGIN_ID_SCHEMA,
        },
        required: ['repo'],
      },
    })
  }

  if (deps?.stateBackend) {
    tools.push({
      name: 'list_past_jobs',
      description:
        'List recent implementation jobs on this install. Read-only. ' +
        'Use when the developer references a prior run, or when earlier work ' +
        'on the same repo likely shapes this investigation. Filter by repo ' +
        'when you know it. Do not guess job ids — list first, then call get_past_job.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Repository slug or owner/repo. Matches repoSlug / repo on the job.',
          },
          status: {
            type: 'string',
            description: 'Exact job status filter (e.g. "complete", "escalated").',
          },
          limit: {
            type: 'number',
            description: `Max jobs to return (default ${PAST_JOB_LIST_DEFAULT_LIMIT}, cap ${PAST_JOB_LIST_MAX_LIMIT}).`,
          },
          since: {
            type: 'string',
            description: 'ISO timestamp; only jobs created at or after this are returned.',
          },
        },
      },
    })
    tools.push({
      name: 'get_past_job',
      description:
        'Open one past job by id. Returns a short summary plus an artefact catalog ' +
        '(id, kind, title, path) — not file bodies. Then call read_past_job_artifact ' +
        'or list_past_job_files / read_past_job_file to crawl. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job id from list_past_jobs or the developer.' },
        },
        required: ['jobId'],
      },
    })
    tools.push({
      name: 'read_past_job_artifact',
      description:
        'Read one artefact from a past job by artefact id (from get_past_job). ' +
        'Use offset/nextOffset to page through large files. Do not dump every artefact.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job id.' },
          artifactId: { type: 'string', description: 'Artefact id from get_past_job.' },
          offset: {
            type: 'number',
            description: 'Character offset into the artefact text (from nextOffset on a truncated read).',
          },
          limit: {
            type: 'number',
            description: `Max characters to return (default ${PAST_JOB_READ_DEFAULT_CHARS}, cap ${PAST_JOB_READ_MAX_CHARS}).`,
          },
        },
        required: ['jobId', 'artifactId'],
      },
    })
    tools.push({
      name: 'list_past_job_files',
      description:
        'List one directory in a past job\'s working directory (checkout, plans, reports). ' +
        'Same pattern as scm_list_files: call on the root (omit path), then descend. ' +
        '.git is omitted. Read-only. Missing workspace → missing: true.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job id.' },
          path: {
            type: 'string',
            description: 'Directory relative to the job working dir. Omit or "" / "." for the root.',
          },
        },
        required: ['jobId'],
      },
    })
    tools.push({
      name: 'read_past_job_file',
      description:
        'Read one file from a past job\'s working directory. Confirm the path with ' +
        'list_past_job_files (or an artefact path) first. Page with offset/nextOffset.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job id.' },
          path: { type: 'string', description: 'File path relative to the job working directory.' },
          offset: {
            type: 'number',
            description: 'Character offset into the file (from nextOffset on a truncated read).',
          },
          limit: {
            type: 'number',
            description: `Max characters to return (default ${PAST_JOB_READ_DEFAULT_CHARS}, cap ${PAST_JOB_READ_MAX_CHARS}).`,
          },
        },
        required: ['jobId', 'path'],
      },
    })
  }

  return tools
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Aborted'))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms`)), ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Builds the user-facing summary line shown in the chat bubble for a
 * completed tool call. Pulls the per-call key / path out of the
 * arguments and the result count out of the output so the dashboard
 * shows e.g. "Read PROJ-123" instead of the generic "Read ticket".
 *
 * Exported because the intake handler invokes it from inside the
 * executor's `onToolEnd` callback — the dispatcher itself stays a
 * thin plumbing layer with no UX concerns.
 */
export function summarizeToolCall(name: string, input: unknown, output: unknown): string {
  if (name === 'tracker_get_issue') {
    const key = readField(input, 'key')
    return key ? `Read ${key}` : 'Read ticket'
  }
  if (name === 'tracker_get_comments') {
    const key = readField(input, 'key')
    const count = Array.isArray(output) ? output.length : 0
    const where = key ? ` on ${key}` : ''
    return `Read ${count} comment${count === 1 ? '' : 's'}${where}`
  }
  if (name === 'tracker_search_issues') {
    const count = Array.isArray(output) ? output.length : 0
    return `Found ${count} ticket${count === 1 ? '' : 's'}`
  }
  if (name === 'scm_read_file') {
    const path = readField(input, 'path')
    return path ? `Read ${path}` : 'Read file'
  }
  if (name === 'scm_search_code') {
    const count = Array.isArray(output) ? output.length : 0
    return `Found ${count} code hit${count === 1 ? '' : 's'}`
  }
  if (name === 'scm_list_files') {
    const count = Array.isArray(output) ? output.length : 0
    const path = readField(input, 'path') ?? ''
    const where = path ? ` in ${path}` : ''
    return `Listed ${count} entr${count === 1 ? 'y' : 'ies'}${where}`
  }
  if (name === 'list_past_jobs') {
    const jobs = output && typeof output === 'object' && 'jobs' in output
      ? (output as { jobs: unknown }).jobs
      : null
    const count = Array.isArray(jobs) ? jobs.length : 0
    return `Listed ${count} past job${count === 1 ? '' : 's'}`
  }
  if (name === 'get_past_job') {
    const id = readField(input, 'jobId')
    return id ? `Opened past job ${id}` : 'Opened past job'
  }
  if (name === 'read_past_job_artifact') {
    const id = readField(input, 'artifactId')
    return id ? `Read artefact ${id}` : 'Read artefact'
  }
  if (name === 'list_past_job_files') {
    const count = readEntriesCount(output)
    const where = readField(input, 'path')
    return `Listed ${count} job ${count === 1 ? 'entry' : 'entries'}${where ? ` in ${where}` : ''}`
  }
  if (name === 'read_past_job_file') {
    const filePath = readField(input, 'path')
    return filePath ? `Read job file ${filePath}` : 'Read job file'
  }
  const mcp = parseMcpToolName(name)
  if (mcp) {
    return `${mcp.serverId}: ${mcp.toolName}`
  }
  return 'Done'
}

function readField(input: unknown, field: string): string | null {
  if (input && typeof input === 'object' && field in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>)[field]
    return v == null ? null : String(v)
  }
  return null
}

function readEntriesCount(output: unknown): number {
  if (output && typeof output === 'object' && 'entries' in output) {
    const entries = (output as { entries: unknown }).entries
    if (Array.isArray(entries)) return entries.length
  }
  return Array.isArray(output) ? output.length : 0
}

function parseArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

export function createIntakeRunTool(
  registry: PluginRegistry,
  signal: AbortSignal,
  deps: IntakeToolDeps = {},
): (name: string, input: unknown) => Promise<unknown> {
  return async (name: string, input: unknown) => {
    const args = parseArgs(input)
    return withTimeout(
      dispatchIntakeTool(registry, name, args, deps),
      INTAKE_TOOL_TIMEOUT_MS,
      signal,
    )
  }
}

async function dispatchIntakeTool(
  registry: PluginRegistry,
  name: string,
  args: Record<string, unknown>,
  deps: IntakeToolDeps,
): Promise<unknown> {
  switch (name) {
    case 'tracker_get_issue': {
      const key = String(args.key ?? '').trim()
      if (!key) throw new Error('tracker_get_issue requires key')
      const tracker = registry.resolveTracker({
        tracker: typeof args.pluginId === 'string' ? args.pluginId : undefined,
      })
      if (!tracker.getIssue) throw new Error('No tracker plugin exposes getIssue')
      const issue = await tracker.getIssue(key)
      return clampTrackerIssue(issue)
    }
    case 'tracker_get_comments': {
      const key = String(args.key ?? '').trim()
      if (!key) throw new Error('tracker_get_comments requires key')
      const tracker = registry.resolveTracker({
        tracker: typeof args.pluginId === 'string' ? args.pluginId : undefined,
      })
      if (!tracker.getComments) throw new Error('No tracker plugin exposes getComments')
      const comments = await tracker.getComments(key)
      return comments.slice(0, INTAKE_MAX_TRACKER_COMMENTS).map(clampTrackerComment)
    }
    case 'tracker_search_issues': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('tracker_search_issues requires query')
      const limit = Math.min(
        Math.max(Number(args.maxResults ?? 10) || 10, 1),
        INTAKE_MAX_SEARCH_RESULTS,
      )
      const tracker = registry.resolveTracker({
        tracker: typeof args.pluginId === 'string' ? args.pluginId : undefined,
      })
      if (!tracker.searchIssues) throw new Error('No tracker plugin exposes searchIssues')
      const issues = await tracker.searchIssues(query, limit)
      return issues.map(clampTrackerIssue)
    }
    case 'scm_read_file': {
      const repo = String(args.repo ?? '').trim()
      const path = String(args.path ?? '').trim()
      if (!repo || !path) throw new Error('scm_read_file requires repo and path')
      const scm = registry.resolveScm({
        scm: typeof args.pluginId === 'string' ? args.pluginId : undefined,
      })
      if (!scm.readFile) throw new Error('No SCM plugin exposes readFile')
      return scm.readFile({
        repo,
        path,
        ...(typeof args.ref === 'string' && args.ref.trim() ? { ref: args.ref.trim() } : {}),
      })
    }
    case 'scm_search_code': {
      const repo = String(args.repo ?? '').trim()
      const query = String(args.query ?? '').trim()
      if (!repo || !query) throw new Error('scm_search_code requires repo and query')
      const limit = Math.min(
        Math.max(Number(args.maxResults ?? 10) || 10, 1),
        INTAKE_MAX_SEARCH_RESULTS,
      )
      const scm = registry.resolveScm({
        scm: typeof args.pluginId === 'string' ? args.pluginId : undefined,
      })
      if (!scm.searchCode) throw new Error('No SCM plugin exposes searchCode')
      return scm.searchCode({ repo, query, maxResults: limit })
    }
    case 'scm_list_files': {
      const repo = String(args.repo ?? '').trim()
      if (!repo) throw new Error('scm_list_files requires repo')
      const scm = registry.resolveScm({
        scm: typeof args.pluginId === 'string' ? args.pluginId : undefined,
      })
      if (!scm.listFiles) throw new Error('No SCM plugin exposes listFiles')
      const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
      const entries = await scm.listFiles({
        repo,
        ...(rawPath ? { path: rawPath } : {}),
        ...(typeof args.ref === 'string' && args.ref.trim() ? { ref: args.ref.trim() } : {}),
      })
      // Cap server-side so a huge directory can't blow the per-turn
      // token budget. The plugin already caps its own paging (BB:
      // 200), but a single page from GitHub can return up to 1000.
      return entries.slice(0, INTAKE_MAX_LIST_FILES)
    }
    case 'list_past_jobs': {
      if (!deps.stateBackend) throw new Error('list_past_jobs requires job history (state backend unavailable)')
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      return listPastJobs(
        {
          ...(typeof args.repo === 'string' ? { repo: args.repo } : {}),
          ...(typeof args.status === 'string' ? { status: args.status } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(typeof args.since === 'string' ? { since: args.since } : {}),
        },
        { stateBackend: deps.stateBackend },
      )
    }
    case 'get_past_job': {
      if (!deps.stateBackend) throw new Error('get_past_job requires job history (state backend unavailable)')
      const jobId = String(args.jobId ?? '').trim()
      if (!jobId) throw new Error('get_past_job requires jobId')
      return getPastJob(
        { jobId },
        {
          stateBackend: deps.stateBackend,
          ...(deps.workingDir ? { workingDir: deps.workingDir } : {}),
        },
      )
    }
    case 'read_past_job_artifact': {
      if (!deps.stateBackend) throw new Error('read_past_job_artifact requires job history (state backend unavailable)')
      const jobId = String(args.jobId ?? '').trim()
      const artifactId = String(args.artifactId ?? '').trim()
      if (!jobId) throw new Error('read_past_job_artifact requires jobId')
      if (!artifactId) throw new Error('read_past_job_artifact requires artifactId')
      return readPastJobArtifact(
        {
          jobId,
          artifactId,
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        },
        {
          stateBackend: deps.stateBackend,
          ...(deps.workingDir ? { workingDir: deps.workingDir } : {}),
        },
      )
    }
    case 'list_past_job_files': {
      if (!deps.stateBackend) throw new Error('list_past_job_files requires job history (state backend unavailable)')
      const jobId = String(args.jobId ?? '').trim()
      if (!jobId) throw new Error('list_past_job_files requires jobId')
      return listPastJobFiles(
        {
          jobId,
          ...(typeof args.path === 'string' ? { path: args.path } : {}),
        },
        {
          stateBackend: deps.stateBackend,
          ...(deps.workingDir ? { workingDir: deps.workingDir } : {}),
        },
      )
    }
    case 'read_past_job_file': {
      if (!deps.stateBackend) throw new Error('read_past_job_file requires job history (state backend unavailable)')
      const jobId = String(args.jobId ?? '').trim()
      const filePath = String(args.path ?? '').trim()
      if (!jobId) throw new Error('read_past_job_file requires jobId')
      if (!filePath) throw new Error('read_past_job_file requires path')
      return readPastJobFile(
        {
          jobId,
          path: filePath,
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        },
        {
          stateBackend: deps.stateBackend,
          ...(deps.workingDir ? { workingDir: deps.workingDir } : {}),
        },
      )
    }
    default:
      throw new Error(`Unknown plan-mode tool: ${name}`)
  }
}

/**
 * Tracker descriptions can be unbounded (Jira/Linear allow novel-length
 * bodies). The file-read tool already enforces a 64 KB cap; mirror that
 * spirit here so a single oversized ticket can't blow the per-turn
 * token budget. We only touch `description` — keys, summaries, and
 * status text are always small.
 */
function clampTrackerIssue(issue: TrackerIssue): TrackerIssue {
  if (!issue.description || issue.description.length <= INTAKE_MAX_TRACKER_DESCRIPTION_CHARS) {
    return issue
  }
  return {
    ...issue,
    description: `${issue.description.slice(0, INTAKE_MAX_TRACKER_DESCRIPTION_CHARS)}\n…[truncated]`,
  }
}

/**
 * Same spirit as {@link clampTrackerIssue}: a single comment body can be
 * arbitrarily long, and a thread can have many of them. We cap each body
 * so one verbose comment can't blow the per-turn token budget (the count
 * itself is capped in the dispatcher via {@link INTAKE_MAX_TRACKER_COMMENTS}).
 */
function clampTrackerComment(comment: TrackerComment): TrackerComment {
  if (!comment.body || comment.body.length <= INTAKE_MAX_TRACKER_COMMENT_CHARS) {
    return comment
  }
  return {
    ...comment,
    body: `${comment.body.slice(0, INTAKE_MAX_TRACKER_COMMENT_CHARS)}\n…[truncated]`,
  }
}
