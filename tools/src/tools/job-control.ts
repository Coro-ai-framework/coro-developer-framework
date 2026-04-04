import fs from 'fs/promises'
import path from 'path'
import { STATUS_ESCALATED } from '../jobs/types'
import { ToolContext } from './types'

export async function markPhaseComplete(
  _input: Record<string, never>,
  ctx: ToolContext,
): Promise<unknown> {
  ctx.job._signals = { ...ctx.job._signals, phaseComplete: true }
  return { phaseComplete: true }
}

export async function awaitEvent(
  input: { eventName: string; prId?: number },
  ctx: ToolContext,
): Promise<unknown> {
  ctx.job._signals = {
    ...ctx.job._signals,
    awaitingEvent: input.eventName,
    awaitingPrId: input.prId,
  }
  return { awaiting: input.eventName, prId: input.prId ?? null }
}

export async function escalate(
  input: { reason: string },
  ctx: ToolContext,
): Promise<unknown> {
  await ctx.registry.updateJob(ctx.job.id, {
    status: STATUS_ESCALATED,
    escalationMessage: input.reason,
  })
  ctx.logger.warn({ jobId: ctx.job.id, reason: input.reason }, 'Job escalated')
  return { escalated: true, reason: input.reason }
}

export async function log(
  input: { message: string },
  ctx: ToolContext,
): Promise<unknown> {
  await ctx.registry.appendLog(ctx.job.id, input.message)
  return null
}

/**
 * Propose a change to the Agent Host's source code, agent instructions, or tools.
 * Writes a proposal summary to memory/proposals/ and optionally writes the actual
 * file content. The file watcher picks up changes, validates them, and opens a PR.
 */
export async function proposeChange(
  input: {
    type: 'new-tool' | 'modify-tool' | 'new-agent' | 'modify-agent' | 'workflow-change' | 'source-change'
    title: string
    rationale: string
    description: string
    targetFile?: string
    proposedContent?: string
  },
  ctx: ToolContext,
): Promise<unknown> {
  const a5aiDir = ctx.settings.paths.a5aiDir
  const slug = toSlug(input.title)
  const timestamp = new Date().toISOString().slice(0, 10)

  const proposalDir = path.join(a5aiDir, 'memory', 'proposals')
  await fs.mkdir(proposalDir, { recursive: true })

  const proposalPath = path.join(proposalDir, `${timestamp}-${slug}.md`)
  const proposalContent = buildProposalMarkdown(input, ctx)
  await fs.writeFile(proposalPath, proposalContent, 'utf-8')

  const written: string[] = [proposalPath]

  if (input.targetFile && input.proposedContent !== undefined) {
    const targetPath = path.join(a5aiDir, input.targetFile)

    if (!targetPath.startsWith(a5aiDir + path.sep)) {
      throw new Error(`targetFile "${input.targetFile}" escapes a5aiDir`)
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, input.proposedContent, 'utf-8')
    written.push(targetPath)
  }

  await ctx.registry.appendLog(
    ctx.job.id,
    `[propose_change] Filed "${input.type}" proposal: ${input.title} → ${path.basename(proposalPath)}`,
  )

  ctx.logger.info(
    { jobId: ctx.job.id, type: input.type, slug, written },
    'Change proposal written — file watcher will open a PR',
  )

  return {
    proposalFile: path.relative(a5aiDir, proposalPath),
    targetFile: input.targetFile ?? null,
    nextStep: 'File watcher will detect these changes and open a PR for human review.',
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function buildProposalMarkdown(
  input: Parameters<typeof proposeChange>[0],
  ctx: ToolContext,
): string {
  const lines = [
    `# Proposal: ${input.title}`,
    '',
    `**Type:** ${input.type}`,
    `**Proposed by job:** ${ctx.job.id} (${ctx.job.type}, phase: ${ctx.job.phase})`,
    `**Date:** ${new Date().toISOString()}`,
    '',
    '## Rationale',
    '',
    input.rationale,
    '',
    '## Description',
    '',
    input.description,
  ]

  if (input.targetFile) {
    lines.push('', `## Target file`, '', `\`${input.targetFile}\``)
    if (input.proposedContent) {
      const ext = input.targetFile.split('.').pop() ?? ''
      lines.push('', '## Proposed content', '', `\`\`\`${ext}`, input.proposedContent, '```')
    }
  }

  lines.push(
    '',
    '---',
    '_This proposal was generated automatically. Review and merge to apply._',
  )

  return lines.join('\n')
}
