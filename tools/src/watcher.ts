import { exec } from 'child_process'
import chokidar, { FSWatcher } from 'chokidar'
import { Logger } from 'pino'
import { promisify } from 'util'
import path from 'path'
import yaml from 'js-yaml'
import fs from 'fs/promises'
import { simpleGit } from 'simple-git'
import { BitBucketClient } from './clients/bitbucket'
import { GitClient } from './clients/git'
import { Settings } from './config/settings'
import { JobRegistry } from './jobs/registry'
import { parseWorkflowConfig } from './workflow-parser'

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

type ChangeCategory = 'agent' | 'memory' | 'workflow' | 'convention' | 'config' | 'source'

function categorise(filePath: string, a5aiDir: string): ChangeCategory {
  const rel = path.relative(a5aiDir, filePath)
  if (rel.startsWith('agents/'))      return 'agent'
  if (rel.startsWith('memory/'))      return 'memory'
  if (rel.startsWith('workflows/'))   return 'workflow'
  if (rel.startsWith('conventions/')) return 'convention'
  if (rel.startsWith('config/'))      return 'config'
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
    path.join(a5aiDir, 'config'),
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

  // Categorise files for targeted validation
  const tsFiles     = changedFiles.filter(f => f.endsWith('.ts'))
  const mdFiles     = changedFiles.filter(f => f.endsWith('.md'))
  const yamlFiles   = changedFiles.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  const workflowMds = changedFiles.filter(f => {
    const rel = path.relative(a5aiDir, f)
    return rel.startsWith('workflows/') && f.endsWith('.md')
  })

  // ─── Validation gates ──────────────────────────────────────────────────────
  // Each gate validates a class of changed files. If any gate fails, we write
  // a failure report to memory/proposals/ so the agent can learn and retry,
  // then abort (no broken PR).

  if (yamlFiles.length > 0) {
    const result = await validateYamlFiles(yamlFiles, a5aiDir, logger)
    if (!result.ok) {
      await writeValidationFailure(a5aiDir, 'yaml-parse', yamlFiles, result.detail, logger)
      return
    }
  }

  if (workflowMds.length > 0) {
    const result = await validateWorkflowMds(workflowMds, logger)
    if (!result.ok) {
      await writeValidationFailure(a5aiDir, 'workflow-config', workflowMds, result.detail, logger)
      return
    }
  }

  if (tsFiles.length > 0) {
    const toolsDir = path.join(a5aiDir, 'tools')
    logger.info({ tsFiles }, 'TypeScript changes detected — running build validation')

    try {
      await execAsync('npm run build', { cwd: toolsDir, timeout: 60_000 })
      logger.info('Build validation passed')
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string }
      const output = e.stderr ?? e.stdout ?? String(err)
      await writeValidationFailure(a5aiDir, 'typescript-build', tsFiles, output, logger)
      return
    }
  }

  // Build branch name and commit message from the changed files
  const categories = [...new Set(changedFiles.map(f => categorise(f, a5aiDir)))]
  const slug = buildSlug(changedFiles, a5aiDir)
  // Include time (HHmm) so multiple same-day changes don't collide on the branch name
  const now = new Date()
  const datePart = now.toISOString().slice(0, 10)
  const timePart = now.toISOString().slice(11, 16).replace(':', '')
  const branch = `improvement/${datePart}-${timePart}-${slug}`
  const commitMsg = buildCommitMessage(categories, mdFiles, tsFiles, a5aiDir)

  // Determine which branch we're currently on so we can return to it afterwards
  const g = simpleGit({ baseDir: a5aiDir })
  const currentBranch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim()

  // Determine push remote — prefer 'bitbucket' if configured, fall back to 'origin'
  const g2 = simpleGit({ baseDir: a5aiDir })
  const allRemotes = await g2.getRemotes(false)
  const pushRemote = allRemotes.find(r => r.name === 'bitbucket') ? 'bitbucket' : 'origin'

  try {
    // Create branch, commit, push
    await gitClient.checkoutBranch(a5aiDir, branch, true)
    await gitClient.commitAll(a5aiDir, commitMsg)
    await gitClient.pushToRemote(a5aiDir, pushRemote, branch)

    logger.info({ branch }, 'Pushed improvement branch')
  } catch (err) {
    logger.error({ err, branch }, 'Failed to commit/push improvement branch')
    // Return to original branch even if push failed
    try { await gitClient.checkoutBranch(a5aiDir, currentBranch) } catch { /* best effort */ }
    return
  }

  // Always return to the original branch so the repo isn't left on the improvement branch
  try {
    await gitClient.checkoutBranch(a5aiDir, currentBranch)
    logger.debug({ branch: currentBranch }, 'Returned to original branch after push')
  } catch (err) {
    logger.warn({ err, currentBranch }, 'Could not return to original branch after push')
  }

  // Open PR via coder account
  // Derive repo slug from git remote URL (more reliable than directory name)
  const remoteUrl = await getRemoteRepoSlug(a5aiDir, logger)
  const repoSlug = remoteUrl ?? path.basename(a5aiDir)
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
      triggerSource: 'internal',
      params: {
        prId,
        repoSlug,
        branchName: branch,
        serviceName: 'a5-ai',
        changedFiles: changedFiles.map(f => path.relative(a5aiDir, f)),
      },
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

// ── Validation helpers ────────────────────────────────────────────────────────

interface ValidationResult {
  ok: boolean
  detail: string
}

async function validateYamlFiles(
  files: string[],
  a5aiDir: string,
  logger: Logger,
): Promise<ValidationResult> {
  logger.info({ files }, 'YAML changes detected — validating parse')
  const errors: string[] = []

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      yaml.load(content)

      // Extra validation for tool-definitions.yaml: must be an array
      const rel = path.relative(a5aiDir, filePath)
      if (rel === 'config/tool-definitions.yaml') {
        const parsed = yaml.load(content)
        if (!Array.isArray(parsed)) {
          errors.push(`${rel}: must be a YAML array, got ${typeof parsed}`)
          continue
        }
        for (let i = 0; i < (parsed as unknown[]).length; i++) {
          const entry = (parsed as Record<string, unknown>[])[i]
          if (!entry.name || !entry.description || !entry.input_schema) {
            errors.push(`${rel}[${i}]: missing required fields (name, description, input_schema)`)
          }
        }
      }
    } catch (err) {
      errors.push(`${path.relative(a5aiDir, filePath)}: ${String(err)}`)
    }
  }

  if (errors.length > 0) {
    const detail = errors.join('\n')
    logger.error({ errors }, 'YAML validation FAILED')
    return { ok: false, detail }
  }

  logger.info('YAML validation passed')
  return { ok: true, detail: '' }
}

async function validateWorkflowMds(
  files: string[],
  logger: Logger,
): Promise<ValidationResult> {
  logger.info({ files }, 'Workflow MD changes detected — validating front matter config')
  const errors: string[] = []

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const config = parseWorkflowConfig(content)

      if (!config) {
        errors.push(`${filePath}: no YAML front matter found`)
        continue
      }
      if (!config.initialPhase) {
        errors.push(`${filePath}: missing initial_phase in front matter`)
      }
      if (!config.phases || config.phases.length === 0) {
        errors.push(`${filePath}: no phases defined in front matter`)
      }
      for (const phase of config.phases) {
        if (!phase.name) {
          errors.push(`${filePath}: phase missing 'name' field`)
        }
      }
    } catch (err) {
      errors.push(`${filePath}: ${String(err)}`)
    }
  }

  if (errors.length > 0) {
    const detail = errors.join('\n')
    logger.error({ errors }, 'Workflow config validation FAILED')
    return { ok: false, detail }
  }

  logger.info('Workflow config validation passed')
  return { ok: true, detail: '' }
}

async function writeValidationFailure(
  a5aiDir: string,
  validationType: string,
  files: string[],
  output: string,
  logger: Logger,
): Promise<void> {
  logger.error({ validationType, files }, `${validationType} validation FAILED — aborting PR creation`)

  try {
    const failurePath = path.join(
      a5aiDir, 'memory', 'proposals',
      `${validationType}-failure-${Date.now()}.md`,
    )
    const content = [
      `# Validation Failure — ${validationType}`,
      '',
      `**Date:** ${new Date().toISOString()}`,
      `**Validation:** ${validationType}`,
      `**Files:** ${files.map(f => path.relative(a5aiDir, f)).join(', ')}`,
      '',
      '## Error output',
      '',
      '```',
      String(output).slice(0, 3000),
      '```',
      '',
      '_Fix the errors in the files above and save again to retry._',
    ].join('\n')

    await fs.mkdir(path.dirname(failurePath), { recursive: true })
    await fs.writeFile(failurePath, content, 'utf-8')
    logger.info({ failurePath }, `${validationType} failure written to proposals`)
  } catch {
    // Best-effort
  }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Extract the repo slug from the git remote URL.
 * Handles both SSH (git@bitbucket.org:workspace/repo.git) and
 * HTTPS (https://bitbucket.org/workspace/repo.git) formats.
 */
async function getRemoteRepoSlug(repoDir: string, logger: Logger): Promise<string | null> {
  try {
    const g = simpleGit({ baseDir: repoDir })
    const remotes = await g.getRemotes(true)
    const origin = remotes.find(r => r.name === 'origin')
    if (!origin) return null

    const url = origin.refs.fetch
    // HTTPS: https://...@bitbucket.org/workspace/repo.git
    // SSH:   git@bitbucket.org:workspace/repo.git
    const match = url.match(/[/:]([^/:]+\/[^/.]+)(?:\.git)?$/)
    if (!match) return null

    const [, workspaceAndRepo] = match
    return workspaceAndRepo.split('/')[1] ?? null
  } catch (err) {
    logger.debug({ err }, 'Could not determine repo slug from remote URL')
    return null
  }
}

// ── PR helpers ────────────────────────────────────────────────────────────────

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
    config:     '### Configuration (YAML)',
    source:     '### Source code (TypeScript)',
  }

  for (const [cat, files] of Object.entries(byCategory) as [ChangeCategory, string[]][]) {
    lines.push(catLabels[cat] ?? `### ${cat}`)
    for (const f of files) lines.push(`- \`${f}\``)
    lines.push('')
  }

  const validationNotes: string[] = []
  if (categories.includes('source'))   validationNotes.push('TypeScript build (`npm run build`)')
  if (categories.includes('config'))   validationNotes.push('YAML parse validation')
  if (categories.includes('workflow')) validationNotes.push('Workflow config front-matter validation')

  if (validationNotes.length > 0) {
    lines.push(
      `> **Validation passed:** ${validationNotes.join(', ')}`,
      '',
    )
  }

  lines.push('---', '_Generated by A5 Agent Host file watcher_')
  return lines.join('\n')
}
