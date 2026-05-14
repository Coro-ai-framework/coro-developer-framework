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

/**
 * Resolve a workflow phase / subagent's model assignment to a concrete
 * executor runtime + model id. Pure function — no side effects, no I/O.
 */
export function resolvePhaseAssignment(
  phaseConf: Pick<PhaseConfig, 'model' | 'provider'> | Pick<SubagentConfig, 'model' | 'provider'>,
  settings: Settings,
  registry: PluginRegistry,
): ResolvedPhaseAssignment {
  const requestedModel = phaseConf.model
  const explicitProvider = phaseConf.provider

  const aliasEntry =
    requestedModel !== undefined
      ? settings.llm?.aliases?.[requestedModel]
      : undefined
  let provider: string | undefined
  let model: string
  let modelHints: ResolvedPhaseAssignment['modelHints'] | undefined
  let resolvedFromAlias = false

  if (aliasEntry) {
    resolvedFromAlias = true
    // Workflow `provider` overrides alias `provider`. The workflow
    // author wrote it more recently and more specifically.
    provider = explicitProvider ?? aliasEntry.provider
    model = aliasEntry.model
    if (aliasEntry.reasoningEffort) {
      modelHints = { reasoningEffort: aliasEntry.reasoningEffort }
    }
  } else {
    provider = explicitProvider
    // No alias hit and no explicit model — leave `model` empty so the
    // registry routes purely on `provider` (or the tenant default).
    model = requestedModel ?? ''
  }

  const runtime = registry.resolveExecutor({
    provider,
    ...(model ? { model } : {}),
  })

  return {
    runtime,
    model,
    provider: runtime.manifest.id,
    ...(modelHints ? { modelHints } : {}),
    resolvedFromAlias,
    capabilities: runtime.capabilities,
  }
}
