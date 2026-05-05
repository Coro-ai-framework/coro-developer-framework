// ── Plugin registry ──────────────────────────────────────────────────────────
//
// Single source of truth for which plugins are loaded and how to
// resolve one for a given job or remote URL. Built once at runner
// bootstrap from the resolved `PluginsConfig` (legacy config gets
// translated through `legacyConfigToPlugins()`); read everywhere else.
//
// Resolution rules (mirrors the megaplan §4.4):
//   1. `params.scm` / `params.tracker` if set on the job.
//   2. `defaults.scm` / `defaults.tracker` if set in tenant config.
//   3. If still ambiguous (multiple plugins of that kind installed),
//      throw with the list of installed ids — never auto-pick.
//
// The registry never silently picks for you. The error message names
// the available ids so the user (or the agent's prompt) can correct
// the mistake on the next call.

import type {
  PluginExtensionToolProvider,
  PluginKind,
  PluginMcpToolDefinition,
  PluginRuntime,
  ScmPluginRuntime,
  TrackerPluginRuntime,
} from './types'

// ── Resolution input shapes ──────────────────────────────────────────────────

/**
 * Per-job hint the agent can set via `set_job_params({ scm: 'github' })`.
 * The runner merges this on top of tenant defaults at job boot.
 */
export interface PluginResolutionParams {
  scm?: string
  tracker?: string
}

/**
 * Tenant-wide defaults read from `PluginsConfig.defaults`. Identical
 * shape to {@link PluginResolutionParams} — kept distinct here so
 * intent at call sites is obvious (`defaults.scm` vs `params.scm`).
 */
export interface PluginResolutionDefaults {
  scm?: string
  tracker?: string
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown by `resolveScm` / `resolveTracker` when the job cannot pick a
 * single plugin. The message lists the installed plugin ids so the
 * caller can fix the request without spelunking config.
 */
export class PluginResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginResolutionError'
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface PluginRegistryEntry {
  runtime: PluginRuntime
}

export class PluginRegistry {
  private readonly byIdMap = new Map<string, PluginRegistryEntry>()
  private readonly byKindMap = new Map<PluginKind, PluginRegistryEntry[]>()
  private readonly defaults: PluginResolutionDefaults

  constructor(defaults: PluginResolutionDefaults = {}) {
    this.defaults = { ...defaults }
  }

  // ── Mutation (called only at bootstrap) ────────────────────────────────────

  /**
   * Register an already-instantiated runtime. Throws on duplicate id —
   * the registry refuses to silently overwrite a plugin so a
   * misconfigured tenant catches the conflict at startup rather than
   * at the first tool call.
   */
  register(runtime: PluginRuntime): void {
    const id = runtime.manifest.id
    if (this.byIdMap.has(id)) {
      throw new Error(
        `PluginRegistry.register: plugin id "${id}" already registered. ` +
        `Two plugins cannot share an id even across kinds.`,
      )
    }
    const entry: PluginRegistryEntry = { runtime }
    this.byIdMap.set(id, entry)
    const kindBucket = this.byKindMap.get(runtime.manifest.kind) ?? []
    kindBucket.push(entry)
    this.byKindMap.set(runtime.manifest.kind, kindBucket)
  }

  /**
   * Update the per-tenant defaults. Used by the dashboard's "set
   * default SCM" UI; the rest of the registry is otherwise immutable
   * after bootstrap.
   */
  setDefaults(defaults: PluginResolutionDefaults): void {
    this.defaults.scm = defaults.scm
    this.defaults.tracker = defaults.tracker
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  byId(id: string): PluginRuntime | undefined {
    return this.byIdMap.get(id)?.runtime
  }

  byKind<R extends PluginRuntime = PluginRuntime>(kind: PluginKind): R[] {
    const bucket = this.byKindMap.get(kind) ?? []
    return bucket.map(e => e.runtime as R)
  }

  /**
   * Iterate every installed plugin runtime in registration order.
   * Used by the dashboard's `/plugins` endpoint and the conformance
   * harness — both want the full set without filtering by kind.
   */
  all(): PluginRuntime[] {
    return Array.from(this.byIdMap.values()).map(e => e.runtime)
  }

  /**
   * Read the registry's current default selections. Distinct from
   * {@link default} so callers that need to render the *configured*
   * defaults (vs the resolved fallback) can avoid the auto-pick
   * behaviour.
   */
  getDefaults(): PluginResolutionDefaults {
    return { ...this.defaults }
  }

  /**
   * Return the kind's default plugin. Falls back to the only
   * installed plugin of that kind when there's exactly one — that's
   * the common case for solo deployments and lets the user skip
   * `defaults.scm` config.
   */
  default(kind: PluginKind): PluginRuntime | undefined {
    const explicit =
      kind === 'scm' ? this.defaults.scm
      : kind === 'tracker' ? this.defaults.tracker
      : undefined
    if (explicit) return this.byIdMap.get(explicit)?.runtime
    const installed = this.byKindMap.get(kind) ?? []
    return installed.length === 1 ? installed[0].runtime : undefined
  }

  // ── Resolution helpers (per-job) ───────────────────────────────────────────

  /**
   * Pick the SCM plugin for this job. Throws {@link PluginResolutionError}
   * with the list of installed ids when the choice is ambiguous so the
   * caller (typically the runner's MCP wiring) can surface a clear
   * error to the agent.
   */
  resolveScm(params: PluginResolutionParams = {}): ScmPluginRuntime {
    const r = this.resolveOne('scm', params.scm) as ScmPluginRuntime | undefined
    if (!r) throw this.ambiguousResolutionError('scm', params.scm)
    return r
  }

  resolveTracker(params: PluginResolutionParams = {}): TrackerPluginRuntime {
    const r = this.resolveOne('tracker', params.tracker) as TrackerPluginRuntime | undefined
    if (!r) throw this.ambiguousResolutionError('tracker', params.tracker)
    return r
  }

  /**
   * Find the SCM plugin that recognises the given remote URL. Used by
   * the self-improvement writer to pick the right PR client when the
   * job context doesn't carry an explicit SCM choice.
   *
   * Returns `undefined` when no plugin matches; callers throw with
   * remediation steps from the registry's full id list.
   */
  resolveByRemote(remoteUrl: string): ScmPluginRuntime | undefined {
    for (const entry of this.byKindMap.get('scm') ?? []) {
      const scm = entry.runtime as ScmPluginRuntime
      if (typeof scm.matchesRemote === 'function' && scm.matchesRemote(remoteUrl)) {
        return scm
      }
    }
    return undefined
  }

  // ── Extension tool harvesting ──────────────────────────────────────────────

  /**
   * Collect every plugin's `extensionTools()` output. The MCP server
   * registers these alongside the generic `scm_*` / `tracker_*` tools.
   * Refuses collisions (a plugin trying to register a name another
   * plugin already owns) so silent overrides never happen.
   */
  collectExtensionTools(): PluginMcpToolDefinition[] {
    const out: PluginMcpToolDefinition[] = []
    const seen = new Set<string>()
    for (const entry of this.byIdMap.values()) {
      const provider = entry.runtime as PluginExtensionToolProvider
      if (typeof provider.extensionTools !== 'function') continue
      for (const def of provider.extensionTools()) {
        if (seen.has(def.name)) {
          throw new Error(
            `PluginRegistry.collectExtensionTools: tool name "${def.name}" ` +
            `is registered by multiple plugins. Tool names must be unique.`,
          )
        }
        seen.add(def.name)
        out.push(def)
      }
    }
    return out
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Run every plugin's `dispose()` on shutdown. Errors are collected
   * and re-thrown as a single AggregateError so a misbehaving plugin
   * doesn't strand the others.
   */
  async dispose(): Promise<void> {
    const errors: unknown[] = []
    for (const entry of this.byIdMap.values()) {
      try {
        await entry.runtime.dispose()
      } catch (err) {
        errors.push(err)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'PluginRegistry.dispose: one or more plugins failed to dispose cleanly')
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private resolveOne(kind: PluginKind, requested?: string): PluginRuntime | undefined {
    if (requested) {
      const r = this.byIdMap.get(requested)
      if (!r) {
        throw new PluginResolutionError(
          `Job requested ${kind} plugin "${requested}" but it is not installed. ` +
          `Installed ${kind} plugins: [${this.installedIds(kind).join(', ') || '(none)'}].`,
        )
      }
      if (r.runtime.manifest.kind !== kind) {
        throw new PluginResolutionError(
          `Plugin "${requested}" is registered as kind "${r.runtime.manifest.kind}" ` +
          `but the job requested it as a "${kind}" plugin.`,
        )
      }
      return r.runtime
    }
    return this.default(kind)
  }

  private ambiguousResolutionError(kind: PluginKind, requested?: string): PluginResolutionError {
    const installed = this.installedIds(kind)
    if (installed.length === 0) {
      return new PluginResolutionError(
        `No ${kind} plugin installed. Add one in ~/.coro/config.json under "plugins.installed".`,
      )
    }
    return new PluginResolutionError(
      `Could not resolve a ${kind} plugin (${requested ? `requested="${requested}", ` : ''}` +
      `installed=[${installed.join(', ')}], ` +
      `default=${kind === 'scm' ? this.defaults.scm ?? '(none)' : this.defaults.tracker ?? '(none)'}). ` +
      `Set defaults.${kind} in config or pass params.${kind} on the job.`,
    )
  }

  private installedIds(kind: PluginKind): string[] {
    return (this.byKindMap.get(kind) ?? []).map(e => e.runtime.manifest.id)
  }
}

// ── Type-narrowing helpers ───────────────────────────────────────────────────

export function isScmPlugin(runtime: PluginRuntime): runtime is ScmPluginRuntime {
  return runtime.manifest.kind === 'scm'
}

export function isTrackerPlugin(runtime: PluginRuntime): runtime is TrackerPluginRuntime {
  return runtime.manifest.kind === 'tracker'
}

// Re-exported so call sites only need one import.
export type { AnyPluginRuntime } from './types'
