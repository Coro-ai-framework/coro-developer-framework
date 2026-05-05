// ── PluginsConfig ────────────────────────────────────────────────────────────
//
// Uniform shape replacing the per-provider config blocks (`bitbucket`,
// `github`, `jira`, `linear`, `tracker`) under a single `plugins.installed`
// map keyed by plugin id. The runner reads this at bootstrap to build
// the {@link import('../plugins/registry').PluginRegistry}.
//
// v1 keeps the legacy keys readable for one release. The translator
// `legacyConfigToPlugins` (in `local-config.ts`) builds a synthetic
// PluginsConfig from those keys when `plugins` is absent so existing
// configs round-trip without manual edits.

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
