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
  claude: {
    /**
     * Runtime-selected Anthropic auth. The runner maps this to exactly one of
     * `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` when needed. The
     * `claudeLogin` mode intentionally passes neither env var so Claude Code
     * can use its own persisted login session and refresh handling.
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
  /**
   * Issue tracker selection for the campaign workflow. Optional — when
   * absent the tracker factory infers Jira if `jira.baseUrl` is set,
   * otherwise the campaign-planner runs in tracker-less mode (it can
   * still register children without a tracker round-trip).
   */
  tracker?: {
    provider: 'jira' | 'github' | 'linear' | 'none'
  }
  /**
   * Linear API credentials. Linear uses a single personal API key (no
   * username) issued from the user's settings page; the key is sent
   * verbatim in the `Authorization` header. Optional — present only
   * when the tenant has chosen Linear as its tracker.
   */
  linear?: {
    apiKey: string
    /** Linear team key (e.g. "ENG") used as the default `projectKey` for new issues. */
    teamKey?: string
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
}
