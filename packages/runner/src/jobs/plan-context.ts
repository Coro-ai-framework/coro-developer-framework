import fs from 'node:fs/promises'
import path from 'node:path'
import type { Investigation } from '@coro-ai/cloud-protocol'
import type { StateBackend } from '../state/backend'

/** Subdirectory under the job working root for plan-mode investigation context. */
export const PLAN_CONTEXT_DIR = 'plan'

export const PLAN_FINDINGS_FILE = 'findings.md'

/** Same ceiling plan mode uses for a single file read. */
export const PLAN_FINDINGS_MAX_CHARS = 64 * 1024

const TRUNCATION_NOTE = '*[truncated — investigation write-up exceeded 64 KiB]*'

/**
 * Frame the investigation write-up for the spec-writer / planner. Returns
 * null when there is no current findings markdown to carry.
 */
export function renderPlanFindingsDocument(investigation: Investigation): string | null {
  const raw = investigation.findings?.trim() ?? ''
  if (!raw) return null

  const truncated = raw.length > PLAN_FINDINGS_MAX_CHARS
  const body = truncated ? `${raw.slice(0, PLAN_FINDINGS_MAX_CHARS)}\n\n${TRUNCATION_NOTE}` : raw

  const parts = [
    '# Plan-mode investigation findings',
    '',
    provenanceLine(investigation),
    '',
    'This run was created from a Coro plan-mode investigation. The write-up below is that',
    "investigation's conclusion: treat it as established and build on it rather than",
    're-deriving scope. Its file quotes are a snapshot taken during the investigation —',
    're-read any file you intend to change.',
    '',
    '---',
    '',
    body,
  ]

  const readiness = investigation.readiness
  const openQuestions = readiness?.openQuestions.filter(q => q.trim()) ?? []
  if (openQuestions.length > 0) {
    parts.push('', '---', '', '## Still open at dispatch', '')
    for (const question of openQuestions) {
      parts.push(`- ${question.trim()}`)
    }
  }

  if (readiness) {
    const note = readiness.note.trim()
    parts.push(
      '',
      `*Readiness at dispatch: ${readiness.state}${note ? ` — ${note}` : ''}*`,
    )
  }

  parts.push('')
  return parts.join('\n')
}

function provenanceLine(investigation: Investigation): string {
  const bits = [`Investigation \`${investigation.id}\``, `captured ${investigation.updatedAt}`]
  const provider = investigation.modelChoice?.provider?.trim()
  const model = investigation.modelChoice?.model?.trim()
  if (provider || model) {
    bits.push(`${provider || 'unknown'}/${model || 'unknown'}`)
  }
  return `*${bits.join(' · ')}*`
}

/**
 * Write `plan/findings.md` under the job working dir from the investigation
 * record. Idempotent overwrite. Returns null when there is nothing to write.
 */
export async function materializePlanContext(args: {
  investigationId: string
  jobWorkingDir: string
  stateBackend: Pick<StateBackend, 'getInvestigation'>
}): Promise<{ relativePath: string } | null> {
  const investigation = await args.stateBackend.getInvestigation(args.investigationId)
  if (!investigation) return null

  const document = renderPlanFindingsDocument(investigation)
  if (!document) return null

  const destDir = path.join(args.jobWorkingDir, PLAN_CONTEXT_DIR)
  await fs.mkdir(destDir, { recursive: true })
  await fs.writeFile(path.join(destDir, PLAN_FINDINGS_FILE), document, 'utf8')
  return { relativePath: `${PLAN_CONTEXT_DIR}/${PLAN_FINDINGS_FILE}` }
}
