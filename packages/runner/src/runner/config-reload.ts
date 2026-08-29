// ── Hot reload for in-memory runner state ────────────────────────────────────
//
// The runner reads `~/.coro/config.json` exactly once at boot:
//   1. `loadLocalConfig()` snapshots the JSON.
//   2. `buildSettingsFromLocal(config)` snapshots into `Settings`.
//   3. `buildBuiltinPluginRegistry(...)` instantiates each plugin and
//      calls `runtime.init(slot.config)` once.
//   4. `createGitClient(settings)` / `createBitBucketClients(settings)` /
//      etc. capture credentials into client instances.
//
// All of the above end up on the `RunnerContext` the `Dispatcher`
// holds. Saving new config via `PUT /config` writes new JSON to disk
// but never tells the running process — which is why credential
// changes historically required a runner restart.
//
// This module is the single place that re-derives those caches from
// the on-disk config and swaps the new values into the existing
// `RunnerContext` reference. The Dispatcher reads `ctx.settings` /
// `ctx.plugins` / `ctx.gitClient` etc. field-by-field on every job,
// so `Object.assign(ctx, …)` is enough — the next job dispatched
// after reload picks up the new credentials without a restart.
//
// Two changes that hot-reload covers:
//   • Credentials on already-installed plugins. Every built-in
//     plugin's `init()` is the supported credential-rotation hook;
//     calling it again on the same runtime instance is safe and
//     preserves any HTTP routes the plugin mounted (e.g. Anthropic
//     OAuth login).
//   • Newly-enabled plugin slots. Instantiated via the same
//     `instantiatePlugin()` helper boot uses, registered with the
//     existing `PluginRegistry`, and late-mounted against the live
//     express app via the `lateMountPlugin` callback.
//
// Two changes that still require a restart:
//   • `paths.workingDir` / `paths.coroIntelligenceDir` — pinned into
//     the SQLite state backend at construction.
//   • `cloud.url` / `cloud.token` — the runner's transport (polling
//     vs WebSocket) is chosen at bootstrap by `detectMode`.

import type { Logger } from 'pino'
import type { PluginRuntime } from '../plugins/types'
import type { RunnerContext } from '../jobs/runner'
import {
  loadLocalConfig,
  resolvePluginsConfig,
  type LocalConfig,
} from '../config/local-config'
import { resolveContributionCredential } from '../config/contribution-credential'
import {
  applyContributionCredential,
  BUILTIN_PLUGIN_IDS_BY_KIND,
  instantiatePlugin,
} from '../plugins/builtin'
import { buildDropinFactoryMap } from '../plugins/loader'
import { createBitBucketClients } from '../clients/bitbucket'
import { createGitClient, createGitHubGitClient } from '../clients/git'
import { createGitHubClient } from '../clients/github'
import { createLokiClient } from '../clients/loki'
import { createTempoClient } from '../clients/tempo'
import { buildSettingsFromLocal, seedExecutorDefaultAliases } from './build-settings'

/**
 * Late-mount callback supplied by the server. Mounts the plugin's
 * own HTTP routes (if any) against the running express app. The
 * server defines this closure so it can reuse the exact same
 * `saveLocalConfig` / `savePluginConfig` / `redactSecret` helpers the
 * boot-time route registration uses.
 */
export type LateMountPlugin = (runtime: PluginRuntime) => void

export interface ReloadResult {
  /** Plugin ids whose `init()` succeeded with the freshly-read config. */
  updated: string[]
  /** Plugin ids that were newly instantiated and registered. */
  added: string[]
  /** Plugin ids that failed to re-init or instantiate (logged, not thrown). */
  failed: Array<{ id: string; error: string }>
}

/**
 * Re-read `~/.coro/config.json` and swap the result into the existing
 * `RunnerContext`. Safe to call repeatedly. Never throws — individual
 * plugin failures are collected into `ReloadResult.failed` so the
 * dashboard can surface them without a 500.
 *
 * Concurrency model: this is called from the HTTP server's request
 * handler thread. In-flight jobs that already captured the old
 * `ctx.gitClient` / `ctx.bbCoder` / plugin runtime keep using them
 * for the remainder of their current phase — credentials don't get
 * yanked out from under a running tool call. New jobs (and new
 * phases of paused jobs that resume after the reload) see the new
 * values.
 */
export async function reloadRunnerState(args: {
  ctx: RunnerContext
  lateMountPlugin: LateMountPlugin
  logger: Logger
}): Promise<ReloadResult> {
  const { ctx, lateMountPlugin, logger } = args
  const result: ReloadResult = { updated: [], added: [], failed: [] }

  // ── 1. Re-read config ────────────────────────────────────────────────────
  //
  // `loadLocalConfig` returns null when the file is absent. That's the
  // post-`coro init` first-boot shape — fall back to an empty config
  // so the rest of the function still rebuilds (with empty plugin
  // configs) instead of bailing.
  const config: LocalConfig =
    loadLocalConfig() ?? ({ plugins: { installed: {} } } as LocalConfig)

  // ── 2. Rebuild Settings + downstream clients ─────────────────────────────
  //
  // Clients are cheap to reconstruct; doing it unconditionally keeps the
  // reload path deterministic. We swap them onto `ctx` in one
  // `Object.assign` so the Dispatcher never reads a half-updated
  // context.
  const newSettings = buildSettingsFromLocal(config)
  const { coder: bbCoder, reviewer: bbReviewer } = createBitBucketClients(newSettings)
  const newClients = {
    settings: newSettings,
    gitClient: createGitClient(newSettings),
    bbCoder,
    bbReviewer,
    ghClient: createGitHubClient(newSettings),
    ghGitClient: createGitHubGitClient(newSettings),
    lokiClient: createLokiClient(newSettings),
    tempoClient: createTempoClient(newSettings),
  }
  Object.assign(ctx, newClients)

  // ── 3. Refresh credentials on already-registered plugins ────────────────
  //
  // We re-call `runtime.init(newConfig)` on each existing instance
  // rather than instantiating new ones. This keeps any HTTP routes
  // the plugin mounted at boot pointing at a live runtime — the
  // Anthropic plugin's OAuth callback is the canonical example.
  const pluginsConfig = resolvePluginsConfig(config)
  const installedSlots = pluginsConfig.installed ?? {}
  const existingRuntimes = ctx.plugins.all()
  const existingIds = new Set(existingRuntimes.map((r) => r.manifest.id))

  for (const runtime of existingRuntimes) {
    const id = runtime.manifest.id
    const slot = installedSlots[id]
    // Plugin slot was removed or disabled. We deliberately leave the
    // runtime registered with whatever creds it already has — dropping
    // it would unmount its HTTP routes. Operators that truly want to
    // disable a provider can restart the runner; the wizard flow only
    // adds / updates slots.
    if (!slot || !slot.enabled) continue
    try {
      await runtime.init(slot.config ?? {}, {
        logger,
        fetch: globalThis.fetch,
      })
      result.updated.push(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id, error: message })
      logger.warn(
        { err, pluginId: id },
        'Plugin re-init failed during config reload — keeping previous credentials',
      )
    }
  }

  // Built-in executor plugins are auto-loaded with empty config at
  // boot via the `buildBuiltinPluginRegistry` fallback, so they
  // always appear in `existingRuntimes` above. If a tenant just
  // wrote their first config slot for one (e.g. picked Anthropic in
  // the wizard), the loop above already adopted it. No special-case
  // needed.

  // ── 4. Instantiate newly-enabled plugin slots ───────────────────────────
  //
  // SCM and tracker plugins are not pre-loaded — they only get
  // instantiated when the user has a `plugins.installed.<id>` slot
  // for them. When the wizard or settings panel adds the very first
  // slot for a provider, we instantiate it here and late-mount its
  // (rare) HTTP routes against the live express app.
  const dropinFactories = await buildDropinFactoryMap({ pluginsConfig, logger })
  for (const [id, slot] of Object.entries(installedSlots)) {
    if (!slot.enabled) continue
    if (existingIds.has(id)) continue
    try {
      const runtime = await instantiatePlugin({
        id,
        config: slot.config ?? {},
        logger,
        dropinFactories,
        settings: newSettings,
      })
      if (!runtime) {
        // Unknown id — neither built-in nor drop-in. Mirror the
        // bootstrap log so operators see the same hint as on cold
        // start.
        logger.warn(
          { pluginId: id },
          'Plugin id is neither a built-in nor a drop-in plugin — skipping (check ~/.coro/plugins/<id>/ or the spelling)',
        )
        continue
      }
      await runtime.init(slot.config ?? {}, {
        logger,
        fetch: globalThis.fetch,
      })
      ctx.plugins.register(runtime)
      lateMountPlugin(runtime)
      result.added.push(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id, error: message })
      logger.warn(
        { err, pluginId: id },
        'Plugin instantiation failed during config reload — skipping',
      )
    }
  }

  // Re-bind the contribution identity on every SCM plugin. `init()` above
  // rotates the plugin's own credentials but knows nothing about this one, so
  // without this an edit to Settings → Coro contribution would not reach a
  // running runner — including clearing the token, which passes `undefined`.
  applyContributionCredential(
    ctx.plugins,
    resolveContributionCredential(newSettings.upstream),
  )

  // ── 5. Update registry defaults + alias seeds ───────────────────────────
  //
  // `defaults.executor` is the resolver's fallback when a phase
  // doesn't pin a provider explicitly. The dashboard's "set as
  // default" toggle writes `llm.defaultProvider` — mirror that onto
  // the live registry so the next job picks the chosen plugin
  // without a restart.
  const currentDefaults = ctx.plugins.getDefaults()
  ctx.plugins.setDefaults({
    ...currentDefaults,
    ...(pluginsConfig.defaults?.scm ? { scm: pluginsConfig.defaults.scm } : {}),
    ...(pluginsConfig.defaults?.tracker
      ? { tracker: pluginsConfig.defaults.tracker }
      : {}),
    ...(config.llm?.defaultProvider
      ? { executor: config.llm.defaultProvider }
      : {}),
  })
  seedExecutorDefaultAliases({ plugins: ctx.plugins, settings: newSettings })

  logger.info(
    {
      updated: result.updated,
      added: result.added,
      failed: result.failed.map((f) => f.id),
    },
    'Runner state hot-reloaded from disk',
  )

  // Silence the unused-import lint in case `BUILTIN_PLUGIN_IDS_BY_KIND`
  // becomes redundant once the auto-load logic moves; keeping the
  // import documents the boot-time invariant this module relies on.
  void BUILTIN_PLUGIN_IDS_BY_KIND
  return result
}
