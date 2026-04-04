import fs from 'fs/promises'
import path from 'path'
import { Logger } from 'pino'
import { GitClient } from '../clients/git'
import { Settings } from '../config/settings'
import { Job } from '../jobs/types'
import { parseWorkflowConfig, stripFrontMatter, getPhaseConfig } from '../workflow-parser'

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Assembles the system prompt for a Claude API call.
 *
 * Section order (each separated by ---):
 *   1. CLAUDE.md          — root instructions, agent behaviour rules
 *   2. Workflow file      — lifecycle definition for this job type
 *   3. Agent instructions — role-specific steps for the current phase
 *   4. Memory             — accumulated knowledge from past jobs
 *   5. Pending proposals  — tool/agent changes awaiting review (so agent knows what's in flight)
 *   6. Conventions        — Go coding + git/PR conventions
 *   7. Job context        — current job state as JSON (always last, most specific)
 *
 * The a5-ai repo is pulled before assembly so agents always run against
 * the latest instructions and memory. Pull failures are non-fatal — the
 * cached version is used instead.
 */
export async function buildSystemPrompt(
  job: Job,
  settings: Settings,
  gitClient: GitClient,
  logger: Logger,
): Promise<string> {
  const a5aiDir = settings.paths.a5aiDir

  // 1. Pull latest a5-ai — non-fatal if it fails (network issue, not a git repo locally)
  try {
    await gitClient.pull(a5aiDir)
    logger.debug({ jobId: job.id, phase: job.phase }, 'Pulled latest a5-ai')
  } catch (err) {
    logger.warn({ err }, 'Could not pull a5-ai — using cached version on disk')
  }

  const sections: string[] = []

  // 2. Root instructions
  const claudeMd = await readSafe(path.join(a5aiDir, 'CLAUDE.md'), logger)
  if (claudeMd) sections.push(claudeMd)

  // 3. Workflow file (dynamic per JobType — not hardcoded)
  const workflowAbsPath = path.join(a5aiDir, job.workflowPath)
  const workflowMd = await readSafe(workflowAbsPath, logger)
  const workflowConfig = workflowMd ? parseWorkflowConfig(workflowMd) : null

  if (workflowMd) {
    const contentWithoutFrontMatter = stripFrontMatter(workflowMd)
    sections.push(banner('Current Workflow', job.workflowPath) + contentWithoutFrontMatter)
  } else {
    logger.warn({ workflowPath: job.workflowPath }, 'Workflow file not found — continuing without it')
  }

  // 4. Phase-specific agent instructions — resolved from workflow config
  const phaseConf = workflowConfig ? getPhaseConfig(workflowConfig, job.phase) : null
  const agentRelPath = phaseConf?.agent ?? null

  if (agentRelPath) {
    const agentMd = await readSafe(path.join(a5aiDir, agentRelPath), logger)
    if (agentMd) {
      sections.push(banner('Your Role This Phase', agentRelPath) + agentMd)
    } else {
      logger.warn({ agentRelPath, phase: job.phase }, 'Agent file not found — skipping')
    }
  }

  // 5. Memory
  const memorySections = await loadMemory(a5aiDir, logger)
  sections.push(...memorySections)

  // 6. Conventions
  const conventionFiles = ['conventions/golang.md', 'conventions/git.md']
  for (const relPath of conventionFiles) {
    const content = await readSafe(path.join(a5aiDir, relPath), logger)
    if (content) sections.push(banner('Conventions', relPath) + content)
  }

  // 7. Job context — always last so it is never overridden by generic instructions
  sections.push(buildJobContext(job))

  return sections.join('\n\n---\n\n')
}

// ── Memory loader ─────────────────────────────────────────────────────────────

async function loadMemory(a5aiDir: string, logger: Logger): Promise<string[]> {
  const memoryDir = path.join(a5aiDir, 'memory')
  const sections: string[] = []

  // Read the MEMORY.md index first
  const indexContent = await readSafe(path.join(memoryDir, 'MEMORY.md'), logger)
  if (!indexContent) return sections

  sections.push(banner('Memory Index', 'memory/MEMORY.md') + indexContent)

  // Load each file linked from the index
  const linkedFiles = extractMarkdownLinkTargets(indexContent)
  for (const filename of linkedFiles) {
    // Skip external URLs and anchors
    if (filename.startsWith('http') || filename.startsWith('#')) continue

    const filePath = path.join(memoryDir, filename)
    const content = await readSafe(filePath, logger)
    if (content) {
      sections.push(banner('Memory', `memory/${filename}`) + content)
    }
  }

  // Load any pending proposals so the agent knows what improvements are in flight
  const proposalsDir = path.join(memoryDir, 'proposals')
  try {
    const proposalFiles = await fs.readdir(proposalsDir)
    const mdFiles = proposalFiles.filter(f => f.endsWith('.md')).sort()

    if (mdFiles.length > 0) {
      const proposalParts = [`## Pending Proposals (${mdFiles.length} awaiting human review)\n`]
      for (const filename of mdFiles) {
        const content = await readSafe(path.join(proposalsDir, filename), logger)
        if (content) proposalParts.push(`### ${filename}\n\n${content}`)
      }
      sections.push(banner('Pending Proposals', 'memory/proposals/') + proposalParts.join('\n\n'))
    }
  } catch {
    // proposals dir doesn't exist yet — normal for new installs
  }

  return sections
}

// ── Job context ───────────────────────────────────────────────────────────────

function buildJobContext(job: Job): string {
  const context = {
    jobId: job.id,
    type: job.type,
    workflowPath: job.workflowPath,
    serviceName: job.serviceName,
    repoSlug: job.repoSlug,
    projects: job.projects,
    reviewers: job.reviewers,
    stagingUrl: job.stagingUrl,
    triggerSource: job.triggerSource,
    jiraTicketId: job.jiraTicketId ?? null,
    status: job.status,
    phase: job.phase,
    currentFeature: job.currentFeature,
    prMappings: job.prMappings,
    awaitingEvent: job.awaitingEvent ?? null,
    awaitingPrId: job.awaitingPrId ?? null,
    escalationMessage: job.escalationMessage ?? null,
  }

  return (
    '# Current Job\n\n' +
    'This is the job you are currently executing. ' +
    'All your actions must stay within the scope of this job.\n\n' +
    '```json\n' +
    JSON.stringify(context, null, 2) +
    '\n```'
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readSafe(filePath: string, logger: Logger): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    logger.debug({ filePath }, 'File not found — skipping')
    return null
  }
}

/** Extract href values from all `[text](href)` links in markdown. */
function extractMarkdownLinkTargets(markdown: string): string[] {
  const targets: string[] = []
  const regex = /\[[^\]]*\]\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(markdown)) !== null) {
    targets.push(match[1])
  }
  return targets
}

/** Format a section header so Claude can easily identify each loaded file. */
function banner(label: string, source: string): string {
  return `# ${label}\n*Source: ${source}*\n\n`
}
