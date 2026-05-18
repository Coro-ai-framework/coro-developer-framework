// ── External references ──────────────────────────────────────────────────────
//
// Provider-neutral primitives for referring to external objects (PRs,
// tickets, repos, issues) regardless of which plugin owns them. Lives
// in the wire-contract package because *all three* of runner, cloud
// server, and plugin authors need to agree on the exact same shape:
//
//   - The runner's state backend keys mappings by `ExternalRef`.
//   - The cloud's WS gateway forwards plugin webhook events tagged
//     with an `ExternalRef` to the owning runner.
//   - Plugins produce `ExternalRef` values from their `normalizeInbound`
//     and `pollPr` implementations.
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
 *     Numeric PR ids are stringified at the boundary so the rest of
 *     the pipeline never has to special-case `number | string`.
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
