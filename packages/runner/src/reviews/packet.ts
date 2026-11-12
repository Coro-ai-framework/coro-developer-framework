// ── Review packet ────────────────────────────────────────────────────────────
//
// Built by the runner before a round is dispatched, so the agents do not
// spend tool turns classifying the diff. Lenses read only their slice.

export type FileClass =
  | 'code'
  | 'tests'
  | 'contracts'
  | 'migrations'
  | 'infra'
  | 'deps'
  | 'config'
  | 'docs'
  | 'generated'
  | 'vendored'
  | 'lockfile'
  | 'auth'
  | 'new-module'
  | 'cross-module'

export interface PacketFile {
  path: string
  classes: FileClass[]
  additions: number
  deletions: number
  /** Unified hunk text. Omitted when the packet is summary-only. */
  hunks?: string
}

export interface LensRoute {
  name: string
  when: string[]
  paths: string[]
}

/** What one configured contract checker said about the changed contract files. */
export interface CheckerResult {
  glob: string
  command: string
  files: string[]
  exitCode: number | null
  timedOut: boolean
  /** Combined stdout and stderr, capped. */
  output: string
  truncated: boolean
}

export interface ReviewPacket {
  files: PacketFile[]
  totalLines: number
  summaryOnly: boolean
  routes: LensRoute[]
  chunks: { index: number; paths: string[] }[]
  /**
   * Filled in when the round's workspace is materialised, because the
   * checkers need the base and head files on disk. Absent when none is
   * configured or none matched.
   */
  checkerResults?: CheckerResult[]
}

const CLASS_RULES: { cls: FileClass; test: (path: string) => boolean }[] = [
  { cls: 'lockfile', test: p => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/.test(p) },
  { cls: 'generated', test: p => /(\.generated\.|\/generated\/|\/dist\/|\/__generated__\/)/.test(p) },
  { cls: 'vendored', test: p => /(^|\/)(vendor|third_party|node_modules)\//.test(p) },
  { cls: 'migrations', test: p => /(\/migrations?\/|\.sql$)/.test(p) },
  { cls: 'contracts', test: p => /\.(proto|graphql|avsc|avdl)$/.test(p) || /openapi|asyncapi|swagger/i.test(p) },
  { cls: 'infra', test: p => /(\.github\/workflows\/|Dockerfile|docker-compose|helm\/|k8s\/|terraform|\.tf$)/.test(p) },
  { cls: 'deps', test: p => /(^|\/)(package\.json|go\.mod|Cargo\.toml|pyproject\.toml|requirements.*\.txt|pom\.xml|build\.gradle)$/.test(p) },
  { cls: 'config', test: p => /\.(ya?ml|toml|ini|env|json)$/.test(p) && !/package\.json$/.test(p) },
  { cls: 'docs', test: p => /\.(md|mdx|rst|adoc)$/.test(p) || /(^|\/)docs\//.test(p) },
  { cls: 'tests', test: p => /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) },
  { cls: 'auth', test: p => /(auth|session|oauth|permission|rbac)/i.test(p) },
]

export function classifyPath(filePath: string): FileClass[] {
  const classes = CLASS_RULES.filter(rule => rule.test(filePath)).map(rule => rule.cls)
  if (!classes.some(cls => cls === 'docs' || cls === 'tests' || cls === 'lockfile' || cls === 'generated' || cls === 'vendored' || cls === 'contracts' || cls === 'migrations' || cls === 'infra' || cls === 'deps' || cls === 'config')) {
    classes.push('code')
  }
  return classes
}

export function routeLenses(
  files: PacketFile[],
  lenses: { name: string; when?: string[] }[],
): LensRoute[] {
  return lenses
    .filter(lens => lens.when?.includes('always') || lens.name === 'verifier' || !lens.when?.length
      ? false
      : true)
    .map(lens => {
      const when = lens.when ?? []
      const paths = files
        .filter(file => file.classes.some(cls => when.includes(cls)))
        .map(file => file.path)
      return { name: lens.name, when, paths }
    })
    .filter(route => route.paths.length > 0)
}

/** Verifier is not routed by file class; the lead runs it on candidates. */
export function suggestedLensNames(routes: LensRoute[], includeVerifier: boolean): string[] {
  const names = routes.map(route => route.name)
  if (includeVerifier) names.push('verifier')
  return names
}

export function buildPacket(args: {
  files: { path: string; additions?: number; deletions?: number; hunks?: string; classes?: FileClass[] }[]
  lenses: { name: string; when?: string[] }[]
  maxDiffLines: number
  maxLensInputTokens: number
  contextTokens: number
}): ReviewPacket {
  const files: PacketFile[] = args.files.map(file => ({
    path: file.path,
    classes: file.classes ?? classifyPath(file.path),
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    ...(file.hunks ? { hunks: file.hunks } : {}),
  }))
  const totalLines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  const summaryOnly = totalLines > args.maxDiffLines
  const routes = summaryOnly ? [] : routeLenses(files, args.lenses.filter(lens => lens.name !== 'verifier'))
  const budgetTokens = Math.min(args.contextTokens * 0.4, args.maxLensInputTokens)
  const chunks = chunkByTokens(files, budgetTokens)
  return { files, totalLines, summaryOnly, routes, chunks }
}

function chunkByTokens(files: PacketFile[], budgetTokens: number): { index: number; paths: string[] }[] {
  const budgetChars = Math.max(2000, budgetTokens * 4)
  const chunks: { index: number; paths: string[] }[] = []
  let current: string[] = []
  let size = 0
  for (const file of files) {
    const weight = (file.hunks?.length ?? 0) + file.path.length
    if (current.length > 0 && size + weight > budgetChars) {
      chunks.push({ index: chunks.length, paths: current })
      current = []
      size = 0
    }
    current.push(file.path)
    size += weight
  }
  if (current.length > 0) chunks.push({ index: chunks.length, paths: current })
  return chunks
}

/** True when every changed file is ignored, generated, vendored, or a lockfile. */
export function isOutOfScopeDelta(files: PacketFile[], ignorePaths: string[]): boolean {
  if (files.length === 0) return true
  return files.every(file => {
    if (ignorePaths.some(pattern => matchIgnore(pattern, file.path))) return true
    return file.classes.every(cls => cls === 'generated' || cls === 'vendored' || cls === 'lockfile' || cls === 'docs')
      && file.classes.some(cls => cls === 'generated' || cls === 'vendored' || cls === 'lockfile')
  })
}

function matchIgnore(pattern: string, filePath: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return filePath === prefix || filePath.startsWith(`${prefix}/`)
  }
  if (pattern.startsWith('*.')) return filePath.endsWith(pattern.slice(1))
  return filePath === pattern || filePath.endsWith(`/${pattern}`)
}

/**
 * Compare per-file patch ids. A push that only rebases onto a new base
 * keeps the same patch ids and does not need a model.
 */
export function patchUnchanged(
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
): boolean {
  if (!previous) return false
  const prevKeys = Object.keys(previous).sort()
  const nextKeys = Object.keys(next).sort()
  if (prevKeys.length !== nextKeys.length) return false
  return prevKeys.every((key, i) => key === nextKeys[i] && previous[key] === next[key])
}
