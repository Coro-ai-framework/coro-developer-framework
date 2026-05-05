// ── External references ──────────────────────────────────────────────────────
//
// Provider-neutral primitives for referring to external objects (PRs,
// tickets, repos, issues) regardless of which plugin owns them. Lives in
// its own module because both plugin runtimes and state-backend code
// need it; pulling it from `types.ts` would create an import cycle.
//
// The `kind` axis is intentionally narrow — adding a new kind (e.g.
// `'release'` or `'pipeline'`) means deciding what `repoKey` /
// `externalId` mean for it and adding a row to the conformance test
// pack. Don't widen casually.

export type ExternalRefKind = 'pull_request' | 'ticket' | 'repo' | 'issue'

/**
 * Provider-neutral pointer to an external object.
 *
 * Required fields:
 *   - `kind` discriminates the shape downstream code expects.
 *   - `pluginId` says which plugin owns this ref (e.g. `'github'`).
 *   - `externalId` is the provider-native id rendered as a string.
 *     Numeric PR ids are stringified at the boundary so the rest of the
 *     pipeline never has to special-case `number | string`.
 *
 * `repoKey` is REQUIRED for `kind: 'pull_request'` to disambiguate PR
 * id `42` in two different repos within the same plugin. The schema
 * (Postgres / SQLite) carries it as the empty string for kinds where
 * a repo is not meaningful (free-floating tickets, plugin-wide
 * issues), but the runtime constructor accepts `undefined` and lets
 * the storage layer normalise.
 */
export interface ExternalRef {
  kind: ExternalRefKind
  pluginId: string
  /** REQUIRED for `kind: 'pull_request'`. e.g. `'acme/svc-go'`. */
  repoKey?: string
  externalId: string
  url?: string
}

/**
 * A plugin-normalised inbound event. The plugin's webhook handler
 * collapses provider-specific shapes into this envelope so the
 * dispatcher only knows about ExternalRef + a high-level kind string
 * (e.g. `'pr.merged'`, `'ticket.transitioned'`).
 *
 * `raw` is forwarded verbatim to the prompt builder so the agent can
 * read the original payload when it needs detail the normalised
 * envelope doesn't carry.
 */
export interface NormalizedEvent {
  ref: ExternalRef
  /** Plugin-defined high-level event name (e.g. `'pr.merged'`). */
  kind: string
  raw: unknown
  receivedAt: string
}

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
