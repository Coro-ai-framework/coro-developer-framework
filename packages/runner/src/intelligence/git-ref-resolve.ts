// ── Shared git ref resolution ────────────────────────────────────────────────
//
// Helpers for tenant overlays where the remote may use `master`, only publish
// a non-main default branch, or be temporarily empty until the writer pushes a
// bootstrap commit.

import type { SimpleGit } from 'simple-git'

/** Default suggestion when no explicit overlay ref is pinned. */
export const DEFAULT_OVERLAY_REF = 'main'

/**
 * Lists short branch names tracked under `refs/remotes/origin/` after a fetch,
 * excluding the synthetic `HEAD` symref row.
 */
export async function listOriginRemoteHeads(git: SimpleGit): Promise<string[]> {
  const out = await git
    .raw(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
    .catch(() => '')
  const names = new Set<string>()
  for (const line of out.split('\n')) {
    const s = line.trim()
    if (!s || s === 'origin/HEAD' || s.includes('->')) continue
    if (s.startsWith('origin/')) names.add(s.slice('origin/'.length))
  }
  return [...names].sort()
}

/**
 * Read `origin/HEAD` → default branch short name, if Git recorded it.
 */
export async function detectOriginDefaultBranch(git: SimpleGit): Promise<string | null> {
  try {
    const result = await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    const trimmed = (result ?? '').trim()
    if (trimmed.startsWith('origin/')) return trimmed.slice('origin/'.length)
  } catch {
    // ignore
  }
  return null
}

/**
 * Pick the branch to base tenant operations on. Call only when {@link listOriginRemoteHeads}
 * returned at least one name (caller bootstraps or skips empty remotes beforehand).
 *
 * - When `explicitRef` is set, it must exist on `origin` or we throw.
 * - When omitted, prefer `origin/HEAD`, then `main`, then `master`, then the first sorted
 *   remote head.
 */
export async function resolveOverlayBaseRef(
  git: SimpleGit,
  heads: string[],
  explicitRef: string | undefined,
): Promise<string> {
  if (explicitRef) {
    if (!heads.includes(explicitRef)) {
      throw new Error(
        `Tenant overlay ref "${explicitRef}" does not exist on origin (found: ${heads.join(', ')})`,
      )
    }
    return explicitRef
  }

  const sym = await detectOriginDefaultBranch(git)
  if (sym && heads.includes(sym)) return sym
  if (heads.includes('main')) return 'main'
  if (heads.includes('master')) return 'master'
  return heads[0]
}
