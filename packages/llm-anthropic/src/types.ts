/**
 * Public types this package contributes to the wider runner. The runner's
 * `Settings` shape re-exports {@link ClaudeAccountInfo} and
 * {@link ClaudeAuthConfig} from here so the host configuration mirror and
 * the executor stay in lock-step on auth shape.
 */

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

/**
 * Minimal slice of the runner's `Settings` the AnthropicExecutor reads at
 * runtime. Declared structurally so the runner can pass its full `Settings`
 * without an explicit cast — the field set is intentionally narrow so this
 * package never grows a dependency on the runner's other transports.
 */
export interface AnthropicExecutorSettings {
  claude: {
    auth: ClaudeAuthConfig
  }
  bitbucket: {
    workspace: string
    coderAccount: {
      username: string
      appPassword: string
    }
  }
  github?: {
    owner: string
    token: string
  }
}
