import { existsSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import type { Logger } from 'pino'

/**
 * What a Coro phase may load natively from `.claude/`: the ambient rules,
 * the skills it invokes on demand, and project settings.
 *
 * `agents/`, `commands/`, `memory/` and `coro/` are deliberately absent.
 * The intelligence layer is a native Claude Code tree, so the Agent SDK would
 * otherwise discover its 29 agents and 9 workflow commands as ambient
 * subagents and slash commands in every phase, which the runner never
 * asked for: it hands each phase exactly the subagents its workflow declares,
 * and reads `agents/`, `commands/` and `coro/` itself.
 */
export const EXPOSED_CLAUDE_ENTRIES = ['CLAUDE.md', 'skills', 'settings.json'] as const

/**
 * Build `{workingDir}/.claude` so the Agent SDK's native `settingSources:
 * ['project']` discovers `.claude/CLAUDE.md` and skills, and nothing else.
 *
 * `.claude` is a real directory holding one symlink per exposed entry, each
 * pointing into `{coroIntelligenceDir}/.claude/`. Symlinks (not copies) mean
 * the per-job overlay always reflects the latest layered intelligence
 * (base + tenant + repo) without needing to be re-synced.
 *
 * Idempotent: called every phase. An older install left a symlink to the
 * whole `.claude` directory here; it is replaced.
 */
export function ensureClaudeConfigSymlink(workingDir: string, coroIntelligenceDir: string, logger: Logger): void {
  const source = path.join(coroIntelligenceDir, '.claude')
  const dir = path.join(workingDir, '.claude')

  try {
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) rmSync(dir, { recursive: true, force: true })
  } catch { /* doesn't exist yet — expected */ }

  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    logger.warn({ err, dir }, 'Could not create .claude directory')
    return
  }

  for (const name of EXPOSED_CLAUDE_ENTRIES) {
    const link = path.join(dir, name)
    const target = path.join(source, name)

    // Always drop the previous link: the overlay is rebuilt each phase, and an
    // entry that no longer exists must not leave a dangling link behind.
    try {
      lstatSync(link)
      rmSync(link, { recursive: true, force: true })
    } catch { /* nothing to replace */ }

    if (!existsSync(target)) continue
    try {
      symlinkSync(target, link, statSync(target).isDirectory() ? 'dir' : 'file')
    } catch (err) {
      logger.warn({ err, target, link }, 'Could not create .claude symlink')
    }
  }
}
