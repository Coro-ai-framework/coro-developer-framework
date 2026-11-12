// ── Finding identity ─────────────────────────────────────────────────────────
//
// `findingFingerprint` hashes category + path + the exact normalised title,
// so a lens that words the same problem differently on the next round looks
// like a new finding, and a finding the author already declined comes back.
// Matching here is looser on purpose: same place, same problem.

const SEVERITY_RANK: Record<string, number> = { nit: 0, minor: 1, major: 2, blocker: 3 }

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'when', 'not', 'are', 'but', 'can', 'may', 'will', 'does', 'did',
  'was', 'were', 'has', 'have', 'its', 'into', 'from', 'than', 'then', 'there', 'which', 'would', 'should',
  'could', 'missing', 'possible', 'potential', 'unused', 'incorrect',
])

export interface MatchableFinding {
  id?: string
  fingerprint?: string
  path?: string
  line?: number
  category: string
  title: string
  severity?: string
}

/** Lowercased content words of a title, with plural endings folded. */
export function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(' ')
    .filter(word => word.length > 2 && !STOP_WORDS.has(word))
    .map(word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
  return new Set(tokens)
}

/** Shared tokens over the smaller title, so a short title inside a long one still matches. */
export function titleOverlap(a: string, b: string): number {
  const left = titleTokens(a)
  const right = titleTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.min(left.size, right.size)
}

export interface MatchOptions {
  /** Cross-lens duplicates are filed under different categories. */
  ignoreCategory?: boolean
  /** Lines apart that still count as the same place. */
  lineWindow?: number
}

/**
 * True when two findings are the same problem: the same id or fingerprint,
 * or the same file, nearby lines, and mostly the same words.
 */
export function sameFinding(a: MatchableFinding, b: MatchableFinding, options: MatchOptions = {}): boolean {
  if (a.id && b.id && a.id === b.id) return true
  if (a.fingerprint && b.fingerprint && a.fingerprint === b.fingerprint) return true
  if (!a.path || !b.path || a.path !== b.path) return false

  const sameCategory = a.category === b.category || a.category === 'other' || b.category === 'other'
  if (!options.ignoreCategory && !sameCategory) return false

  const window = options.lineWindow ?? (options.ignoreCategory ? 3 : 5)
  const bothLines = a.line !== undefined && b.line !== undefined
  if (options.ignoreCategory && !bothLines) return false
  if (bothLines && Math.abs(a.line! - b.line!) > window) return false

  return titleOverlap(a.title, b.title) >= (options.ignoreCategory ? 0.5 : 0.6)
}

export function severityRank(severity: string | undefined): number {
  return SEVERITY_RANK[severity ?? ''] ?? 0
}

export interface DedupResult<T> {
  kept: T[]
  /** What was dropped and the finding it duplicated. */
  duplicates: { dropped: T; of: T }[]
}

/**
 * One finding per problem. The most severe copy wins; among equals the
 * earliest. Order of the survivors follows their first appearance.
 */
export function dedupeFindings<T extends MatchableFinding>(
  findings: T[],
  options: MatchOptions = {},
): DedupResult<T> {
  const kept: T[] = []
  const duplicates: { dropped: T; of: T }[] = []
  for (const finding of findings) {
    const at = kept.findIndex(item => sameFinding(item, finding, options))
    if (at === -1) {
      kept.push(finding)
      continue
    }
    const existing = kept[at]!
    if (severityRank(finding.severity) > severityRank(existing.severity)) {
      kept[at] = finding
      duplicates.push({ dropped: existing, of: finding })
    } else {
      duplicates.push({ dropped: finding, of: existing })
    }
  }
  return { kept, duplicates }
}
