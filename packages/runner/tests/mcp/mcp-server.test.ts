import { describe, it, expect } from 'vitest'
import { createCoroMcpServer } from '../../src/mcp-server'
import { JobType } from '@coro-ai/cloud-protocol'
import { makeMockJob, makeMockToolContext } from './fixtures'

describe('createCoroMcpServer', () => {
  it('returns an SDK MCP server config with a live instance', () => {
    const ctx = makeMockToolContext()
    const config = createCoroMcpServer(ctx, {})

    expect(config).toBeDefined()
    expect(config).toMatchObject({ name: 'coro' })
    expect('instance' in config && config.instance).toBeDefined()
  })

  describe('code_review_lenses registration', () => {
    const toolNames = (config: ReturnType<typeof createCoroMcpServer>): string[] => {
      const instance = (config as unknown as { instance: { _registeredTools?: Record<string, unknown> } }).instance
      return Object.keys(instance._registeredTools ?? {})
    }

    it('is registered only when the phase declares lenses', () => {
      const ctx = makeMockToolContext()
      expect(toolNames(createCoroMcpServer(ctx, {}))).not.toContain('code_review_lenses')
      expect(toolNames(createCoroMcpServer(ctx, {}, { registerCodeReview: true }))).toContain('code_review_lenses')
    })

    it('is never registered on a pr-review job', () => {
      const ctx = makeMockToolContext({ job: makeMockJob({ type: JobType.PrReview }) })
      expect(toolNames(createCoroMcpServer(ctx, {}, { registerCodeReview: true }))).not.toContain('code_review_lenses')
    })
  })
})
