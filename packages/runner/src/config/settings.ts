import fs from 'fs'
import path from 'path'

import { getBaseLayerRoot } from '@coro/intelligence-base'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle'
}

export interface ClaudeAuthConfig {
  method: 'apiKey' | 'oauth' | 'claudeLogin'
  apiKey?: string
  oauthToken?: string
  account?: ClaudeAccountInfo
}

export interface BitBucketAccountConfig {
  username: string
  appPassword: string
}

export interface GitHubConfig {
  owner: string
  token: string
  baseUrl: string
}

export interface Settings {
  host: {
    port: number
    webhookSecret: string
    logLevel: string
  }
  claude: {
    /**
     * Runtime-selected Anthropic auth. The runner maps this to exactly one of
     * ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN when needed. The claudeLogin
     * mode intentionally passes neither env var so Claude Code can use its own
     * persisted login session and refresh handling.
     */
    auth: ClaudeAuthConfig
    planningModel: string
    codingModel: string
  }
  bitbucket: {
    workspace: string
    baseUrl: string
    coderAccount: BitBucketAccountConfig
    reviewerAccount: BitBucketAccountConfig
  }
  github: GitHubConfig
  redis: {
    url: string
  }
  paths: {
    workingDir: string
    /**
     * Active intelligence dir for the running process. Currently the
     * repository root (legacy behaviour). The intelligence resolver
     * (introduced in a later phase) will materialise a per-job overlay
     * directory and rewrite this per job, leaving the process-wide
     * default untouched.
     */
    coroIntelligenceDir: string
    /**
     * Absolute on-disk path of the base intelligence layer that ships
     * with the runner (`@coro/intelligence-base/layer`). Always present;
     * used as the foundation of the layered intelligence stack
     * (base → tenant → repo).
     */
    baseLayerDir: string
  }
  loki: {
    baseUrl: string
    apiKey: string
    username: string
  }
  tempo: {
    baseUrl: string
    apiKey: string
  }
  jira: {
    baseUrl: string
    username: string
    apiToken: string
    pollIntervalSeconds: number
  }
  ngrok: {
    authToken: string
    staticDomain: string
  }
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads settings from config/settings.json (relative to the project root),
 * then overlays values from environment variables.
 *
 * Environment variables always win over the JSON file.
 * Required fields throw at startup if missing from both sources.
 */
export function loadSettings(): Settings {
  const settingsPath = path.resolve(process.cwd(), 'config', 'settings.json')

  if (!fs.existsSync(settingsPath)) {
    throw new Error(
      `Settings file not found at ${settingsPath}.\n` +
      `Copy config/settings.example.json to config/settings.json and fill in your values.`
    )
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8')
  const file = JSON.parse(raw) as Settings

  // ── Environment variable overrides ──────────────────────────────────────
  // Each env var is checked explicitly so the override mapping is transparent.

  const settings: Settings = {
    host: {
      port: num(env('PORT'), file.host?.port, 3000),
      webhookSecret: env('BITBUCKET_WEBHOOK_SECRET') ?? file.host?.webhookSecret ?? '',
      logLevel: env('LOG_LEVEL') ?? file.host?.logLevel ?? 'info',
    },
    claude: {
      auth: resolveClaudeAuth(file),
      planningModel: env('CLAUDE_PLANNING_MODEL') ?? file.claude?.planningModel ?? 'claude-opus-4-6',
      codingModel: env('CLAUDE_CODING_MODEL') ?? file.claude?.codingModel ?? 'claude-sonnet-4-6',
    },
    bitbucket: {
      workspace: env('BITBUCKET_WORKSPACE') ?? file.bitbucket?.workspace ?? '',
      baseUrl: env('BITBUCKET_BASE_URL') ?? file.bitbucket?.baseUrl ?? 'https://api.bitbucket.org/2.0',
      coderAccount: {
        username: env('BITBUCKET_CODER_USERNAME') ?? file.bitbucket?.coderAccount?.username ?? '',
        appPassword: env('BITBUCKET_CODER_APP_PASSWORD') ?? file.bitbucket?.coderAccount?.appPassword ?? '',
      },
      reviewerAccount: {
        username: env('BITBUCKET_REVIEWER_USERNAME') ?? file.bitbucket?.reviewerAccount?.username ?? '',
        appPassword: env('BITBUCKET_REVIEWER_APP_PASSWORD') ?? file.bitbucket?.reviewerAccount?.appPassword ?? '',
      },
    },
    github: {
      owner: env('GITHUB_OWNER') ?? file.github?.owner ?? '',
      token: env('GITHUB_TOKEN') ?? file.github?.token ?? '',
      baseUrl: env('GITHUB_API_BASE_URL') ?? file.github?.baseUrl ?? 'https://api.github.com',
    },
    redis: {
      url: env('REDIS_URL') ?? file.redis?.url ?? 'redis://localhost:6379',
    },
    paths: {
      workingDir: resolveWorkingDir(env('WORKING_DIR'), file.paths?.workingDir),
      coroIntelligenceDir: resolveCoroIntelligenceDir(
        env('CORO_INTELLIGENCE_DIR'),
        file.paths?.coroIntelligenceDir,
      ),
      baseLayerDir: getBaseLayerRoot(),
    },
    loki: {
      baseUrl: env('LOKI_BASE_URL') ?? file.loki?.baseUrl ?? '',
      apiKey: env('LOKI_API_KEY') ?? file.loki?.apiKey ?? '',
      username: env('LOKI_USERNAME') ?? file.loki?.username ?? '',
    },
    tempo: {
      baseUrl: env('TEMPO_BASE_URL') ?? file.tempo?.baseUrl ?? '',
      apiKey: env('TEMPO_API_KEY') ?? file.tempo?.apiKey ?? '',
    },
    jira: {
      baseUrl: env('JIRA_BASE_URL') ?? file.jira?.baseUrl ?? '',
      username: env('JIRA_USERNAME') ?? file.jira?.username ?? '',
      apiToken: env('JIRA_API_TOKEN') ?? file.jira?.apiToken ?? '',
      pollIntervalSeconds: num(env('JIRA_POLL_INTERVAL_SECONDS'), file.jira?.pollIntervalSeconds, 60),
    },
    ngrok: {
      authToken: env('NGROK_AUTHTOKEN') ?? file.ngrok?.authToken ?? '',
      staticDomain: env('NGROK_STATIC_DOMAIN') ?? file.ngrok?.staticDomain ?? '',
    },
  }

  validate(settings)
  return settings
}

// ── Validation ───────────────────────────────────────────────────────────────

function validate(s: Settings): void {
  const missing: string[] = []

  if (!hasClaudeCredential(s.claude.auth)) {
    missing.push(
      'Anthropic credentials: set ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ' +
      'or claude.auth in settings.json (apiKey, oauth, or claudeLogin)',
    )
  }
  if (!s.redis.url) missing.push('REDIS_URL (or redis.url in settings.json)')

  // At least one git provider must be configured
  const hasBitbucket = !!s.bitbucket.coderAccount.appPassword
  const hasGithub = !!s.github.token

  if (!hasBitbucket && !hasGithub) {
    missing.push('At least one git provider must be configured: BITBUCKET_CODER_APP_PASSWORD or GITHUB_TOKEN')
  }

  // If BitBucket is configured, require workspace + both accounts
  if (hasBitbucket) {
    if (!s.bitbucket.workspace) missing.push('BITBUCKET_WORKSPACE (or bitbucket.workspace in settings.json)')
    if (!s.bitbucket.reviewerAccount.appPassword) missing.push('BITBUCKET_REVIEWER_APP_PASSWORD (or bitbucket.reviewerAccount.appPassword in settings.json)')
  }

  // If GitHub is configured, require owner
  if (hasGithub) {
    if (!s.github.owner) missing.push('GITHUB_OWNER (or github.owner in settings.json)')
  }

  if (missing.length > 0) {
    throw new Error(
      `Agent Host cannot start — missing required configuration:\n` +
      missing.map(m => `  • ${m}`).join('\n') + '\n\n' +
      `Fill in config/settings.json or set the corresponding environment variables.`
    )
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function env(key: string): string | undefined {
  const v = process.env[key]
  return v !== undefined && v !== '' ? v : undefined
}

/**
 * Resolve Claude auth from env vars and settings.json with this precedence:
 *   1. ANTHROPIC_API_KEY env → apiKey method
 *   2. CLAUDE_CODE_OAUTH_TOKEN env → oauth method
 *   3. settings.json `claude.auth` object (new shape)
 *   4. settings.json `claude.apiKey` string (legacy shape)
 * Returns an empty apiKey-method object when nothing is configured so the
 * validator can produce a friendly error.
 */
function resolveClaudeAuth(file: Settings): Settings['claude']['auth'] {
  const envKey = env('ANTHROPIC_API_KEY')
  if (envKey) return { method: 'apiKey', apiKey: envKey }

  const envOauth = env('CLAUDE_CODE_OAUTH_TOKEN')
  if (envOauth) return { method: 'oauth', oauthToken: envOauth }

  const fileAuth = (file.claude as Partial<Settings['claude']> | undefined)?.auth
  if (fileAuth?.method === 'claudeLogin') {
    return { method: 'claudeLogin', account: fileAuth.account }
  }
  if (fileAuth?.method === 'oauth' && fileAuth.oauthToken) {
    return { method: 'oauth', oauthToken: fileAuth.oauthToken }
  }
  if (fileAuth?.method === 'apiKey' && fileAuth.apiKey) {
    return { method: 'apiKey', apiKey: fileAuth.apiKey }
  }

  // Legacy shape: settings.json used to carry `claude.apiKey` directly.
  const legacy = (file.claude as { apiKey?: string } | undefined)?.apiKey
  if (legacy) return { method: 'apiKey', apiKey: legacy }

  return { method: 'apiKey', apiKey: '' }
}

function hasClaudeCredential(auth: Settings['claude']['auth']): boolean {
  if (auth.method === 'claudeLogin') return true
  if (auth.method === 'apiKey') return !!auth.apiKey
  return !!auth.oauthToken
}

function num(envVal: string | undefined, fileVal: number | undefined, defaultVal: number): number {
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10)
    if (!isNaN(parsed)) return parsed
  }
  return fileVal ?? defaultVal
}

/** Docker-compose uses /data/...; on a dev machine that path is usually missing or unwritable. */
const DOCKER_WORKING = '/data/working'
const DOCKER_INTELLIGENCE = '/data/coro-intelligence'

function resolveWorkingDir(envOverride: string | undefined, fromFile: string | undefined): string {
  if (envOverride) return path.resolve(envOverride)
  const raw = fromFile ?? DOCKER_WORKING
  if (raw === DOCKER_WORKING && !fs.existsSync('/data')) {
    return path.join(process.cwd(), '.working')
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}

function resolveCoroIntelligenceDir(
  envOverride: string | undefined,
  fromFile: string | undefined,
): string {
  if (envOverride) return path.resolve(envOverride)
  const raw = fromFile ?? DOCKER_INTELLIGENCE
  if (raw === DOCKER_INTELLIGENCE && !fs.existsSync('/data')) {
    return path.resolve(process.cwd(), '..')
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}
