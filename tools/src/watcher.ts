import { exec } from 'child_process'
import chokidar, { FSWatcher } from 'chokidar'
import { Logger } from 'pino'
import { promisify } from 'util'
import path from 'path'
import { BitBucketClient } from './clients/bitbucket'
import { GitClient } from './clients/git'
import { Settings } from './config/settings'
import { JobRegistry } from './jobs/registry'

const execAsync = promisify(exec)

// ── Watcher context ───────────────────────────────────────────────────────────

export interface WatcherContext {
  settings: Settings
  gitClient: GitClient
  bbCoder: BitBucketClient
  registry: JobRegistry
  logger: Logger
}

// ── File categories ───────────────────────────────────────────────────────────

type ChangeCategory = 'agent' | 'memory' | 'workflow' | 'convention' | 'source'

function categorise(filePath: string, a5aiDir: string): ChangeCategory {
  const rel = path.relative(a5aiDir, filePath)
  if (rel.startsWith('agents/'))      return 'agent'
  if (rel.startsWith('memory/'))      return 'memory'
  if (rel.startsWith('workflows/'))   return 'workflow'
  if (rel.startsWith('conventions/')) return 'convention'
  return 'source'
}

// ── Watcher ───────────────────────────────────────────────────────────────────

/**
 * Watches the a5-ai repo for changes to:
 *   - memory/**\/*.md        — accumulated agent knowledge
 *   - agents/**\/*.md        — agent role definitions
 *   - workflows/**\/*.md     — workflow lifecycle files
 *   - conventions/**\/*.md   — coding / git conventions
 *   - tools/src/**\/*.ts     — Agent Host source code (tool proposals, etc.)
 *
 * On change:
 *   1. Debounce 2 seconds to batch rapid saves
 *   2. If .ts files changed: run `npm run build` in tools/ to validate TypeScript
 *      — if the build fails, log the error and abort (no PR for broken code)
 *   3. Create a branch, commit all changes, push
 *   4. Open a PR via the coder account tagged to the reviewer account
 *   5. Register a SelfUpdate job in Redis to track the PR
 *
 * The PR is the safety gate. No agent change takes effect until a human merges it.
 * The Agent Host pulls the latest a5-ai at the start of each Claude turn, so
 * merged improvements are picked up immediately on the next job.
 */
export function startWatcher(ctx: WatcherContext): FSWatcher {
  const { settings, logger } = ctx
  const a5aiDir = settings.paths.a5aiDir

  const watched = [
    path.join(a5aiDir, 'memory'),
    path.join(a5aiDir, 'agents'),
    path.join(a5aiDir, 'workflows'),
    path.join(a5aiDir, 'conventions'),
    path.join(a5aiDir, 'tools', 'src'),
  ]

  const ignored = [
    path.join(a5aiDir, '.git'),
    path.join(a5aiDir, 'tools', 'dist'),
    path.join(a5aiDir, 'tools', 'node_modules'),
    /node_modules/,
    /\.git/,
  ]

  const watcher = chokidar.watch(watched, {
    ignored,
    persistent: true,
    ignoreInitial: true,   // don't fire for existing files on startup
    awaitWriteFinish: {    // wait for file writes to complete before firing
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  })

  // Accumulate changes and debounce
  const pending = new Set<string>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleProcess = (filePath: string): void => {
    pending.add(filePath)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const changed = [...pending]
      pending.clear()
      debounceTimer = null
      void processChanges(changed, ctx)
    }, 2000)
  }

  watcher.on('add',    scheduleProcess)
  watcher.on('change', scheduleProcess)
  watcher.on('unlink', scheduleProcess)

  watcher.on('error', (err) => logger.error({ err }, 'File watcher error'))

  logger.info({ watched }, 'File watcher started')
  return watcher
}

// ── Change processor ──────────────────────────────────────────────────────────

async function processChanges(changedFiles: string[], ctx: WatcherContext): Promise<void> {
  const { settings, gitClient, bbCoder, registry, logger } = ctx
  const a5aiDir = settings.paths.a5aiDir

  logger.info({ count: changedFiles.length, files: changedFiles }, 'Processing file watcher changes')

  // Check git status — only proceed if there are actual uncommitted changes
  const status = await gitClient.getStatus(a5aiDir)
  if (status === 'nothing to commit, working tree clean') {
    logger.debug('No uncommitted changes in a5-ai — skipping')
    return
  }

  // Separate TypeScript source files from MD files
  const tsFiles = changedFiles.filter(f => f.endsWith('.ts'))
  const mdFiles = changedFiles.filter(f => f.endsWith('.md'))

  // Validate TypeScript build before opening a PR for broken code
  if (tsFiles.length > 0) {
    const toolsDir = path.join(a5aiDir, 'tools')
    logger.info({ tsFiles }, 'TypeScript changes detected — running build validation')

    try {
      await execAsync('npm run build', { cwd: toolsDir, timeout: 60_000 })
      logger.info('Build validation passed')
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string }
      const output = e.stderr ?? e.stdout ?? String(err)
      logger.error({ output }, 'Build validation FAILED — aborting PR creation')

      // Write the build failure to a proposals file so an agent can read it
      // and propose a fix in the next turn
      try {
        const failurePath = path.join(
          a5aiDir, 'memory', 'proposals',
          `build-failure-${Date.now()}.md`,
        )
        const content = [
          '# Build Failure — TypeScript Proposal Rejected',
          '',
          `**Date:** ${new Date().toISOString()}`,
          `**Files:** ${tsFiles.map(f => path.relative(a5aiDir, f)).join(', ')}`,
          '',
          '## Compiler output',
          '',
          '```',
          output.slice(0, 3000),
          '```',
          '',
          '_Fix the TypeScript errors and save the file again to retry._',
        ].join('\n')

        const fs = await import('fs/promises')
        await fs.mkdir(path.dirname(failurePath), { recursive: true })
        await fs.writeFile(failurePath, content, 'utf-8')
        logger.info({ failurePath }, 'Build failure written to proposals — agent can read and fix')
      } catch {
        // Best-effort
      }
      return
    }
  }

  // Build branch name and commit message from the changed files
  const categories = [...new Set(changedFiles.map(f => categorise(f, a5aiDir)))]
  const slug = buildSlug(changedFiles, a5aiDir)
  const branch = `improvement/${new Date().toISOString().slice(0, 10)}-${slug}`
  const commitMsg = buildCommitMessage(categories, mdFiles, tsFiles, a5aiDir)

  try {
    // Create branch, commit, push
    await gitClient.checkoutBranch(a5aiDir, branch, true)
    await gitClient.commitAll(a5aiDir, commitMsg)
    await gitClient.push(a5aiDir, branch)

    logger.info({ branch }, 'Pushed improvement branch')
  } catch (err) {
    logger.error({ err, branch }, 'Failed to commit/push improvement branch')
    return
  }

  // Open PR via coder account
  const repoSlug = path.basename(a5aiDir)  // e.g. "a5-ai"
  const prDescription = buildPrDescription(categories, changedFiles, a5aiDir)

  let prId: number
  try {
    const pr = await bbCoder.createPr({
      repoSlug,
      title: `[agent-self-improvement] ${commitMsg}`,
      description: prDescription,
      sourceBranch: branch,
      targetBranch: 'main',
      reviewerUsernames: [settings.bitbucket.reviewerAccount.username],
    })
    prId = pr.id
    logger.info({ prId, branch }, 'Self-improvement PR opened')
  } catch (err) {
    logger.error({ err, branch }, 'Failed to open self-improvement PR')
    return
  }

  // Register a SelfUpdate job in Redis to track the PR
  try {
    const job = await registry.createJob({
      type: 'self-update',
      prId,
      repoSlug,
      branchName: branch,
      changedFiles: changedFiles.map(f => path.relative(a5aiDir, f)),
    })
    await registry.appendLog(job.id, `Self-improvement PR #${prId} opened: ${branch}`)
    logger.info({ jobId: job.id, prId }, 'SelfUpdate job registered')
  } catch (err) {
    logger.error({ err }, 'Failed to register SelfUpdate job')
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSlug(files: string[], a5aiDir: string): string {
  // Use the most specific changed directory as the slug
  const dirs = files
    .map(f => path.relative(a5aiDir, path.dirname(f)))
    .map(d => d.split(path.sep)[0] ?? 'misc')

  const unique = [...new Set(dirs)]
  return unique
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40)
}

function buildCommitMessage(
  categories: ChangeCategory[],
  mdFiles: string[],
  tsFiles: string[],
  a5aiDir: string,
): string {
  const parts: string[] = []
  if (tsFiles.length > 0) parts.push(`update ${tsFiles.length} source file(s)`)
  if (mdFiles.length > 0) parts.push(`update ${[...new Set(mdFiles.map(f => categorise(f, a5aiDir)))].join(', ')} files`)

  const summary = parts.join(', ') || `update ${categories.join(', ')} files`
  return `agent: ${summary}`
}

function buildPrDescription(
  categories: ChangeCategory[],
  changedFiles: string[],
  a5aiDir: string,
): string {
  const byCategory: Partial<Record<ChangeCategory, string[]>> = {}

  for (const file of changedFiles) {
    const cat = categorise(file, a5aiDir)
    const rel = path.relative(a5aiDir, file)
    ;(byCategory[cat] ??= []).push(rel)
  }

  const lines = [
    '## Agent Self-Improvement PR',
    '',
    'This PR was opened automatically by the A5 Agent Host file watcher.',
    'An agent proposed these changes during a job run.',
    '',
    '> **Review carefully before merging.** Once merged, the Agent Host pulls',
    '> the latest a5-ai at the start of the next Claude turn — changes take',
    '> effect immediately for all subsequent jobs.',
    '',
    '## Changed files',
    '',
  ]

  const catLabels: Record<ChangeCategory, string> = {
    agent:      '### Agent instructions',
    memory:     '### Memory',
    workflow:   '### Workflows',
    convention: '### Conventions',
    source:     '### Source code (TypeScript)',
  }

  for (const [cat, files] of Object.entries(byCategory) as [ChangeCategory, string[]][]) {
    lines.push(catLabels[cat] ?? `### ${cat}`)
    for (const f of files) lines.push(`- \`${f}\``)
    lines.push('')
  }

  if (categories.includes('source')) {
    lines.push(
      '> **Note:** TypeScript files were validated with `npm run build` before this PR was opened.',
      '',
    )
  }

  lines.push('---', '_Generated by A5 Agent Host file watcher_')
  return lines.join('\n')
}
