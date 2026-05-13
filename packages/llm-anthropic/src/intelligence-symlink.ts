import { lstatSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import type { Logger } from 'pino'

/**
 * Symlink {coroIntelligenceDir}/.claude into the job working directory so the Agent SDK's
 * native settingSources: ['project'] discovers .claude/CLAUDE.md and skills.
 * Uses a symlink (not copy) so the per-job overlay always reflects the
 * latest layered intelligence (base + tenant + repo) without copies
 * needing to be re-synced.
 */
export function ensureClaudeConfigSymlink(workingDir: string, coroIntelligenceDir: string, logger: Logger): void {
  const target = path.join(coroIntelligenceDir, '.claude')
  const link = path.join(workingDir, '.claude')
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) return
    rmSync(link, { recursive: true })
  } catch { /* doesn't exist yet — expected */ }
  try {
    symlinkSync(target, link, 'dir')
  } catch (err) {
    logger.warn({ err, target, link }, 'Could not create .claude symlink')
  }
}
