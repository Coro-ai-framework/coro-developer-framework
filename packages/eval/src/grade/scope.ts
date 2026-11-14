import { gitResult } from '../git'
import { matchesAny } from '../glob'
import { round } from '../util'

/**
 * How big the change is, and whether it stayed inside the files the task
 * allows. Cheap, deterministic signals that catch scope creep a model judge
 * might forgive: a lockfile rewrite, a drive-by reformat, a new config file.
 */

export interface NumstatRow {
  file: string
  added: number
  removed: number
}

export interface ChangeSize {
  filesChanged: number
  linesAdded: number
  linesRemoved: number
}

export interface ScopeGrade extends ChangeSize {
  /** Changed files that match none of the task's `scope` globs. */
  outOfScopeFiles: string[]
  /** The human-written solution, for comparison. */
  reference?: ChangeSize
  /** Changed lines (added + removed) as a multiple of the reference's. 1 means the same size. */
  sizeRatio?: number
}

/** Parse `git diff --numstat` output. Binary files report `-` and count as zero lines. */
export function parseNumstat(text: string): NumstatRow[] {
  const rows: NumstatRow[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!match) continue
    rows.push({
      file: match[3]!,
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
    })
  }
  return rows
}

export function changeSize(rows: readonly NumstatRow[]): ChangeSize {
  return {
    filesChanged: rows.length,
    linesAdded: rows.reduce((total, row) => total + row.added, 0),
    linesRemoved: rows.reduce((total, row) => total + row.removed, 0),
  }
}

export interface ScopeInput {
  numstat: readonly NumstatRow[]
  /** Allowed globs; empty means anything goes. */
  scope: readonly string[]
  referenceNumstat?: readonly NumstatRow[]
}

export function gradeScope(input: ScopeInput): ScopeGrade {
  const size = changeSize(input.numstat)
  const outOfScopeFiles =
    input.scope.length === 0 ? [] : input.numstat.map(row => row.file).filter(file => !matchesAny(input.scope, file))

  const result: ScopeGrade = { ...size, outOfScopeFiles }
  if (input.referenceNumstat) {
    const reference = changeSize(input.referenceNumstat)
    result.reference = reference
    const referenceLines = reference.linesAdded + reference.linesRemoved
    if (referenceLines > 0) result.sizeRatio = round((size.linesAdded + size.linesRemoved) / referenceLines, 2)
  }
  return result
}

/** Size of a patch file without applying it: `git apply --numstat` reads it standalone. */
export async function patchNumstat(patchPath: string, cwd: string): Promise<NumstatRow[]> {
  const result = await gitResult(['apply', '--numstat', patchPath], cwd)
  return result.code === 0 ? parseNumstat(result.stdout) : []
}
