// ── Local config reader/writer (~/.coro/config.json) ─────────────────────────
//
// Manages the runner's local configuration file. In hybrid mode this holds the
// cloud URL, runner token, and Anthropic API key. In local mode, it stores
// paths and git credentials. The runner reads this at startup to determine its
// deployment mode.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'

// ── Schema ───────────────────────────────────────────────────────────────────

const cloudConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
}).optional()

const claudeAccountSchema = z.object({
  email: z.string().optional(),
  organization: z.string().optional(),
  subscriptionType: z.string().optional(),
  tokenSource: z.string().optional(),
  apiKeySource: z.string().optional(),
  apiProvider: z.enum(['firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'mantle']).optional(),
}).optional()

// Anthropic auth supports three modes:
//   - apiKey: direct Anthropic API key (production, billed per token)
//   - oauth: legacy long-lived Claude Code OAuth token from `claude setup-token`
//   - claudeLogin: Claude Code manages its own persisted login session locally;
//                  we only store the selected mode plus optional account metadata
// The method field is optional/defaulted so that legacy configs containing only
// `{ apiKey: "..." }` continue to load. The refine() guarantees that the chosen
// method has a matching non-empty credential.
const anthropicConfigSchema = z
  .object({
    method: z.enum(['apiKey', 'oauth', 'claudeLogin']).default('apiKey'),
    apiKey: z.string().optional(),
    oauthToken: z.string().optional(),
    account: claudeAccountSchema,
  })
  .refine(
    v =>
      (v.method === 'apiKey' && typeof v.apiKey === 'string' && v.apiKey.length > 0) ||
      (v.method === 'oauth' && typeof v.oauthToken === 'string' && v.oauthToken.length > 0) ||
      v.method === 'claudeLogin',
    {
      message:
        'Anthropic config requires apiKey when method="apiKey", oauthToken when method="oauth", or method="claudeLogin"',
    },
  )

const intelligenceConfigSchema = z.object({
  dir: z.string().min(1),
  gitRemote: z.string().optional(),
}).optional()

const pathsConfigSchema = z.object({
  workingDir: z.string().min(1),
}).optional()

const gitConfigSchema = z.object({
  provider: z.enum(['bitbucket', 'github', 'gitlab']),
  workspace: z.string().optional(),
  username: z.string().min(1),
  token: z.string().min(1),
}).optional()

const localConfigSchema = z.object({
  cloud: cloudConfigSchema,
  anthropic: anthropicConfigSchema,
  intelligence: intelligenceConfigSchema,
  paths: pathsConfigSchema,
  git: gitConfigSchema,
})

export type LocalConfig = z.infer<typeof localConfigSchema>

// ── Deployment mode ──────────────────────────────────────────────────────────

export type DeploymentMode = 'hybrid' | 'local' | 'legacy'

/**
 * Determine deployment mode from config:
 * - hybrid: cloud URL + token present → runner connects to cloud
 * - local: no cloud config → SQLite + polling (Phase 5)
 * - legacy: env vars for Redis/settings.json present → monolith mode
 */
export function detectMode(config: LocalConfig | null): DeploymentMode {
  // If no local config exists but REDIS_URL or SETTINGS_PATH is set, we're legacy
  if (!config) {
    if (process.env.REDIS_URL || process.env.SETTINGS_PATH) return 'legacy'
    return 'local'
  }

  if (config.cloud?.url && config.cloud?.token) return 'hybrid'
  return 'local'
}

// ── Default paths ────────────────────────────────────────────────────────────

export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.coro')
}

export function defaultConfigPath(): string {
  return path.join(defaultConfigDir(), 'config.json')
}

export function defaultIntelligenceDir(): string {
  return path.join(defaultConfigDir(), 'intelligence')
}

export function defaultWorkingDir(): string {
  return path.join(defaultConfigDir(), 'working')
}

// ── Read / Write ─────────────────────────────────────────────────────────────

/**
 * Load config from the given path (default: ~/.coro/config.json).
 * Returns null if the file doesn't exist. Throws on invalid content.
 */
export function loadLocalConfig(configPath?: string): LocalConfig | null {
  const p = configPath ?? defaultConfigPath()
  if (!fs.existsSync(p)) return null

  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return localConfigSchema.parse(raw)
}

/**
 * Write config atomically. Creates parent directories if needed.
 */
export function saveLocalConfig(config: LocalConfig, configPath?: string): void {
  const p = configPath ?? defaultConfigPath()
  const dir = path.dirname(p)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Merge partial config into existing. Useful for `coro login` which only sets cloud fields.
 */
export function mergeLocalConfig(patch: Partial<LocalConfig>, configPath?: string): LocalConfig {
  // Fallback seeds `method: 'apiKey'` so the zod refine doesn't reject the
  // intermediate value; callers are expected to patch in the real credentials.
  const existing: LocalConfig =
    loadLocalConfig(configPath) ?? { anthropic: { method: 'apiKey', apiKey: '__placeholder__' } }
  const merged: LocalConfig = {
    ...existing,
    ...patch,
    // Deep merge sub-objects
    cloud: patch.cloud !== undefined ? patch.cloud : existing.cloud,
    anthropic: patch.anthropic ?? existing.anthropic,
    intelligence: patch.intelligence !== undefined ? patch.intelligence : existing.intelligence,
    paths: patch.paths !== undefined ? patch.paths : existing.paths,
    git: patch.git !== undefined ? patch.git : existing.git,
  }
  saveLocalConfig(merged, configPath)
  return merged
}

/**
 * Resolve the effective intelligence directory. Falls back to the default.
 */
export function resolveIntelligenceDir(config: LocalConfig | null): string {
  return config?.intelligence?.dir?.replace('~', os.homedir()) ?? defaultIntelligenceDir()
}

/**
 * Resolve the effective working directory. Falls back to the default.
 */
export function resolveWorkingDir(config: LocalConfig | null): string {
  return config?.paths?.workingDir?.replace('~', os.homedir()) ?? defaultWorkingDir()
}
