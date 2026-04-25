import fs from 'fs/promises'
import path from 'path'
import { Logger } from 'pino'
import { Settings } from '../config/settings'
import { Job } from '../jobs/types'
import { parseWorkflowConfig, stripFrontMatter, getPhaseConfig } from '../workflow-parser'

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Assembles the system prompt for a Claude API call.
 *
 * The prompt is intentionally lean — just the ambient context the agent needs
 * before it can decide what to do next. Anything the agent might *not* need
 * every turn (memory, proposals, domain skills) is loaded on-demand via MCP
 * tools (`read_memory`, `list_proposals`) and native SDK skills.
 *
 * Sections included (in order):
 *   1. Workflow file      — phase list + high-level workflow prose
 *   2. Agent instructions — role-specific steps for the current phase
 *   3. Job context        — current job state as JSON, plus insights if any
 *
 * Static ambient content (behaviour rules, git conventions, infra context)
 * is loaded natively by the SDK via `settingSources: ['project']` from
 * `.claude/CLAUDE.md`. The intelligence repo is pulled once per job in the runner,
 * not per phase, so this function never does network I/O.
 */
export async function buildSystemPrompt(
  job: Job,
  settings: Settings,
  logger: Logger,
): Promise<string> {
  const coroIntelligenceDir = settings.paths.coroIntelligenceDir

  const sections: string[] = []

  const workflowAbsPath = path.join(coroIntelligenceDir, job.workflowPath)
  const workflowMd = await readSafe(workflowAbsPath, logger)
  const workflowConfig = workflowMd ? parseWorkflowConfig(workflowMd) : null

  if (workflowMd) {
    sections.push(banner('Current Workflow', job.workflowPath) + stripFrontMatter(workflowMd))
  } else {
    logger.warn({ workflowPath: job.workflowPath }, 'Workflow file not found — continuing without it')
  }

  const phaseConf = workflowConfig ? getPhaseConfig(workflowConfig, job.phase) : null
  const agentRelPath = phaseConf?.agent ?? null
  if (agentRelPath) {
    const agentMd = await readSafe(path.join(coroIntelligenceDir, agentRelPath), logger)
    if (agentMd) {
      sections.push(banner('Your Role This Phase', agentRelPath) + agentMd)
    } else {
      logger.warn({ agentRelPath, phase: job.phase }, 'Agent file not found — skipping')
    }
  }

  sections.push(buildJobContext(job))

  return sections.join('\n\n---\n\n')
}

// ── Job context ───────────────────────────────────────────────────────────────

function buildJobContext(job: Job): string {
  const context = {
    jobId: job.id,
    type: job.type,
    workflowPath: job.workflowPath,
    interactive: job.interactive,
    params: job.params,
    triggerSource: job.triggerSource,
    status: job.status,
    phase: job.phase,
    currentWorkItem: job.currentWorkItem,
    workItems: job.workItems,
    workItemLoopCount: job.workItemLoopCount,
    prMappings: job.prMappings,
    awaitingEvent: job.awaitingEvent ?? null,
    awaitingPrId: job.awaitingPrId ?? null,
    awaitingNextPhase: job.awaitingNextPhase ?? null,
    approvedAdvanceFromPhase: job.approvedAdvanceFromPhase ?? null,
    escalationMessage: job.escalationMessage ?? null,
  }

  const parts = [
    '# Current Job\n\n' +
    'This is the job you are currently executing. ' +
    'All your actions must stay within the scope of this job.\n\n' +
    '```json\n' +
    JSON.stringify(context, null, 2) +
    '\n```',
  ]

  if (job.insights && job.insights.length > 0) {
    const insightLines = job.insights.map((ins, i) =>
      `### ${i + 1}. [${ins.phase}] ${ins.category}\n` +
      `**Summary:** ${ins.summary}\n` +
      `**Detail:** ${ins.detail}` +
      (ins.suggestion ? `\n**Suggestion:** ${ins.suggestion}` : ''),
    )
    parts.push(
      '\n\n## Insights from Upstream Agents\n\n' +
      'The following learnings were recorded by agents during earlier phases. ' +
      'Review these carefully — each represents a discovery, workaround, or pattern ' +
      'that may warrant a self-improvement proposal via `propose_change`.\n\n' +
      insightLines.join('\n\n'),
    )
  }

  return parts.join('')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readSafe(filePath: string, logger: Logger): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      logger.debug({ filePath }, 'File not found — skipping')
    } else {
      logger.warn({ filePath, code }, 'Could not read file — skipping')
    }
    return null
  }
}

function banner(label: string, source: string): string {
  return `# ${label}\n*Source: ${source}*\n\n`
}
