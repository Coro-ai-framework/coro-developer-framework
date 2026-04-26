// ── Repo overlay reader ──────────────────────────────────────────────────────
//
// Repo-level intelligence lives at `<repoCheckout>/.coro/`. It is the
// per-target-repo extension surface for Coro-specific content
// (workflows, agents, memory, MCP-server declarations).
//
// IMPORTANT — what this loader does NOT touch:
//
//   <repoCheckout>/.claude/
//
// The target repo's own `.claude/CLAUDE.md`, `.claude/skills/`,
// `.claude/agents/`, and `.claude/settings.json` are picked up
// **natively** by the Claude Agent SDK via `settingSources: ['project']`
// when the agent runs commands inside `<repoCheckout>`. Duplicating that
// loading here would either:
//   - shadow the repo's own `.claude/` (breaking a contract devs already
//     understand), or
//   - cause double-loading + non-deterministic ordering.
//
// Net result: a target repo with a pre-existing `.claude/` keeps it
// working through the SDK; teams that want Coro-specific extensions
// (workflows, agent role overrides, skills they want Coro to apply
// across the whole stack) drop them in `.coro/` and the resolver
// merges them as the topmost layer.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Logger } from 'pino'

export interface RepoOverlayLoaderArgs {
  /** Absolute path to the cloned target repository. */
  repoCheckoutDir: string
  logger: Logger
}

/**
 * Resolve the path to a repository's `.coro/` overlay directory, or
 * `null` if the repo has none (or the checkout doesn't exist yet —
 * common at job-start, since agents do their own clone).
 */
export async function loadRepoOverlay(
  args: RepoOverlayLoaderArgs,
): Promise<string | null> {
  const { repoCheckoutDir, logger } = args
  if (!repoCheckoutDir) return null

  const coroDir = path.join(repoCheckoutDir, '.coro')
  const stat = await fs.stat(coroDir).catch(() => null)
  if (!stat) return null
  if (!stat.isDirectory()) {
    logger.warn({ coroDir }, 'Repo overlay path exists but is not a directory — skipping')
    return null
  }
  return coroDir
}
