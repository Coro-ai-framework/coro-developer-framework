import { describe, it, expect } from 'vitest'
import { createCoroMcpServer } from '../../src/mcp-server'
import { makeMockToolContext } from './fixtures'

describe('createCoroMcpServer', () => {
  it('returns an SDK MCP server config with a live instance', () => {
    const ctx = makeMockToolContext()
    const config = createCoroMcpServer(ctx, {})

    expect(config).toBeDefined()
    expect(config).toMatchObject({ name: 'coro' })
    expect('instance' in config && config.instance).toBeDefined()
  })
})
