import type { ClaudeAuthConfig } from './types'

/**
 * Build the subset of env vars Claude Code uses for authentication. Returns
 * both keys, with the unused one set to `undefined` so it is stripped from the
 * final env map (Node spawn treats `undefined` as "don't pass this key").
 * The `claudeLogin` mode deliberately passes neither variable so the CLI can
 * use its own persisted session and refresh flow.
 */
export function buildAnthropicAuthEnv(auth: ClaudeAuthConfig): Record<string, string | undefined> {
  if (auth.method === 'claudeLogin') {
    return {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    }
  }
  if (auth.method === 'oauth') {
    return {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: auth.oauthToken ?? '',
    }
  }
  return {
    ANTHROPIC_API_KEY: auth.apiKey ?? '',
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  }
}
