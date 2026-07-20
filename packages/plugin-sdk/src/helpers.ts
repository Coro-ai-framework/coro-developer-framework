// ── Plugin authoring helpers ────────────────────────────────────────────────
//
// Small, dependency-light utilities for plugin authors. The runner does
// not depend on this file — it only ships in `@coro-ai/plugin-sdk`.

import * as crypto from 'node:crypto'
import type { ExternalRefKind, ExternalRef } from '@coro-ai/cloud-protocol'
import type { ExecutorModelDescriptor, PluginMcpServerConfig } from './types'

// ── ExternalRef helpers ─────────────────────────────────────────────────────

/**
 * Stringify any provider-native id. Numeric PRs and other shaped ids
 * pass through `String()` so the resulting `externalId` is always a
 * string regardless of source. Throws on null/undefined to avoid
 * silently writing `'null'` to the database.
 */
export function externalIdString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value === null || value === undefined) {
    throw new Error('externalIdString: value must not be null/undefined')
  }
  return String(value)
}

/**
 * Build an {@link ExternalRef} with the right shape for a given kind.
 * Validates that `pull_request` carries a non-empty `repoKey` so PR id
 * `42` cannot alias across repositories.
 */
export function buildExternalRef(args: {
  kind: ExternalRefKind
  pluginId: string
  externalId: unknown
  repoKey?: string
  url?: string
}): ExternalRef {
  if (args.kind === 'pull_request' && (!args.repoKey || args.repoKey.length === 0)) {
    throw new Error(
      `buildExternalRef: kind='pull_request' requires a non-empty repoKey ` +
      `(plugin=${args.pluginId}, externalId=${String(args.externalId)})`,
    )
  }
  return {
    kind: args.kind,
    pluginId: args.pluginId,
    externalId: externalIdString(args.externalId),
    ...(args.repoKey ? { repoKey: args.repoKey } : {}),
    ...(args.url ? { url: args.url } : {}),
  }
}

// ── HMAC verification ───────────────────────────────────────────────────────

/**
 * Verify an HMAC-signed webhook body against a header value the
 * provider sent. Common shapes:
 *
 *   - GitHub: `sha256=<hex>` in `X-Hub-Signature-256`.
 *   - GitLab: `<hex>` in `X-Gitlab-Token` (NB: token, not signature).
 *   - Bitbucket Cloud: `sha256=<hex>` in `X-Hub-Signature`.
 *
 * The runner's webhook-bridge does the same check authoritatively at
 * the cloud edge using the manifest's webhook descriptor; plugins
 * implementing custom webhook logic can re-use this helper to verify
 * inbound payloads inside `normalizeInbound`.
 */
export function verifyHmacSignature(args: {
  algorithm: 'sha256' | 'sha1'
  secret: string
  rawBody: Buffer | string
  /** The header value the provider sent (e.g. `'sha256=<hex>'`). */
  signatureHeader: string | undefined
  /**
   * Strip a known prefix before comparing. Defaults match GitHub/Bitbucket.
   */
  prefix?: 'sha256=' | 'sha1=' | ''
}): boolean {
  if (!args.signatureHeader) return false
  const prefix = args.prefix ?? `${args.algorithm}=`
  if (prefix && !args.signatureHeader.startsWith(prefix)) return false
  const provided = prefix
    ? args.signatureHeader.slice(prefix.length)
    : args.signatureHeader
  const body = typeof args.rawBody === 'string' ? Buffer.from(args.rawBody) : args.rawBody
  const expected = crypto
    .createHmac(args.algorithm, args.secret)
    .update(body)
    .digest('hex')
  if (provided.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

// ── Header reader ───────────────────────────────────────────────────────────

/**
 * Case-insensitive header lookup that also unwraps the `string[]`
 * variant Node's HTTP types use for repeating headers (e.g.
 * `Set-Cookie`). Returns the first value or `undefined`.
 */
export function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase()
  const v = headers[lower] ?? headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

// ── MCP descriptor builder ──────────────────────────────────────────────────

/**
 * Build a stdio MCP server descriptor with sensible defaults. Lifts
 * the boilerplate out of plugin code so authors only express the
 * provider-specific bits (token env var, package name).
 *
 * ```ts
 * mcpServer() {
 *   return mcpStdioDescriptor({
 *     command: 'npx',
 *     args: ['-y', '@modelcontextprotocol/server-github'],
 *     env: { GITHUB_PERSONAL_ACCESS_TOKEN: this.token },
 *   })
 * }
 * ```
 */
export function mcpStdioDescriptor(args: {
  command: string
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}): PluginMcpServerConfig {
  return {
    type: 'stdio',
    command: args.command,
    ...(args.args ? { args: [...args.args] } : {}),
    ...(args.env ? { env: { ...args.env } } : {}),
  }
}

// ── Executor model-catalogue helpers ─────────────────────────────────────────
//
// The single source of truth for a provider's models is its
// `listModels()` catalogue. These helpers derive tier defaults from
// that catalogue so an executor never has to restate model ids: adding,
// retiring, or re-flagging a model in the catalogue updates every
// default automatically. Consumed by `defaultAliases()` and per-tier
// fallbacks in the built-in executors, and available to drop-in plugin
// authors for the same purpose.

/** The three capability tiers every executor publishes defaults for. */
export const MODEL_TIERS = ['planning', 'coding', 'mini'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * Resolve the canonical default model id for a tier from a catalogue.
 * Prefers the model explicitly flagged {@link ExecutorModelDescriptor.isDefault},
 * then falls back to the first catalogued model of that tier. Returns
 * `undefined` when the catalogue has no model for the tier.
 */
export function defaultModelForTier(
  models: ReadonlyArray<ExecutorModelDescriptor>,
  tier: ModelTier,
): string | undefined {
  const flagged = models.find(m => m.tier === tier && m.isDefault)
  if (flagged) return flagged.id
  return models.find(m => m.tier === tier)?.id
}

/**
 * Derive the canonical `tier:*` default aliases for a provider straight
 * from its model catalogue. Only tiers that have at least one catalogued
 * model produce an entry, so a provider that ships (say) no `mini`
 * model simply omits `tier:mini`.
 *
 * ```ts
 * defaultAliases() {
 *   return tierDefaultAliases(MY_MODELS, MY_PLUGIN_ID)
 * }
 * ```
 */
export function tierDefaultAliases(
  models: ReadonlyArray<ExecutorModelDescriptor>,
  provider: string,
): Record<string, { provider: string; model: string }> {
  const out: Record<string, { provider: string; model: string }> = {}
  for (const tier of MODEL_TIERS) {
    const model = defaultModelForTier(models, tier)
    if (model) out[`tier:${tier}`] = { provider, model }
  }
  return out
}
