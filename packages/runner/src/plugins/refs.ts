// ── External-reference helpers ──────────────────────────────────────────────
//
// The `ExternalRef`, `ExternalRefKind`, and `NormalizedEvent` *types*
// live in `@coro-ai/cloud-protocol` — the wire-contract package shared by
// runner, cloud, and plugin SDK. This file owns the runner-side
// runtime helpers that operate on those types: storage-key
// normalisation, id stringification, and the state-backend lookup
// adapter. Helpers are *not* re-exported from `@coro-ai/cloud-protocol`;
// they're runner-internal concerns.

import type { ExternalRef } from '@coro-ai/cloud-protocol'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Storage form: the `repo_key` column is NOT NULL but defaults to the
 * empty string for kinds where repo is not meaningful. This helper
 * normalises `undefined` → `''` consistently across both backends so
 * row equality holds.
 */
export function repoKeyForStorage(ref: ExternalRef): string {
  if (ref.kind === 'pull_request') {
    if (!ref.repoKey || ref.repoKey.length === 0) {
      throw new Error(
        `ExternalRef of kind 'pull_request' requires a non-empty repoKey ` +
        `(plugin=${ref.pluginId}, externalId=${ref.externalId}). ` +
        `Without it, PR ids would alias across repositories.`,
      )
    }
    return ref.repoKey
  }
  return ref.repoKey ?? ''
}

/**
 * Stringify any provider-native id. Numeric PRs and other shaped ids
 * pass through `String()` so the resulting `externalId` is always a
 * string regardless of source.
 */
export function externalIdString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value === null || value === undefined) {
    throw new Error('externalIdString: value must not be null/undefined')
  }
  return String(value)
}

// ── Legacy adapter ───────────────────────────────────────────────────────────
//
// P5 introduces an `external_ref_mappings` table that owns lookups by
// {@link ExternalRef}. Until then, callers (the dispatcher, the cloud
// webhook router) need a single entry point that goes through the
// existing per-shape methods on the StateBackend. Keeping the
// adapter here means the migration in P5 only has to swap the body —
// every caller already speaks {@link ExternalRef}.

import type { Job, PrMapping } from '@coro-ai/cloud-protocol'
import type { StateBackend } from '../state/backend'
import type { PluginRegistry } from './registry'

/** The parts of a `Job` needed to identify which repo/PR it is about. */
type JobRepoContext = { params: Record<string, unknown>; prMappings: PrMapping[] }

/**
 * The repo a job's PR lives in.
 *
 * Prefers the `prMappings` entry for this specific PR — multi-repo jobs
 * carry several mappings and the first one is often a different repo.
 * Falls back to any mapping, then the job params, for jobs whose PR was
 * opened outside Coro's own `scm_create_pr` (e.g. through the provider's
 * MCP server) and so has no mapping at all.
 */
export function pickRepoKeyForPr(job: JobRepoContext, prId: number): string {
  const matched = job.prMappings.find(pm => pm.prId === prId && pm.repoSlug)
  if (matched?.repoSlug) return matched.repoSlug
  for (const pm of job.prMappings) {
    if (pm.repoSlug) return pm.repoSlug
  }
  for (const key of ['repoSlug', 'repo']) {
    const value = job.params[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/**
 * The canonical {@link ExternalRef} identifying a job's pull request.
 *
 * Both the poller (which delivers events) and the park path (which
 * registers the lookup row) must derive the *same* ref, or the exact
 * `external_ref_mappings` lookup misses and resolution degrades to an
 * ambiguous by-number search. Sharing one builder is what keeps them
 * byte-identical.
 *
 * Returns null when the job names no repo — there is nothing to address.
 */
export function buildPrExternalRef(
  job: JobRepoContext,
  prId: number,
  plugins: Pick<PluginRegistry, 'resolveByRemote' | 'default'>,
): ExternalRef | null {
  const repoKey = pickRepoKeyForPr(job, prId)
  if (!repoKey) return null

  // Prefer the SCM plugin that claims the repo. Falling back to the
  // registry default silently routes a GitHub PR to the Bitbucket
  // plugin when both are installed.
  const matched = plugins.resolveByRemote(repoKey)
  const pluginId = matched?.manifest.id ?? plugins.default('scm')?.manifest.id ?? 'unknown'
  return { kind: 'pull_request', pluginId, repoKey, externalId: String(prId) }
}

/** Bare repo name, lowercased — the part two spellings of a repo agree on. */
function repoName(value: string): string {
  const cleaned = value.trim().replace(/\.git$/, '')
  return (cleaned.split('/').filter(Boolean).pop() ?? '').toLowerCase()
}

/**
 * Does this job demonstrably belong to a *different* repo than the ref?
 *
 * Used to reject a candidate returned by the by-number fallback. PR
 * numbers restart at 1 in every repository, so "PR #5" on its own is not
 * an identity — without this check an approval on one repo's PR #5 can be
 * delivered to an unrelated job that happens to own another repo's PR #5.
 *
 * Deliberately asymmetric: only a positive contradiction rejects. A job
 * that names no repo, or a ref with no `repoKey`, stays acceptable so
 * older records still resolve.
 */
export function jobContradictsRef(job: JobRepoContext, ref: ExternalRef): boolean {
  if (!ref.repoKey) return false
  const target = repoName(ref.repoKey)
  if (!target) return false

  const known = new Set<string>()
  for (const pm of job.prMappings) {
    if (pm.repoSlug) known.add(repoName(pm.repoSlug))
  }
  for (const key of ['repoSlug', 'repo']) {
    const value = job.params[key]
    if (typeof value === 'string' && value) known.add(repoName(value))
  }

  if (known.size === 0) return false
  return !known.has(target)
}

/**
 * Resolve the job that owns a given {@link ExternalRef} using whichever
 * lookup the underlying backend provides:
 *
 *   1. If the backend implements {@link StateBackend.getJobByExternalRef}
 *      directly (P5+), call it.
 *   2. Otherwise, dispatch on `ref.kind`:
 *        - `pull_request` → {@link StateBackend.getJobByPr}
 *        - `ticket`       → {@link StateBackend.getJobByJiraTicket}
 *        - other kinds    → return `null`
 *
 * This adapter is the only place the dispatcher / cloud router cares
 * about the per-kind storage shape, so P5 can replace its body
 * without ripple.
 *
 * The `pull_request` fallback is by PR *number* only, which cannot tell
 * two repositories apart. Whatever it returns is therefore treated as a
 * suggestion and discarded if the job belongs to a different repo than
 * the ref — delivering an event to the wrong job is worse than dropping
 * it, because the intended job stays parked while another one is woken
 * with a PR event that has nothing to do with it.
 */
export async function resolveJobByExternalRef(
  backend: StateBackend,
  ref: ExternalRef,
): Promise<Job | null> {
  if (backend.getJobByExternalRef) {
    const exact = await backend.getJobByExternalRef(ref)
    if (exact) return exact
  }
  switch (ref.kind) {
    case 'pull_request': {
      const id = Number(ref.externalId)
      if (!Number.isFinite(id)) return null
      const candidate = await backend.getJobByPr(id)
      if (!candidate) return null
      return jobContradictsRef(candidate, ref) ? null : candidate
    }
    case 'ticket':
      return backend.getJobByJiraTicket(ref.externalId)
    default:
      return null
  }
}
