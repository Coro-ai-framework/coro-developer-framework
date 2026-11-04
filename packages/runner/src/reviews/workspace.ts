import { mkdir, rm, readFile } from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import type { ReviewPolicy } from './policy'

export interface ReviewWorkspace {
  jobDir: string
  baseDir: string
  headDir: string
  /** Absolute base checkout. The runner reads `.coro/` from here, never from head. */
  repoCheckoutAbsDir: string
  guidance: string
}

/**
 * Materialise a base checkout and a head checkout. Head code is never the
 * process cwd and its `.claude/` is never loaded (`projectContext: skip`).
 * `.git` stays on the mirror only; the two worktrees are ordinary directories
 * produced by `git archive` so nothing can push from them.
 */
export async function prepareReviewWorkspace(args: {
  jobDir: string
  cloneUrl: string
  baseSha: string
  headSha: string
}): Promise<ReviewWorkspace> {
  const mirror = path.join(args.jobDir, 'mirror')
  const baseDir = path.join(args.jobDir, 'base')
  const headDir = path.join(args.jobDir, 'head')
  await mkdir(args.jobDir, { recursive: true })
  await runGit(['clone', '--bare', '--filter=blob:none', args.cloneUrl, mirror])
  await exportTree(mirror, args.baseSha, baseDir)
  await exportTree(mirror, args.headSha, headDir)
  const guidance = await readRepoGuidance(baseDir)
  return { jobDir: args.jobDir, baseDir, headDir, repoCheckoutAbsDir: baseDir, guidance }
}

async function exportTree(mirror: string, sha: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const archive = spawn('git', ['--git-dir', mirror, 'archive', sha])
    const extract = spawn('tar', ['-x', '-C', dest])
    archive.stdout.pipe(extract.stdin)
    const errors: string[] = []
    archive.stderr.on('data', chunk => errors.push(String(chunk)))
    extract.stderr.on('data', chunk => errors.push(String(chunk)))
    extract.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`git archive failed (${code}): ${errors.join('')}`))
    })
    archive.on('error', reject)
    extract.on('error', reject)
  })
}

async function runGit(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))))
  })
}

export async function readRepoGuidance(baseDir: string): Promise<string> {
  try {
    return await readFile(path.join(baseDir, '.coro', 'review.md'), 'utf8')
  } catch {
    return ''
  }
}

/** Front matter of `.coro/review.md`. Only tighten-only keys are honoured by policy. */
export function parseReviewFrontMatter(markdown: string): Partial<ReviewPolicy> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return {}
  const out: Partial<ReviewPolicy> = {}
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':')
    if (!key || rest.length === 0) continue
    const value = rest.join(':').trim()
    if (key.trim() === 'minSeverity') out.minSeverity = value as ReviewPolicy['minSeverity']
    if (key.trim() === 'maxCommentsPerRound') out.maxCommentsPerRound = Number(value)
    if (key.trim() === 'approveBeforePosting' && value === 'true') out.approveBeforePosting = true
    if (key.trim() === 'ignorePaths') out.ignorePaths = value.split(',').map(item => item.trim()).filter(Boolean)
  }
  return out
}
