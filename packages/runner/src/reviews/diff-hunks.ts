// ── Unified-diff hunk index ──────────────────────────────────────────────────
//
// A finding is only useful inline when its line is in the diff: an SCM
// refuses (or silently detaches) a comment on a line the pull request did
// not touch. The runner checks that itself rather than trusting a lens to
// have counted lines correctly.
//
// Parses the `pr/diff.patch` layout that `materialisePr` writes (one
// `diff --git a/x b/x` section per file) and a bare per-file patch alike.

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export interface FileHunks {
  hunks: Hunk[]
  /** New-file line numbers of added lines. */
  added: Set<number>
  /** Old-file line numbers of removed lines. */
  removed: Set<number>
}

export type HunkIndex = Map<string, FileHunks>

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/

function emptyFile(): FileHunks {
  return { hunks: [], added: new Set(), removed: new Set() }
}

/**
 * Index every hunk by new-file path. Hunk bodies are consumed by the line
 * counts in their header, so a `+++`-looking content line cannot be mistaken
 * for a file header.
 */
export function parseUnifiedDiff(text: string, defaultPath?: string): HunkIndex {
  const index: HunkIndex = new Map()
  let current: FileHunks | undefined = defaultPath ? ensure(index, defaultPath) : undefined
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0

  for (const line of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      if (line.startsWith('+')) {
        current?.added.add(newLine)
        newLine += 1
        newLeft -= 1
      } else if (line.startsWith('-')) {
        current?.removed.add(oldLine)
        oldLine += 1
        oldLeft -= 1
      } else {
        oldLine += 1
        newLine += 1
        oldLeft -= 1
        newLeft -= 1
      }
      continue
    }
    const file = FILE_HEADER.exec(line)
    if (file) {
      current = ensure(index, file[2]!)
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header && current) {
      const hunk: Hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
      }
      current.hunks.push(hunk)
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      oldLeft = hunk.oldLines
      newLeft = hunk.newLines
    }
  }
  return index
}

function ensure(index: HunkIndex, path: string): FileHunks {
  const existing = index.get(path)
  if (existing) return existing
  const created = emptyFile()
  index.set(path, created)
  return created
}

/**
 * Whether an inline comment on `line` can attach. `RIGHT` is the new file,
 * `LEFT` the old one; both accept any line a hunk shows, context included.
 */
export function lineInDiff(
  index: HunkIndex,
  path: string | undefined,
  line: number | undefined,
  side: 'LEFT' | 'RIGHT' = 'RIGHT',
): boolean {
  if (!path || line === undefined) return false
  const file = index.get(path)
  if (!file) return false
  return file.hunks.some(hunk => side === 'RIGHT'
    ? line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1)
    : line >= hunk.oldStart && line < hunk.oldStart + Math.max(hunk.oldLines, 1))
}

/**
 * `lineInDiff` that admits what it cannot know. An SCM that returns no patch
 * (binary, too large, or a provider that only reports file stats) leaves a
 * file with no hunks, and the runner must not second-guess a comment it
 * cannot check. Returns `undefined` then; `true` / `false` otherwise.
 */
export function anchorInDiff(
  index: HunkIndex,
  path: string | undefined,
  line: number | undefined,
  side: 'LEFT' | 'RIGHT' = 'RIGHT',
): boolean | undefined {
  if (!path || line === undefined) return undefined
  const file = index.get(path)
  if (!file || file.hunks.length === 0) return undefined
  return lineInDiff(index, path, line, side)
}

/** Whether `line` is an added line, or within `radius` lines of one. */
export function nearChangedLine(
  index: HunkIndex,
  path: string | undefined,
  line: number | undefined,
  radius = 3,
): boolean {
  if (!path || line === undefined) return false
  const file = index.get(path)
  if (!file) return false
  for (const added of file.added) if (Math.abs(added - line) <= radius) return true
  // A pure deletion leaves no added line; the surviving neighbours are the change.
  if (file.added.size === 0) return lineInDiff(index, path, line)
  return false
}
