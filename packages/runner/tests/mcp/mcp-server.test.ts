import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createCoroMcpServer, jsonArg } from '../../src/mcp-server'
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

describe('jsonArg', () => {
  // Some executors defer this tool's schema; when they do, the model
  // sends array/object arguments as JSON strings instead of the native
  // shape. Without jsonArg, zod rejects them with "expected array,
  // received string" and the agent's only recovery is to reload the
  // schema via ToolSearch.

  it('coerces a JSON-encoded array string to match set_work_items\' schema', () => {
    const schema = z.object({ workItems: jsonArg(z.array(z.string())) })
    const result = schema.parse({ workItems: '["a","b"]' })
    expect(result.workItems).toEqual(['a', 'b'])
  })

  it('still rejects a string that is not valid JSON', () => {
    const schema = z.object({ workItems: jsonArg(z.array(z.string())) })
    expect(() => schema.parse({ workItems: 'not json' })).toThrow()
  })

  it('still rejects a JSON string that parses to the wrong shape', () => {
    const schema = z.object({ workItems: jsonArg(z.array(z.string())) })
    expect(() => schema.parse({ workItems: '{"a":1}' })).toThrow()
  })

  it('passes a native array through unchanged (the happy path is untouched)', () => {
    const schema = z.object({ workItems: jsonArg(z.array(z.string())) })
    const result = schema.parse({ workItems: ['a', 'b'] })
    expect(result.workItems).toEqual(['a', 'b'])
  })

  it('coerces a JSON-encoded object string, matching set_job_params\' record schema', () => {
    const schema = z.object({ params: jsonArg(z.record(z.string(), z.unknown())) })
    const result = schema.parse({ params: '{"language":"go"}' })
    expect(result.params).toEqual({ language: 'go' })
  })

  it('coerces a JSON-encoded plain object string, matching upstream_search\'s finding schema', () => {
    const schema = z.object({
      finding: jsonArg(z.object({ category: z.string(), title: z.string() })).optional(),
    })
    const result = schema.parse({ finding: '{"category":"runner-code","title":"x"}' })
    expect(result.finding).toEqual({ category: 'runner-code', title: 'x' })
  })

  it('coerces a JSON-encoded array-of-objects string, matching propose_change\'s entries schema', () => {
    const schema = z.object({
      entries: jsonArg(z.array(z.object({ file: z.string(), kind: z.enum(['pitfall', 'pattern']) }))),
    })
    const result = schema.parse({ entries: '[{"file":"known-pitfalls.md","kind":"pitfall"}]' })
    expect(result.entries).toEqual([{ file: 'known-pitfalls.md', kind: 'pitfall' }])
  })

  it('does not touch a plain string field (only array/object/record params are wrapped)', () => {
    const schema = z.object({ name: z.string() })
    expect(() => schema.parse({ name: '["a"]' })).not.toThrow()
    expect(schema.parse({ name: '["a"]' }).name).toBe('["a"]')
  })
})
