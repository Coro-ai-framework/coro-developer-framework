// ── Phase → executor + model assignment ──────────────────────────────────────
//
// Single resolution point that bridges the workflow YAML's `model:` field
// (which may be a literal model id like `claude-sonnet-4-5` OR an alias key
// like `planning`/`coding` defined in `Settings.llm.aliases`) to the
// concrete `{ executor runtime, model id, modelHints }` triple the runner
// hands to {@link PhaseExecutorRuntime.executePhase}.
//
// Resolution order (mirrors plan §2.4):
//   1. If `phaseConf.model` matches an alias key in `settings.llm.aliases`,
//      use the alias's `{provider, model, reasoningEffort?}`.
//   2. Otherwise treat `phaseConf.model` as a literal model id and resolve
//      via `registry.resolveExecutor({provider: phaseConf.provider, model})`.
//   3. Workflow `phaseConf.provider` always wins over alias `provider` —
//      the workflow author is the most specific signal.
//
// All errors are `PluginResolutionError` so the runner's surface stays
// uniform with scm/tracker resolution.

import type { Settings } from '../config/settings'
import type { PluginRegistry } from '../plugins/registry'
import type {
  ExecutorCapabilities,
  PhaseExecutorRuntime,
} from '../plugins/types'
import type { PhaseConfig, SubagentConfig } from '../workflow-parser'

export interface ResolvedPhaseAssignment {
  /** Executor plugin runtime that will run this phase. */
  runtime: PhaseExecutorRuntime
  /** Concrete model id passed to `executePhase({ model })`. */
  model: string
  /** Resolved provider id (== `runtime.manifest.id`). Useful for logging. */
  provider: string
  /** Optional per-invocation hints sourced from the alias entry. */
  modelHints?: { reasoningEffort?: 'low' | 'medium' | 'high' }
  /** True when `phaseConf.model` matched an alias key. */
  resolvedFromAlias: boolean
  /** Snapshot of the chosen executor's capabilities (used by prompt builder). */
  capabilities: ExecutorCapabilities
}

/** Reasoning-effort hint carried on an alias entry. */
export type ReasoningEffort = 'low' | 'medium' | 'high'

/** A single alias-map entry (`settings.llm.aliases[key]`). */
export type AliasEntry = { provider: string; model: string; reasoningEffort?: ReasoningEffort }

/**
 * Outcome of resolving a phase/subagent's `{ model?, tier? }` against
 * the alias map. This is the single, shared resolution primitive — both
 * {@link selectModel} (string-only callers) and
 * {@link resolvePhaseAssignment} (executor + hints) are built on it so
 * the candidate order can never drift between the two.
 */
export interface ResolvedAlias {
  /** Concrete model id to run (alias target, literal pass-through, or bare tier). */
  model: string
  /** Provider from the matched alias entry, when the hit came from an alias. */
  provider?: string
  /** Reasoning-effort hint from the matched alias entry, if any. */
  reasoningEffort?: ReasoningEffort
  /** True when a candidate matched a key in the alias map. */
  resolvedFromAlias: boolean
  /** The alias key that matched (for logging/telemetry). */
  aliasKey?: string
}

/**
 * Resolve a `{ model?, tier? }` phase/subagent config against the alias
 * map. Resolution order (the canonical one — everything else delegates
 * here):
 *   1. `phaseConf.model` present → alias-map hit, else literal pass-through.
 *   2. else `tier:<tier>` (tier defaults to `planning`).
 *   3. else legacy bare `<tier>` shorthand.
 *   4. else the bare tier string as a literal model id (so the registry
 *      surfaces a clear "unknown model" error rather than silently
 *      picking a default).
 */
export function resolveModelAlias(
  phaseConf: { model?: string; tier?: string } | null | undefined,
  aliases: Record<string, AliasEntry>,
): ResolvedAlias {
  const fromEntry = (key: string, entry: AliasEntry): ResolvedAlias => ({
    model: entry.model,
    provider: entry.provider,
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    resolvedFromAlias: true,
    aliasKey: key,
  })

  if (phaseConf?.model) {
    const hit = aliases[phaseConf.model]
    if (hit) return fromEntry(phaseConf.model, hit)
    return { model: phaseConf.model, resolvedFromAlias: false }
  }

  const tier = phaseConf?.tier || 'planning'
  const tierHit = aliases[`tier:${tier}`]
  if (tierHit) return fromEntry(`tier:${tier}`, tierHit)
  const legacyHit = aliases[tier]
  if (legacyHit) return fromEntry(tier, legacyHit)
  return { model: tier, resolvedFromAlias: false }
}

/**
 * Resolve a workflow phase / subagent's model assignment to a concrete
 * executor runtime + model id. Pure function — no side effects, no I/O.
 *
 * Resolution priority (mirrors `selectModel` in `jobs/runner.ts`):
 *   1. `phaseConf.model` set → alias lookup → literal pass-through.
 *   2. `phaseConf.tier` set (or default `'planning'` for phases) →
 *      `tier:<tier>` alias from the plugin-seeded defaults.
 *   3. Legacy fallback: bare `<tier>` alias (e.g. the historical
 *      `planning`/`coding` shorthands).
 */
export function resolvePhaseAssignment(
  phaseConf:
    | Pick<PhaseConfig, 'model' | 'tier' | 'provider'>
    | Pick<SubagentConfig, 'model' | 'tier' | 'provider'>,
  settings: Settings,
  registry: PluginRegistry,
): ResolvedPhaseAssignment {
  const explicitProvider = phaseConf.provider
  const aliases = settings.llm?.aliases ?? {}

  const alias = resolveModelAlias(phaseConf, aliases)

  // Workflow `provider` overrides alias `provider` — the workflow author
  // wrote it more recently and more specifically. When the model came
  // through as a bare/literal (no alias hit) with no explicit provider,
  // leave `model` empty so the registry can route purely on provider /
  // tenant default rather than passing a bare tier name as a model id.
  const provider = explicitProvider ?? alias.provider
  const model = alias.resolvedFromAlias || phaseConf.model ? alias.model : ''
  const modelHints = alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : undefined

  const runtime = registry.resolveExecutor({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  })

  return {
    runtime,
    model,
    provider: runtime.manifest.id,
    ...(modelHints ? { modelHints } : {}),
    resolvedFromAlias: alias.resolvedFromAlias,
    capabilities: runtime.capabilities,
  }
}
