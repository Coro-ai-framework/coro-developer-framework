import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildCoroMcpTools, createCoroMcpServer, jsonArg } from '../../src/mcp-server'
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

// ── Real-wiring coverage ─────────────────────────────────────────────────────
//
// The `jsonArg` unit tests above exercise the helper against look-alike
// schemas built for the test — they'd stay green even if a production
// tool's wrapper were accidentally removed. These tests instead pull the
// actual tool definitions `createCoroMcpServer` registers and exercise the
// registered schema and handler directly, so removing a wrapper (or
// leaving one off a new array/object/record param) fails here.

/** Zod v4 def-shape helpers — no schema in this file is a class instance
 * we can `instanceof` cheaply, so we walk `._zod.def` directly. */
function coreDef(schema: z.ZodTypeAny): { type: string; innerType?: z.ZodTypeAny; in?: { def?: { type?: string } }; out?: { def?: { type?: string } } } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let def = (schema as any)._zod.def
  while (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def = (def.innerType as any)._zod.def
  }
  return def
}

function isJsonArgWrapped(schema: z.ZodTypeAny): boolean {
  const def = coreDef(schema)
  return def.type === 'pipe'
    && def.in?.def?.type === 'transform'
    && ['array', 'object', 'record'].includes(def.out?.def?.type ?? '')
}

describe('buildCoroMcpTools wiring', () => {
  const ctx = makeMockToolContext()
  const tools = buildCoroMcpTools(ctx, {}, { registerFileTools: true, registerRunSubagent: true })

  it('every top-level array/object/record tool parameter is jsonArg-wrapped', () => {
    const unwrapped: string[] = []
    for (const t of tools) {
      for (const [param, schema] of Object.entries(t.inputSchema)) {
        const def = coreDef(schema as z.ZodTypeAny)
        if (['array', 'object', 'record'].includes(def.type) || def.type === 'pipe') {
          if (!isJsonArgWrapped(schema as z.ZodTypeAny)) unwrapped.push(`${t.name}.${param}`)
        }
      }
    }
    // Removing any production `jsonArg(...)` call turns this list non-empty.
    expect(unwrapped).toEqual([])
  })

  it('registers set_work_items and coerces a JSON-encoded array string end to end', async () => {
    const setWorkItems = tools.find(t => t.name === 'set_work_items')
    expect(setWorkItems).toBeDefined()

    const schema = z.object(setWorkItems!.inputSchema)
    const parsed = schema.parse({ workItems: '["a","b"]' })
    await setWorkItems!.handler(parsed, undefined)

    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith(
      ctx.job.id,
      { workItems: [
        { name: 'a', status: 'pending', loopCount: 0 },
        { name: 'b', status: 'pending', loopCount: 0 },
      ] },
    )
  })

  it('set_work_items\' registered schema still rejects invalid JSON', () => {
    const setWorkItems = tools.find(t => t.name === 'set_work_items')!
    const schema = z.object(setWorkItems.inputSchema)
    expect(() => schema.parse({ workItems: 'not json' })).toThrow()
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
