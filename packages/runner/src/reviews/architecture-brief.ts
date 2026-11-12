// ── Architecture inputs ──────────────────────────────────────────────────────
//
// The architecture lens is told to start from "the packet's contract-checker
// output and the architecture brief". Until these existed it started from
// nothing and queried a catalog for everything. Both are built here without
// a model:
//
//   * the brief reads the repository's declared architecture sources at the
//     *base* commit (ADRs, ARCHITECTURE.md, CODEOWNERS) and records which
//     decisions exist, who owns the touched paths, and which changed files
//     are contracts;
//   * contract checkers are user-configured commands that compare the base
//     and head versions of the changed contract files.
//
// Nothing from the pull request's head is loaded as instructions. A checker
// only reads head files as data, and only the user's own settings can name a
// checker: a repository cannot add one.

import { execFile } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import type { ArchitectureBrief, PrReview } from '@coro-ai/cloud-protocol'
import type { ScmPluginRuntime } from '../plugins/types'
import { matchesGlob } from './glob'
import type { CheckerResult, FileClass } from './packet'
import type { ReviewPolicy } from './policy'

const MAX_SOURCE_READS = 12
const MAX_ADRS = 60
const MAX_DIR_ENTRIES = 80
const CHECKER_TIMEOUT_MS = 30_000
const CHECKER_OUTPUT_CAP = 20_000
const CHECKER_SNAPSHOT_MAX_FILES = 40

const isGlob = (pattern: string) => /[*?]/.test(pattern)

const OWNER_FILES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']
const INDEX_NAMES = new Set(['readme.md', 'index.md'])

export interface BriefFile {
  path: string
  classes: FileClass[]
}

export interface BuildBriefArgs {
  scm: Pick<ScmPluginRuntime, 'readFile' | 'listFiles'>
  review: Pick<PrReview, 'prRef' | 'pr' | 'architectureBrief'>
  policy: Pick<ReviewPolicy, 'architectureSources' | 'briefTtlHours'>
  files: BriefFile[]
  round: number
  now?: number
}

function decode(content: { content: string; encoding: string }): string {
  return content.encoding === 'base64' ? Buffer.from(content.content, 'base64').toString('utf8') : content.content
}

/** `0007-use-queues.md` becomes `Use queues`. */
export function adrTitleFromPath(file: string): string {
  const name = path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/^\d+[-_ ]*/, '')
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path.posix.basename(file)
}

/** `[title](file.md)` rows of an ADR index, resolved against the index's directory. */
export function parseAdrIndex(markdown: string, indexPath: string): { id: string; title: string; ref: string }[] {
  const dir = path.posix.dirname(indexPath)
  const out: { id: string; title: string; ref: string }[] = []
  for (const match of markdown.matchAll(/\[([^\]]+)\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
    const target = match[2]!
    if (/^[a-z]+:\/\//i.test(target)) continue
    const ref = path.posix.normalize(path.posix.join(dir, target))
    if (INDEX_NAMES.has(path.posix.basename(ref).toLowerCase())) continue
    out.push({ id: path.posix.basename(ref).replace(/\.md$/, ''), title: match[1]!.trim(), ref })
  }
  return out
}

interface OwnerRule {
  pattern: string
  owners: string[]
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const [pattern, ...owners] = line.split(/\s+/)
    if (pattern && owners.length > 0) rules.push({ pattern, owners })
  }
  return rules
}

function ownerPatternMatches(pattern: string, filePath: string): boolean {
  const anchored = pattern.startsWith('/')
  let glob = anchored ? pattern.slice(1) : pattern
  if (glob.endsWith('/')) glob += '**'
  // A pattern names a file, or a folder and everything under it. With no slash
  // and no leading one it may sit at any depth.
  const candidates = [glob, `${glob}/**`]
  if (!anchored && !glob.includes('/')) candidates.push(`**/${glob}/**`)
  return candidates.some(candidate => matchesGlob(candidate, filePath))
}

/** CODEOWNERS says the last matching rule wins. */
export function ownersFor(rules: OwnerRule[], filePath: string): string[] {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    if (ownerPatternMatches(rules[i]!.pattern, filePath)) return rules[i]!.owners
  }
  return []
}

/**
 * The brief for this round, or `undefined` when the repository cannot be
 * read at its base commit. Reuses the stored brief while it is fresh and was
 * built from the same base commit, refreshing only which files are contracts.
 */
export async function buildArchitectureBrief(args: BuildBriefArgs): Promise<ArchitectureBrief | undefined> {
  const { scm, review, policy } = args
  const repo = review.prRef.repoKey
  const baseSha = review.pr.baseSha
  const now = args.now ?? Date.now()
  const contractFiles = args.files
    .filter(file => file.classes.some(cls => cls === 'contracts' || cls === 'migrations'))
    .map(file => file.path)

  const stored = review.architectureBrief
  if (stored && stored.sources.some(source => source.baseSha === baseSha)) {
    const ageMs = now - Date.parse(stored.builtAt)
    if (Number.isFinite(ageMs) && ageMs < policy.briefTtlHours * 3_600_000) return { ...stored, contractFiles }
  }
  if (!repo || !baseSha || !scm.readFile) return undefined

  const readAt = new Date(now).toISOString()
  const sources: ArchitectureBrief['sources'] = []
  let reads = 0
  const read = async (file: string): Promise<string | undefined> => {
    if (reads >= MAX_SOURCE_READS) return undefined
    reads += 1
    try {
      return decode(await scm.readFile!({ repo, path: file, ref: baseSha }))
    } catch {
      return undefined
    }
  }

  const adrs: { id: string; title: string; ref: string }[] = []
  let ownerRules: OwnerRule[] = []

  for (const pattern of policy.architectureSources) {
    if (pattern.toUpperCase().endsWith('CODEOWNERS') && !isGlob(pattern)) {
      for (const candidate of new Set([pattern, ...OWNER_FILES])) {
        const text = await read(candidate)
        if (text === undefined) continue
        ownerRules = parseCodeowners(text)
        sources.push({ kind: 'codeowners', ref: candidate, readAt, baseSha })
        break
      }
      continue
    }
    if (!isGlob(pattern)) {
      if ((await read(pattern)) !== undefined) sources.push({ kind: 'doc', ref: pattern, readAt, baseSha })
      continue
    }
    if (!scm.listFiles) continue
    const dir = pattern.replace(/\/?\*\*.*$/, '').replace(/\/?\*.*$/, '')
    const listed = await listTree(scm, repo, dir, baseSha)
    const matched = listed.filter(entry => matchesGlob(pattern, entry) && /\.mdx?$/i.test(entry))
    if (matched.length === 0) continue
    sources.push({ kind: 'directory', ref: dir || '.', readAt, baseSha })
    const index = matched.find(entry => INDEX_NAMES.has(path.posix.basename(entry).toLowerCase()))
    const fromIndex = index ? parseAdrIndex((await read(index)) ?? '', index) : []
    const indexed = new Set(fromIndex.map(item => item.ref))
    adrs.push(...fromIndex)
    for (const entry of matched) {
      if (entry === index || indexed.has(entry)) continue
      if (INDEX_NAMES.has(path.posix.basename(entry).toLowerCase())) continue
      adrs.push({ id: path.posix.basename(entry).replace(/\.mdx?$/i, ''), title: adrTitleFromPath(entry), ref: entry })
    }
  }

  if (sources.length === 0 && adrs.length === 0) return undefined

  const owners = new Set<string>()
  for (const file of args.files) for (const owner of ownersFor(ownerRules, file.path)) owners.add(owner)

  return {
    service: repo.split('/').pop() ?? repo,
    ...(owners.size ? { owners: [...owners].sort() } : {}),
    ...(adrs.length ? { adrs: adrs.slice(0, MAX_ADRS) } : {}),
    contractFiles,
    sources,
    builtInRound: args.round,
    builtAt: readAt,
  }
}

/** Files under `dir`, one level of subfolders deep, so an ADR folder with year subfolders is covered. */
async function listTree(
  scm: Pick<ScmPluginRuntime, 'listFiles'>,
  repo: string,
  dir: string,
  ref: string,
): Promise<string[]> {
  const out: string[] = []
  try {
    const top = await scm.listFiles!({ repo, path: dir, ref })
    let subdirs = 0
    for (const entry of top.slice(0, MAX_DIR_ENTRIES)) {
      if (entry.type === 'file') {
        out.push(entry.path)
      } else if (subdirs < 6) {
        subdirs += 1
        const inner = await scm.listFiles!({ repo, path: entry.path, ref }).catch(() => [])
        for (const child of inner.slice(0, MAX_DIR_ENTRIES)) if (child.type === 'file') out.push(child.path)
      }
    }
  } catch { /* an unreadable folder is a missing source, not a failed round */ }
  return out
}

// ── Contract checkers ────────────────────────────────────────────────────────

export interface CheckerFile {
  path: string
  status?: string
}

export interface RunCheckersArgs {
  scm: Pick<ScmPluginRuntime, 'readFile'>
  repo: string
  baseSha?: string
  headSha?: string
  files: CheckerFile[]
  checkers: ReviewPolicy['contractCheckers']
  /** `<job cwd>/pr`. Snapshots go under `contracts/{base,head}`. */
  root: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function snapshot(
  scm: Pick<ScmPluginRuntime, 'readFile'>,
  repo: string,
  ref: string | undefined,
  dir: string,
  file: string,
): Promise<boolean> {
  if (!ref || !scm.readFile) return false
  const dest = path.resolve(dir, file)
  if (!dest.startsWith(`${path.resolve(dir)}${path.sep}`)) return false
  try {
    const content = await scm.readFile({ repo, path: file, ref })
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest, content.encoding === 'base64' ? Buffer.from(content.content, 'base64') : content.content)
    return true
  } catch {
    return false
  }
}

function execChecker(command: string, cwd: string, env: Record<string, string>): Promise<{
  exitCode: number | null
  timedOut: boolean
  output: string
}> {
  return new Promise(resolve => {
    execFile('/bin/sh', ['-c', command], { cwd, env, timeout: CHECKER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`
      if (!error) return resolve({ exitCode: 0, timedOut: false, output })
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
      resolve({
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        timedOut: failure.killed === true,
        output: output || failure.message,
      })
    })
  })
}

/**
 * Runs each configured checker on the changed files its glob matches. The
 * base and head versions of those files are written under `contracts/` and
 * the command sees them through `{base}`, `{head}`, `{files}` and the
 * matching environment variables. A checker that cannot run produces a
 * result that says so; it never fails the round.
 */
export async function runContractCheckers(args: RunCheckersArgs): Promise<CheckerResult[]> {
  const results: CheckerResult[] = []
  const contractsDir = path.join(args.root, 'contracts')
  const baseDir = path.join(contractsDir, 'base')
  const headDir = path.join(contractsDir, 'head')
  for (const checker of args.checkers) {
    const matched = args.files
      .filter(file => matchesGlob(checker.glob, file.path))
      .slice(0, CHECKER_SNAPSHOT_MAX_FILES)
    if (matched.length === 0) continue
    await mkdir(baseDir, { recursive: true })
    await mkdir(headDir, { recursive: true })
    const present: string[] = []
    for (const file of matched) {
      const [hadBase, hadHead] = await Promise.all([
        file.status === 'added' ? false : snapshot(args.scm, args.repo, args.baseSha, baseDir, file.path),
        file.status === 'removed' ? false : snapshot(args.scm, args.repo, args.headSha, headDir, file.path),
      ])
      if (hadBase || hadHead) present.push(file.path)
    }
    if (present.length === 0) continue
    const command = checker.command
      .split('{base}').join(shellQuote(baseDir))
      .split('{head}').join(shellQuote(headDir))
      .split('{files}').join(present.map(shellQuote).join(' '))
    const ran = await execChecker(command, contractsDir, {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      CORO_CONTRACT_BASE: baseDir,
      CORO_CONTRACT_HEAD: headDir,
      CORO_CONTRACT_FILES: present.join('\n'),
    })
    results.push({
      glob: checker.glob,
      command: checker.command,
      files: present,
      exitCode: ran.exitCode,
      timedOut: ran.timedOut,
      output: ran.output.slice(0, CHECKER_OUTPUT_CAP),
      truncated: ran.output.length > CHECKER_OUTPUT_CAP,
    })
  }
  return results
}
