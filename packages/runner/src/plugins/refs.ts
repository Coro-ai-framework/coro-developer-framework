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

import type { Job } from '@coro-ai/cloud-protocol'
import type { StateBackend } from '../state/backend'

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
      return backend.getJobByPr(id)
    }
    case 'ticket':
      return backend.getJobByJiraTicket(ref.externalId)
    default:
      return null
  }
}
