import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import type { Dirent } from 'fs'
import * as path from 'path'
import type { ChatTool } from '@coro-ai/plugin-sdk'

/**
 * Filesystem, shell, and web tools rooted at one directory.
 *
 * Job phases and plan mode share this. Paths that escape `root` throw
 * {@link WorkspacePathError}; callers decide how to surface that (MCP
 * error payload vs thrown tool error).
 */

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspacePathError'
  }
}

export interface ShellResult {
  command: string
  cwd: string
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated?: true
  stderrTruncated?: true
  signal?: string
  timedOut?: true
  timeoutMs?: number
}

export interface WebFetchResult {
  url: string
  finalUrl: string
  status: number
  contentType: string
  text: string
  truncated: boolean
}

export interface WorkspaceTools {
  root: string
  file_read(a: { path: string }): Promise<{ path: string; content: string }>
  file_write(a: { path: string; content: string }): Promise<{ path: string; bytesWritten: number }>
  file_edit(a: { path: string; oldStr: string; newStr: string }): Promise<{ path: string; replaced: 1 }>
  file_glob(a: { pattern: string }): Promise<{ pattern: string; matches: string[] }>
  file_grep(a: { pattern: string; path?: string; isRegex?: boolean }): Promise<{
    pattern: string
    isRegex: boolean
    hits: Array<{ path: string; line: number; text: string }>
  }>
  shell(a: { command: string; cwd?: string; timeoutMs?: number }): Promise<ShellResult>
  web_fetch(a: { url: string; maxChars?: number }): Promise<WebFetchResult>
}

export const WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'file_read',
  'file_write',
  'file_edit',
  'file_glob',
  'file_grep',
  'shell',
  'web_fetch',
])

const SKIP_DIRS = new Set(['node_modules', '.git', '.coro', 'dist', 'build', '.next', '.cache'])

const HARD_TIMEOUT_MS = 600_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1024
const WEB_FETCH_TIMEOUT_MS = 20_000
const WEB_FETCH_MAX_BYTES = 1024 * 1024
const WEB_FETCH_DEFAULT_CHARS = 40_000
const WEB_FETCH_MAX_CHARS = 100_000

function resolveUnderRoot(root: string, requested: string): string | null {
  const resolved = path.resolve(root, requested)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}

async function walkDir(
  start: string,
  rootForRel: string,
  visit: (relFromRoot: string, entry: Dirent) => Promise<void>,
): Promise<void> {
  let entries: Dirent[]
  try { entries = await fs.readdir(start, { withFileTypes: true }) }
  catch { return }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const abs = path.join(start, entry.name)
    const rel = path.relative(rootForRel, abs)
    await visit(rel, entry)
    if (entry.isDirectory()) await walkDir(abs, rootForRel, visit)
  }
}

function globToRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2 }
        else { re += '.*'; i += 1 }
      } else { re += '[^/]*' }
    } else if (c === '?') { re += '[^/]' }
    else if ('.+^$(){}|[]\\'.includes(c)) { re += '\\' + c }
    else { re += c }
  }
  return new RegExp('^' + re + '$')
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|br|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ')
  const decoded = stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  return decoded
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createWorkspaceTools(opts: { root: string }): WorkspaceTools {
  const root = path.resolve(opts.root)

  return {
    root,

    async file_read({ path: requested }) {
      const abs = resolveUnderRoot(root, requested)
      if (!abs) throw new WorkspacePathError(`path escapes working dir: ${requested}`)
      const content = await fs.readFile(abs, 'utf8')
      return { path: requested, content }
    },

    async file_write({ path: requested, content }) {
      const abs = resolveUnderRoot(root, requested)
      if (!abs) throw new WorkspacePathError(`path escapes working dir: ${requested}`)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf8')
      return { path: requested, bytesWritten: Buffer.byteLength(content, 'utf8') }
    },

    async file_edit({ path: requested, oldStr, newStr }) {
      const abs = resolveUnderRoot(root, requested)
      if (!abs) throw new WorkspacePathError(`path escapes working dir: ${requested}`)
      const existing = await fs.readFile(abs, 'utf8')
      if (oldStr.length === 0) throw new WorkspacePathError('oldStr must be non-empty')
      let count = 0
      let idx = 0
      while ((idx = existing.indexOf(oldStr, idx)) !== -1) { count++; idx += oldStr.length }
      if (count === 0) throw new WorkspacePathError(`oldStr not found in ${requested}`)
      if (count > 1) throw new WorkspacePathError(`oldStr matches ${count} times in ${requested}; must be unique`)
      const updated = existing.replace(oldStr, newStr)
      await fs.writeFile(abs, updated, 'utf8')
      return { path: requested, replaced: 1 }
    },

    async file_glob({ pattern }) {
      const re = globToRegex(pattern)
      const matches: string[] = []
      await walkDir(root, root, async (rel, entry) => {
        if (entry.isFile() && re.test(rel)) matches.push(rel)
      })
      matches.sort()
      return { pattern, matches }
    },

    async file_grep({ pattern, path: subPath, isRegex }) {
      const searchRoot = subPath ? resolveUnderRoot(root, subPath) : root
      if (!searchRoot) throw new WorkspacePathError(`path escapes working dir: ${subPath}`)
      const re = isRegex
        ? new RegExp(pattern)
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const hits: { path: string; line: number; text: string }[] = []
      await walkDir(searchRoot, root, async (rel, entry) => {
        if (!entry.isFile()) return
        let buf: string
        try { buf = await fs.readFile(path.join(root, rel), 'utf8') }
        catch { return }
        const lines = buf.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) hits.push({ path: rel, line: i + 1, text: lines[i]! })
        }
      })
      return { pattern, isRegex: !!isRegex, hits }
    },

    async shell({ command, cwd: requestedCwd, timeoutMs }) {
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new WorkspacePathError('command must be a non-empty string')
      }
      const cwdAbs = requestedCwd ? resolveUnderRoot(root, requestedCwd) : root
      if (!cwdAbs) throw new WorkspacePathError(`cwd escapes working dir: ${requestedCwd}`)
      try {
        const stat = await fs.stat(cwdAbs)
        if (!stat.isDirectory()) throw new WorkspacePathError(`cwd is not a directory: ${requestedCwd ?? '.'}`)
      } catch (err) {
        if (err instanceof WorkspacePathError) throw err
        throw new WorkspacePathError(`cwd does not exist: ${requestedCwd ?? '.'}`)
      }

      const effectiveTimeout = Math.min(
        Math.max(1_000, typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS),
        HARD_TIMEOUT_MS,
      )

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), effectiveTimeout)

      try {
        const child = spawn('sh', ['-c', command], {
          cwd: cwdAbs,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          signal: controller.signal,
        })

        const collect = (stream: NodeJS.ReadableStream): Promise<{ data: string; truncated: boolean }> => {
          return new Promise(resolve => {
            const chunks: Buffer[] = []
            let total = 0
            let truncated = false
            stream.on('data', (chunk: Buffer) => {
              if (truncated) return
              const remaining = MAX_OUTPUT_BYTES - total
              if (chunk.length <= remaining) {
                chunks.push(chunk)
                total += chunk.length
              } else {
                chunks.push(chunk.subarray(0, remaining))
                total = MAX_OUTPUT_BYTES
                truncated = true
              }
            })
            stream.on('end', () => resolve({ data: Buffer.concat(chunks).toString('utf8'), truncated }))
            stream.on('error', () => resolve({ data: Buffer.concat(chunks).toString('utf8'), truncated }))
          })
        }

        const [stdoutResult, stderrResult, exit] = await Promise.all([
          collect(child.stdout!),
          collect(child.stderr!),
          new Promise<{ code: number | null; signal: NodeJS.Signals | null; aborted: boolean }>(resolve => {
            child.on('close', (code, signal) => resolve({ code, signal, aborted: controller.signal.aborted }))
            child.on('error', () => resolve({ code: null, signal: null, aborted: controller.signal.aborted }))
          }),
        ])

        const result: ShellResult = {
          command,
          cwd: requestedCwd ?? '.',
          exitCode: exit.code,
          stdout: stdoutResult.data,
          stderr: stderrResult.data,
        }
        if (stdoutResult.truncated) result.stdoutTruncated = true
        if (stderrResult.truncated) result.stderrTruncated = true
        if (exit.signal) result.signal = exit.signal
        if (exit.aborted) {
          result.timedOut = true
          result.timeoutMs = effectiveTimeout
        }
        return result
      } finally {
        clearTimeout(timer)
      }
    },

    async web_fetch({ url, maxChars }) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new WorkspacePathError(`web_fetch: invalid url: ${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new WorkspacePathError(`web_fetch: only http and https URLs are allowed (got ${parsed.protocol})`)
      }

      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'coro-plan-mode' },
      })

      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      let bodyTruncated = false
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          const remaining = WEB_FETCH_MAX_BYTES - total
          if (value.byteLength <= remaining) {
            chunks.push(value)
            total += value.byteLength
          } else {
            chunks.push(value.subarray(0, remaining))
            total = WEB_FETCH_MAX_BYTES
            bodyTruncated = true
            await reader.cancel()
            break
          }
        }
      }

      const raw = Buffer.concat(chunks).toString('utf8')
      const contentType = response.headers.get('content-type') ?? ''
      const text = /html/i.test(contentType) ? htmlToText(raw) : raw
      const limit = Math.min(
        Math.max(1, typeof maxChars === 'number' && Number.isFinite(maxChars) ? maxChars : WEB_FETCH_DEFAULT_CHARS),
        WEB_FETCH_MAX_CHARS,
      )
      const truncated = bodyTruncated || text.length > limit
      return {
        url,
        finalUrl: response.url || url,
        status: response.status,
        contentType,
        text: text.slice(0, limit),
        truncated,
      }
    },
  }
}

const SCRATCH = "this conversation's scratch directory"

export function buildWorkspaceChatTools(opts: { includeFiles: boolean; includeWeb: boolean }): ChatTool[] {
  const tools: ChatTool[] = []
  if (opts.includeFiles) {
    tools.push(
      {
        name: 'file_read',
        description: `Read a UTF-8 file from ${SCRATCH}. Path is resolved relative to that directory; absolute or \`..\`-escaping paths are rejected.`,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: `Path relative to ${SCRATCH}.` } },
          required: ['path'],
        },
      },
      {
        name: 'file_write',
        description: `Write a UTF-8 file to ${SCRATCH}, creating parent directories as needed. Overwrites existing content.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Path relative to ${SCRATCH}.` },
            content: { type: 'string', description: 'Full file contents to write.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'file_edit',
        description: 'Replace exactly one occurrence of `oldStr` with `newStr` in a file. Errors if `oldStr` is missing or matches multiple times.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Path relative to ${SCRATCH}.` },
            oldStr: { type: 'string', description: 'Exact substring to find (must appear exactly once).' },
            newStr: { type: 'string', description: 'Replacement text.' },
          },
          required: ['path', 'oldStr', 'newStr'],
        },
      },
      {
        name: 'file_glob',
        description: `Find files matching a glob pattern (\`**\`, \`*\`, \`?\`) under ${SCRATCH}. Returns a sorted list of paths relative to that directory.`,
        inputSchema: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. `src/**/*.ts`.' } },
          required: ['pattern'],
        },
      },
      {
        name: 'file_grep',
        description: `Search file contents under ${SCRATCH} for a literal substring (default) or regex (\`isRegex: true\`). Returns up to one hit per matching line.`,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Substring or regex to search for.' },
            path: { type: 'string', description: `Optional sub-path to restrict the search (relative to ${SCRATCH}).` },
            isRegex: { type: 'boolean', description: 'Treat `pattern` as a regex (default: literal substring).' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'shell',
        description: `Run a shell command (\`sh -c\`) inside ${SCRATCH}. \`cwd\` is optional and resolved relative to that directory; absolute paths or \`..\`-escapes are rejected. Returns \`{ exitCode, stdout, stderr, stdoutTruncated?, stderrTruncated?, signal?, timedOut?, timeoutMs? }\`. Default timeout is 120s, max 600s. Stdout/stderr are each capped at 64 KiB. Prefer the dedicated \`file_*\` tools for plain reads and edits. The developer approves each command unless a matching allow rule exists.`,
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute via `sh -c`.' },
            cwd: { type: 'string', description: `Working directory relative to ${SCRATCH} (default: its root).` },
            timeoutMs: { type: 'number', description: 'Wall-clock timeout in milliseconds (default 120000, max 600000).' },
          },
          required: ['command'],
        },
      },
    )
  }
  if (opts.includeWeb) {
    tools.push({
      name: 'web_fetch',
      description: 'Fetch a public http(s) URL with GET and return its text. HTML is reduced to readable text. The body is capped at 1 MiB and the returned text at 40,000 characters (override with maxChars, hard cap 100,000). The developer approves each fetch unless a matching allow rule exists.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http or https URL.' },
          maxChars: { type: 'number', description: 'Max characters of text to return (default 40000, cap 100000).' },
        },
        required: ['url'],
      },
    })
  }
  return tools
}
