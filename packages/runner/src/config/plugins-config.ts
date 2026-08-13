// ── PluginsConfig ────────────────────────────────────────────────────────────
//
// Uniform shape for every provider plugin (executor, SCM, tracker)
// under a single `plugins.installed` map keyed by plugin id. The
// runner reads this at bootstrap to build the
// {@link import('../plugins/registry').PluginRegistry}. The legacy
// single-slot `git` / `tracker` / top-level `anthropic` blocks that
// used to live alongside this one were removed in the single-source-
// of-truth refactor.

import { z } from 'zod'

// ── Schema ───────────────────────────────────────────────────────────────────

const pluginInstallSchema = z.object({
  /**
   * `enabled: false` keeps the slot in config (for round-tripping)
   * but skips registration. Useful while toggling a provider on and
   * off without losing its credentials.
   */
  enabled: z.boolean().default(true),
  /**
   * Plugin-specific config. The registry validates this against the
   * plugin's `manifest.configSchema` at `init()` time. The on-disk
   * shape is intentionally `Record<string, unknown>` so the runner
   * can persist tenant config without hardcoding every plugin's
   * schema in `local-config.ts`.
   */
  config: z.record(z.string(), z.unknown()).default({}),
})

const pluginDefaultsSchema = z.object({
  scm: z.string().min(1).optional(),
  tracker: z.string().min(1).optional(),
})

export const pluginsConfigSchema = z.object({
  defaults: pluginDefaultsSchema.optional(),
  installed: z.record(z.string(), pluginInstallSchema).default({}),
})

export type PluginsConfig = z.infer<typeof pluginsConfigSchema>

/** Built-in SCM plugin ids — keep in sync with `BUILTIN_PLUGIN_IDS_BY_KIND.scm`. */
export const BUILTIN_SCM_PLUGIN_IDS = ['bitbucket', 'github', 'local'] as const

/**
 * Fresh installs should always have a zero-config SCM path. When no SCM
 * plugin is enabled yet, enable `local` and set it as the default.
 */
export function applyFreshInstallScmDefaults(config: PluginsConfig | undefined): PluginsConfig {
  const installed = { ...(config?.installed ?? {}) }
  const hasEnabledScm = Object.entries(installed).some(
    ([id, slot]) =>
      (BUILTIN_SCM_PLUGIN_IDS as readonly string[]).includes(id) && slot.enabled !== false,
  )
  if (hasEnabledScm) {
    return {
      ...(config?.defaults ? { defaults: config.defaults } : {}),
      installed,
    }
  }
  return {
    defaults: {
      ...(config?.defaults ?? {}),
      scm: config?.defaults?.scm ?? 'local',
    },
    installed: {
      ...installed,
      local: { enabled: true, config: {} },
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a partial PluginsConfig into the canonical shape (always
 * has `installed`, optional `defaults`). Used at config write time so
 * the disk shape is stable.
 */
export function normalisePluginsConfig(c: PluginsConfig | undefined): PluginsConfig {
  return {
    defaults: c?.defaults,
    installed: c?.installed ?? {},
  }
}
