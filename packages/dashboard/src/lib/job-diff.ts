import { requestJson } from './http'

// ── Job diff API + unified-diff parsing ─────────────────────────────────────
//
// Mirrors the runner's `GET /jobs/:id/diff` payload (see
// packages/runner/src/jobs/job-diff.ts) and turns the raw unified-diff text
// into a structured, render-friendly shape for the Changes tab / PR preview.

export interface JobDiffFile {
  path: string
  insertions: number
  deletions: number
  binary: boolean
}

export interface JobDiff {
  base: string
  head: string
  available: boolean
  stats: { files: number; insertions: number; deletions: number }
  files: JobDiffFile[]
  patch: string
  truncated: boolean
}

export interface FetchJobDiffOptions {
  base?: string
  /** Work-item branch to scope the diff to (defaults to the working tree). */
  head?: string
}

export async function fetchJobDiff(jobId: string, opts: FetchJobDiffOptions = {}): Promise<JobDiff> {
  const params = new URLSearchParams()
  if (opts.base) params.set('base', opts.base)
  if (opts.head) params.set('head', opts.head)
  const qs = params.toString()
  return requestJson<JobDiff>(`/jobs/${jobId}/diff${qs ? `?${qs}` : ''}`)
}

// ── Parsed representation ────────────────────────────────────────────────────

export type DiffLineType = 'add' | 'del' | 'context'
export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export interface ParsedDiffLine {
  type: DiffLineType
  /** Content without the leading +/-/space marker. */
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface ParsedDiffHunk {
  header: string
  lines: ParsedDiffLine[]
}

export interface ParsedDiffFile {
  oldPath: string
  newPath: string
  /** Display path (newPath, or oldPath for deletions). */
  path: string
  status: DiffFileStatus
  binary: boolean
  hunks: ParsedDiffHunk[]
  additions: number
  deletions: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function stripPrefix(p: string): string {
  if (p === '/dev/null') return p
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2)
  return p
}

/** Parse `git diff` unified text into per-file sections. Tolerant of truncation. */
export function parseUnifiedDiff(patch: string): ParsedDiffFile[] {
  if (!patch.trim()) return []
  const lines = patch.split('\n')
  const files: ParsedDiffFile[] = []
  let current: ParsedDiffFile | null = null
  let hunk: ParsedDiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const pushFile = () => {
    if (current) {
      // Resolve a friendly display path.
      const display =
        current.status === 'deleted'
          ? current.oldPath
          : current.newPath || current.oldPath
      current.path = display
      files.push(current)
    }
  }

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      pushFile()
      hunk = null
      const m = line.match(/^diff --git (.+) (.+)$/)
      const oldP = m ? stripPrefix(m[1]) : ''
      const newP = m ? stripPrefix(m[2]) : ''
      current = {
        oldPath: oldP,
        newPath: newP,
        path: newP || oldP,
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      }
      continue
    }
    if (!current) continue

    if (line.startsWith('new file mode')) {
      current.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      current.status = 'renamed'
      current.oldPath = line.slice('rename from '.length)
      continue
    }
    if (line.startsWith('rename to ')) {
      current.status = 'renamed'
      current.newPath = line.slice('rename to '.length)
      continue
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.binary = true
      continue
    }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4))
      if (p !== '/dev/null') current.oldPath = p
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4))
      if (p !== '/dev/null') current.newPath = p
      continue
    }
    const hm = line.match(HUNK_RE)
    if (hm) {
      oldNo = parseInt(hm[1], 10)
      newNo = parseInt(hm[3], 10)
      hunk = { header: line, lines: [] }
      current.hunks.push(hunk)
      continue
    }
    if (!hunk) continue // index/similarity/etc. between header and first hunk

    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — attach to nothing, skip.
      continue
    }
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo })
      current.additions += 1
      newNo += 1
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo, newNo: null })
      current.deletions += 1
      oldNo += 1
    } else {
      // Context line (leading space) or an empty trailing line from split.
      const text = line.startsWith(' ') ? line.slice(1) : line
      hunk.lines.push({ type: 'context', text, oldNo, newNo })
      oldNo += 1
      newNo += 1
    }
  }
  pushFile()
  return files
}
