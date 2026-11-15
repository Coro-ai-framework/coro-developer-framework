import { describe, it, expect } from 'vitest'
import { promptCacheTtlEnv } from '../src/prompt-cache'

describe('promptCacheTtlEnv', () => {
  it('forces 5-minute cache writes when the operator has not chosen a TTL', () => {
    expect(promptCacheTtlEnv({ PATH: '/usr/bin' })).toEqual({ FORCE_PROMPT_CACHING_5M: '1' })
  })

  it.each([
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', '1h'],
    ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h'],
    ['ENABLE_PROMPT_CACHING_1H', '1'],
    ['FORCE_PROMPT_CACHING_5M', '0'],
  ])('leaves the CLI default alone when %s is set', (name, value) => {
    expect(promptCacheTtlEnv({ [name]: value })).toEqual({})
  })

  it('treats an empty operator variable as unset', () => {
    expect(promptCacheTtlEnv({ ENABLE_PROMPT_CACHING_1H: '' })).toEqual({ FORCE_PROMPT_CACHING_5M: '1' })
  })
})
