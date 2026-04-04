import fs from 'fs/promises'
import path from 'path'
import { STATUS_ESCALATED } from '../jobs/types'
import { ToolContext, ToolResult } from './types'

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Signal to the runner that the current phase is complete.
 * The runner reads this flag after the Claude turn ends and advances the job
 * to the next phase in the workflow.
 */
export async function markPhaseComplete(
  _input: Record<string, never>,
  ctx: ToolContext,
): Promise<ToolResult> {
  ctx.job._signals = { ...ctx.job._signals, phaseComplete: true }
  return { success: true, output: { phaseComplete: true } }
}

/**
 * Park the job until an external event arrives (e.g. a BitBucket webhook).
 * The runner writes awaitingEvent + awaitingPrId to Redis and stops the loop.
 * When the webhook fires, the dispatcher resumes the job with the event payload.
 */
export async function awaitEvent(
  input: { eventName: string; prId?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  ctx.job._signals = {
    ...ctx.job._signals,
    awaitingEvent: input.eventName,
    awaitingPrId: input.prId,
  }
  return {
    success: true,
    output: { awaiting: input.eventName, prId: input.prId ?? null },
  }
}

/**
 * Escalate the job to a human. Sets status to Escalated and records the reason.
 * The job stops running and appears in the `a5 jobs` list with status=escalated.
 * A human can inspect the reason and resume the job once the blocker is resolved.
 */
export async function escalate(
  input: { reason: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  await ctx.registry.updateJob(ctx.job.id, {
    status: STATUS_ESCALATED,
    escalationMessage: input.reason,
  })
  ctx.logger.warn({ jobId: ctx.job.id, reason: input.reason }, 'Job escalated')
  return { success: true, output: { escalated: true, reason: input.reason } }
}

/**
 * Append a log line to the job's Redis log stream.
 * This is the primary way agents communicate progress — developers watch it
 * via `a5 logs --job <id>`. Be specific and frequent.
 */
export async function log(
  input: { message: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  await ctx.registry.appendLog(ctx.job.id, input.message)
  return { success: true, output: null }
}

/**
 * Propose a change to the Agent Host's own source code, agent instructions,
 * or tool implementations. Writes the proposal (and optionally the full
 * file content) into the a5-ai repo so the file watcher picks it up,
 * validates it, and opens a PR for human review.
 *
 * ── How the feedback loop works ────────────────────────────────────────────
 *
 *  1. Agent encounters a limitation (missing tool, wrong behaviour, bad prompt)
 *  2. Agent calls propose_change with a description and optionally the full
 *     proposed file content
 *  3. This tool writes:
 *       - memory/proposals/<slug>.md     ← human-readable proposal summary
 *       - <targetFile> (if provided)     ← the actual change (TS, MD, etc.)
 *  4. File watcher detects changes in a5-ai/
 *  5. If targetFile is under tools/src/, watcher runs `npm run build` first —
 *     invalid TypeScript never reaches a PR
 *  6. Watcher opens a PR on a5-ai tagged with human reviewers
 *  7. Human reviews, merges
 *  8. Agent Host pulls latest, rebuilds if needed, restarts
 *  9. Next job runs with the improved code / instructions
 *
 * ── What agents should propose ─────────────────────────────────────────────
 *
 *  - New tools needed for recurring tasks (e.g. run_go_test, parse_dotnet_sln)
 *  - Fixes to tool implementations that are causing failures
 *  - Updates to agent MD files (better instructions, clearer steps)
 *  - New memory entries for patterns discovered during this job
 *  - Workflow changes (new phases, reordered steps)
 *
 * ── Agents can write real TypeScript ───────────────────────────────────────
 *
 *  If proposedContent + targetFile are provided and targetFile ends in .ts,
 *  the agent is authoring actual source code. The build validation gate means
 *  a non-compiling proposal never becomes a PR — the agent gets the error
 *  back and can fix it before trying again.
 */
export async function proposeChange(
  input: {
    type: 'new-tool' | 'modify-tool' | 'new-agent' | 'modify-agent' | 'workflow-change' | 'source-change'
    title: string
    rationale: string
    description: string
    /** Relative path in the a5-ai repo, e.g. "tools/src/tools/test-harness.ts" */
    targetFile?: string
    /** Full file content to write. Required when targetFile is provided. */
    proposedContent?: string
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const a5aiDir = ctx.settings.paths.a5aiDir
  const slug = toSlug(input.title)
  const timestamp = new Date().toISOString().slice(0, 10)

  try {
    // 1. Write the human-readable proposal summary
    const proposalDir = path.join(a5aiDir, 'memory', 'proposals')
    await fs.mkdir(proposalDir, { recursive: true })

    const proposalPath = path.join(proposalDir, `${timestamp}-${slug}.md`)
    const proposalContent = buildProposalMarkdown(input, ctx)
    await fs.writeFile(proposalPath, proposalContent, 'utf-8')

    const written: string[] = [proposalPath]

    // 2. Write the actual file content if provided
    if (input.targetFile && input.proposedContent !== undefined) {
      const targetPath = path.join(a5aiDir, input.targetFile)

      // Safety: must stay within a5aiDir
      if (!targetPath.startsWith(a5aiDir + path.sep)) {
        return { success: false, error: `targetFile "${input.targetFile}" escapes a5aiDir` }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, input.proposedContent, 'utf-8')
      written.push(targetPath)
    }

    // 3. Log so the developer watching `a5 logs` knows a proposal was filed
    await ctx.registry.appendLog(
      ctx.job.id,
      `[propose_change] Filed "${input.type}" proposal: ${input.title} → ${path.basename(proposalPath)}`,
    )

    ctx.logger.info(
      { jobId: ctx.job.id, type: input.type, slug, written },
      'Change proposal written — file watcher will open a PR',
    )

    return {
      success: true,
      output: {
        proposalFile: path.relative(a5aiDir, proposalPath),
        targetFile: input.targetFile ?? null,
        nextStep: 'File watcher will detect these changes and open a PR for human review.',
      },
    }
  } catch (err) {
    return { success: false, error: String(err) }
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
