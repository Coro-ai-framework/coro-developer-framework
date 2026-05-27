// ── Settings (in-memory shape) ────────────────────────────────────────────────
//
// `Settings` is the in-memory configuration the runner hands to clients
// (BitBucket, GitHub, Loki, …) and the job runner. It is *constructed*, not
// loaded from disk — `src/runner/index.ts::buildSettingsFromLocal` synthesises
// it from `LocalConfig` (which lives at `~/.coro/config.json`).
//
// The legacy file-based loader (`config/settings.json` + `loadSettings()`) was
// removed when the legacy Redis monolith was deleted. Anything that needs a
// configurable value should read it from `LocalConfig` and surface it through
// the dashboard's settings page.

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
  bitbucket: {
    workspace: string
    baseUrl: string
    coderAccount: BitBucketAccountConfig
    reviewerAccount: BitBucketAccountConfig
  }
  github: GitHubConfig
  redis: {
    /** Retained as an empty string; populated only when a future cloud worker needs it. */
    url: string
  }
  paths: {
    workingDir: string
    /**
     * Active intelligence dir for the running process. The intelligence
     * resolver materialises a per-job overlay directory and rewrites this
     * per-job, leaving the process-wide default untouched.
     */
    coroIntelligenceDir: string
    /**
     * Absolute on-disk path of the base intelligence layer that ships
     * with the runner (`@coro-ai/intelligence-base/layer`). Always present;
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
  ngrok: {
    authToken: string
    staticDomain: string
  }
  /**
   * Self-improvement proposal flow. Mirrors the `proposals` block in
   * `LocalConfig`; the runner copies it into Settings at bootstrap so
   * tools/handlers can read a single shape regardless of deployment
   * mode.
   */
  proposals: {
    routing: {
      /**
       * `path`  — path prefix decides the target layer
       *           (`.coro/...` → repo, otherwise → tenant). Deterministic.
       * `agent` — agents pass an explicit `targetLayer`; the tool only
       *           checks consistency. Reserved for future use.
       */
      strategy: 'path' | 'agent'
    }
  }
  /**
   * Multi-provider LLM configuration. The runtime treats this as the
   * single source of truth for executor selection and alias resolution.
   *
   * Provider configs are intentionally typed as `unknown` here — each
   * provider plugin owns its own zod schema and validates at registry
   * registration time.
   */
  llm?: {
    /**
     * Default executor plugin id when an alias or phase doesn't pin
     * one explicitly. When unset and only one executor plugin is
     * installed, the registry picks it; with multiple, the registry
     * throws unless every consumer is explicit.
     */
    defaultProvider?: string
    /**
     * Per-plugin-id config blob. Forwarded verbatim to the plugin's
     * `init()` at bootstrap.
     */
    providers?: Record<string, unknown>
    /**
     * Workflow-author-friendly aliases. Workflows reference
     * `model: 'planning'` or `model: 'coding'` (or any other key); the
     * runner resolves each alias to a concrete `{provider, model}`
     * pair via this map.
     */
    aliases?: Record<string, {
      provider: string
      model: string
      /** OpenAI o-series / Anthropic extended-thinking effort hint. */
      reasoningEffort?: 'low' | 'medium' | 'high'
    }>
  }
  /**
   * Coro plan mode preferences surfaced through Settings.
   */
  intake?: {
    /** When false, plan mode runs without read-only tracker/SCM tools. Default true. */
    toolsEnabled?: boolean
  }
}
