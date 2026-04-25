// ── Tenant context ────────────────────────────────────────────────────────────
//
// Every job in Coro runs against a TenantContext that identifies which
// tenant (a single developer in solo mode, a team in hybrid mode) the job
// belongs to. The intelligence resolver, the state backend, and the
// proposal-routing layer all read from this context to scope reads and
// writes correctly.
//
// In solo mode (legacy + local deployment modes) the runner synthesizes a
// stable `solo-<hostname>` tenant. In hybrid mode the runner derives the
// tenant from the JWT it uses to authenticate to the cloud control plane
// — `teamId` is already extracted as part of the WS handshake.
//
// This file is deliberately tiny and dependency-free: it is consumed by
// the runner bootstrap (no fancy types yet), the resolver, and tests.

import * as os from 'node:os'

/** Whether this runner instance is acting on behalf of one developer or a team. */
export type TenantMode = 'solo' | 'team'

/**
 * Where a tenant's intelligence overlay is sourced from.
 *
 * The resolver currently honours only `kind: 'none'` (Phase 3). Phase 4
 * adds `localDir`, `gitRemote`, and `cloudBlob` overlay loaders.
 */
export type TenantOverlaySource =
  /** No tenant overlay — the runner uses only the base layer. */
  | { kind: 'none' }
  /** Overlay files live on the local filesystem (used in dev / single-host setups). */
  | { kind: 'localDir', path: string }
  /** Overlay files live in a remote git repository the runner clones. */
  | { kind: 'gitRemote', url: string, ref?: string }
  /** Overlay files live in a cloud blob store, fetched via the cloud API. */
  | { kind: 'cloudBlob', key: string }

export interface TenantContext {
  /**
   * Stable identifier for this tenant.
   *
   *   solo mode:  `solo-<hostname>`            e.g. `solo-emre-mbp`
   *   team mode:  `team-<teamId>`              e.g. `team-1f3c2a4b`
   *
   * Used as a key for state backends, log scoping, and overlay caches.
   */
  tenantId: string

  /** Solo (single dev) vs team (shared SaaS) deployment mode. */
  mode: TenantMode

  /** Human-readable name. Surfaced in CLI output and the dashboard. */
  displayName: string

  /** Where this tenant's intelligence overlay comes from (Phase 4+). */
  overlay: TenantOverlaySource
}

/**
 * Normalise a raw hostname into a filesystem- and id-safe slug.
 *   - strips trailing `.local` (mDNS),
 *   - lowercases,
 *   - replaces anything outside [a-z0-9-] with `-`.
 *
 * Exported for tests; production code goes through {@link synthesizeSoloTenant}.
 */
export function normaliseHostname(raw: string): string {
  if (!raw) return 'localhost'
  const slug = raw
    .replace(/\.local$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
  return slug.length > 0 ? slug : 'localhost'
}

/**
 * Defensive hostname read for the `solo-<host>` tenant id. Returns
 * `localhost` if `os.hostname()` is unavailable or throws.
 */
function readHostname(): string {
  try {
    const h = os.hostname()
    return h && h.length > 0 ? h : 'localhost'
  } catch {
    return 'localhost'
  }
}

/** Optional overrides for {@link synthesizeSoloTenant}. */
export interface SynthesizeSoloOptions {
  /** Optional explicit hostname (primarily for tests). */
  hostnameOverride?: string
  /** Override the auto-derived `Solo (<host>)` display name. */
  displayName?: string
  /**
   * Tenant overlay source. When omitted, the tenant runs against base
   * intelligence only (`{ kind: 'none' }`).
   */
  overlay?: TenantOverlaySource
}

/**
 * Build the implicit solo tenant for a developer running Coro on their own
 * machine. Used by legacy (Redis monolith) and local (SQLite + polling)
 * deployment modes — neither of which carries an external tenant identity.
 *
 * @param opts Optional hostname override (tests), display name override,
 *   and overlay source (from `~/.coro/config.json -> tenant.overlay`).
 */
export function synthesizeSoloTenant(opts: SynthesizeSoloOptions = {}): TenantContext {
  const host = normaliseHostname(opts.hostnameOverride ?? readHostname())
  return {
    tenantId: `solo-${host}`,
    mode: 'solo',
    displayName: opts.displayName ?? `Solo (${host})`,
    overlay: opts.overlay ?? { kind: 'none' },
  }
}

/** Optional overrides for {@link tenantFromTeamId}. */
export interface TenantFromTeamIdOptions {
  displayName?: string
  /**
   * Overlay descriptor supplied by the cloud control plane (Phase 5).
   * For Phase 4 the WebSocket handshake doesn't carry overlays yet, so
   * the runner leaves this `undefined` and the tenant runs base-only.
   */
  overlay?: TenantOverlaySource
}

/**
 * Build a team tenant from the `teamId` already extracted from the runner
 * JWT in hybrid mode. Optional `displayName` lets the cloud control plane
 * supply a friendlier label; optional `overlay` is reserved for the
 * Phase 5 cloud handshake.
 */
export function tenantFromTeamId(teamId: string, opts: TenantFromTeamIdOptions = {}): TenantContext {
  if (!teamId) {
    throw new Error('tenantFromTeamId: teamId is required')
  }
  return {
    tenantId: `team-${teamId}`,
    mode: 'team',
    displayName: opts.displayName ?? `Team ${teamId}`,
    overlay: opts.overlay ?? { kind: 'none' },
  }
}
