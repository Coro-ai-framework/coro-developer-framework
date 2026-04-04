import { describe, it, expect } from 'vitest'
import { createA5McpServer } from '../../src/mcp-server'
import { makeMockToolContext } from './fixtures'

describe('createA5McpServer', () => {
  it('returns an SDK MCP server config with a live instance', () => {
    const ctx = makeMockToolContext()
    const config = createA5McpServer(ctx, {})

    expect(config).toBeDefined()
    expect(config).toMatchObject({ name: 'a5' })
    expect('instance' in config && config.instance).toBeDefined()
  })
})
