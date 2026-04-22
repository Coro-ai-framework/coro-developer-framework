import { describe, it, expect } from 'vitest'
import { buildAnthropicAuthEnv } from '../../src/jobs/runner'

// The Claude Code CLI silently prefers ANTHROPIC_API_KEY when both env vars
// are present, so `buildAnthropicAuthEnv` must blank the unused key (not just
// skip it). These tests pin that contract.
describe('buildAnthropicAuthEnv', () => {
  it('sets ANTHROPIC_API_KEY and clears CLAUDE_CODE_OAUTH_TOKEN when method=apiKey', () => {
    const env = buildAnthropicAuthEnv({ method: 'apiKey', apiKey: 'sk-ant-123' })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-123')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('sets CLAUDE_CODE_OAUTH_TOKEN and clears ANTHROPIC_API_KEY when method=oauth', () => {
    const env = buildAnthropicAuthEnv({ method: 'oauth', oauthToken: 'sk-ant-oat01-xyz' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-xyz')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('defaults to empty string for missing apiKey so the CLI can report a clear auth error', () => {
    const env = buildAnthropicAuthEnv({ method: 'apiKey' })
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('defaults to empty string for missing oauthToken so the CLI can report a clear auth error', () => {
    const env = buildAnthropicAuthEnv({ method: 'oauth' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
