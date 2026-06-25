import type { ChatTool } from '@coro-ai/plugin-sdk'
import { parseMcpToolName } from '@coro-ai/plugin-sdk'
import {
  isScmPlugin,
  isTrackerPlugin,
  type PluginRegistry,
} from '../plugins/registry'
import type { ScmPluginRuntime, TrackerComment, TrackerIssue, TrackerPluginRuntime } from '../plugins/types'

export const INTAKE_MAX_FILE_BYTES = 64 * 1024
export const INTAKE_MAX_SEARCH_RESULTS = 20
export const INTAKE_TOOL_TIMEOUT_MS = 15_000
export const INTAKE_MAX_TOOL_ROUNDS = 10
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

export function buildIntakeTools(registry: PluginRegistry): ChatTool[] {
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

function parseArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

export function createIntakeRunTool(
  registry: PluginRegistry,
  signal: AbortSignal,
): (name: string, input: unknown) => Promise<unknown> {
  return async (name: string, input: unknown) => {
    const args = parseArgs(input)
    return withTimeout(
      dispatchIntakeTool(registry, name, args),
      INTAKE_TOOL_TIMEOUT_MS,
      signal,
    )
  }
}

async function dispatchIntakeTool(
  registry: PluginRegistry,
  name: string,
  args: Record<string, unknown>,
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
