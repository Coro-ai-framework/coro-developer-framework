import fs from 'fs/promises'
import path from 'path'
import { ToolContext } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileEntry {
  path: string
  content: string
}

type ProposalType =
  | 'new-tool'
  | 'modify-tool'
  | 'new-workflow'
  | 'modify-workflow'
  | 'new-agent'
  | 'modify-agent'
  | 'convention-change'
  | 'memory-update'
  | 'knowledge-update'
  | 'source-change'

// ── propose_change ────────────────────────────────────────────────────────────

/**
 * Propose one or more file changes to the a5-ai repo.
 *
 * Supports multi-file proposals so that related changes (e.g. a new tool's YAML
 * schema + TypeScript implementation + registration) can ship as a single atomic
 * PR. All files are written to disk; the file watcher validates them (TypeScript
 * build, YAML parse, workflow config parse) and opens a PR for human review.
 *
 * Nothing takes effect until a human merges the PR.
 */
export async function proposeChange(
  input: {
    type: ProposalType
    title: string
    rationale: string
    description: string
    /** Single file — for backward compatibility */
    targetFile?: string
    proposedContent?: string
    /** Multiple files — preferred for multi-file proposals */
    files?: FileEntry[]
  },
  ctx: ToolContext,
): Promise<unknown> {
  const a5aiDir = ctx.settings.paths.a5aiDir
  const slug = toSlug(input.title)
  const timestamp = new Date().toISOString().slice(0, 10)

  // Normalize: merge legacy single-file field into files array
  const files: FileEntry[] = [...(input.files ?? [])]
  if (input.targetFile && input.proposedContent !== undefined) {
    files.push({ path: input.targetFile, content: input.proposedContent })
  }

  // Validate all paths are within a5aiDir
  for (const file of files) {
    const abs = path.resolve(a5aiDir, file.path)
    if (!abs.startsWith(a5aiDir + path.sep)) {
      throw new Error(`File path "${file.path}" escapes a5aiDir`)
    }
  }

  // 1. Write the human-readable proposal summary
  const proposalDir = path.join(a5aiDir, 'memory', 'proposals')
  await fs.mkdir(proposalDir, { recursive: true })

  const proposalPath = path.join(proposalDir, `${timestamp}-${slug}.md`)
  const proposalContent = buildProposalMarkdown(input, files, ctx)
  await fs.writeFile(proposalPath, proposalContent, 'utf-8')

  const written: string[] = [path.relative(a5aiDir, proposalPath)]

  // 2. Write all proposed files
  for (const file of files) {
    const absPath = path.resolve(a5aiDir, file.path)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, file.content, 'utf-8')
    written.push(file.path)
  }

  // 3. Log
  await ctx.registry.appendLog(
    ctx.job.id,
    `[propose_change] Filed "${input.type}" proposal: ${input.title} (${files.length} file(s))`,
  )

  ctx.logger.info(
    { jobId: ctx.job.id, type: input.type, slug, fileCount: files.length },
    'Change proposal written — file watcher will open a PR',
  )

  return {
    proposalFile: path.relative(a5aiDir, proposalPath),
    filesWritten: written,
    fileCount: files.length,
    nextStep: 'File watcher will detect these changes, validate them, and open a PR for human review.',
  }
}

// ── list_proposals ────────────────────────────────────────────────────────────

/**
 * List past proposals filed by agents. Agents use this to:
 *   - Avoid re-proposing something that was already filed
 *   - Learn from rejected proposals (build failures)
 *   - Check what improvements are pending review
 */
export async function listProposals(
  input: { limit?: number; type?: string },
  ctx: ToolContext,
): Promise<unknown> {
  const proposalDir = path.join(ctx.settings.paths.a5aiDir, 'memory', 'proposals')

  let entries: string[]
  try {
    entries = await fs.readdir(proposalDir)
  } catch {
    return { proposals: [], count: 0, message: 'No proposals directory found yet.' }
  }

  // Only .md files, sorted newest first (filenames start with date)
  const mdFiles = entries
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()

  const limit = input.limit ?? 20
  const filtered = input.type
    ? mdFiles.filter(f => f.includes(input.type!))
    : mdFiles
  const selected = filtered.slice(0, limit)

  const proposals = await Promise.all(
    selected.map(async (filename) => {
      const content = await fs.readFile(path.join(proposalDir, filename), 'utf-8')
      return {
        filename,
        // Extract structured metadata from the markdown
        title: extractField(content, /^# Proposal: (.+)$/m),
        type: extractField(content, /^\*\*Type:\*\* (.+)$/m),
        date: extractField(content, /^\*\*Date:\*\* (.+)$/m),
        proposedBy: extractField(content, /^\*\*Proposed by job:\*\* (.+)$/m),
        isBuildFailure: filename.includes('build-failure'),
        // Include first 500 chars of rationale for context
        preview: extractSection(content, '## Rationale', 500)
          ?? extractSection(content, '## Compiler output', 500)
          ?? content.slice(0, 300),
      }
    }),
  )

  return {
    proposals,
    count: proposals.length,
    totalOnDisk: mdFiles.length,
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

function extractField(md: string, regex: RegExp): string | null {
  const match = regex.exec(md)
  return match ? match[1].trim() : null
}

function extractSection(md: string, heading: string, maxLen: number): string | null {
  const idx = md.indexOf(heading)
  if (idx === -1) return null
  const start = md.indexOf('\n', idx) + 1
  const nextHeading = md.indexOf('\n## ', start)
  const end = nextHeading === -1 ? md.length : nextHeading
  return md.slice(start, Math.min(end, start + maxLen)).trim()
}

function buildProposalMarkdown(
  input: Parameters<typeof proposeChange>[0],
  files: FileEntry[],
  ctx: ToolContext,
): string {
  const lines = [
    `# Proposal: ${input.title}`,
    '',
    `**Type:** ${input.type}`,
    `**Proposed by job:** ${ctx.job.id} (${ctx.job.type}, phase: ${ctx.job.phase})`,
    `**Date:** ${new Date().toISOString()}`,
    `**Files:** ${files.length}`,
    '',
    '## Rationale',
    '',
    input.rationale,
    '',
    '## Description',
    '',
    input.description,
  ]

  if (files.length > 0) {
    lines.push('', '## Files')
    for (const file of files) {
      const ext = file.path.split('.').pop() ?? ''
      lines.push(
        '',
        `### \`${file.path}\``,
        '',
        `\`\`\`${ext}`,
        file.content.length > 5000
          ? file.content.slice(0, 5000) + '\n... (truncated in proposal summary)'
          : file.content,
        '```',
      )
    }
  }

  lines.push(
    '',
    '---',
    '_This proposal was generated automatically by an agent. Review and merge to apply._',
  )

  return lines.join('\n')
}
