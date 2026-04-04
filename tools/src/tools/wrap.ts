import { ToolContext, ToolResult } from './types'

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

/**
 * Wrap a typed tool implementation so it:
 *   - Catches any thrown error and returns { success: false, error }
 *   - Wraps the return value in { success: true, output }
 *
 * Tool functions no longer need their own try/catch — they just return
 * the output value or throw on error, and `wrap` handles the rest.
 */
export function wrap<T>(fn: (input: T, ctx: ToolContext) => Promise<unknown>): ToolHandler {
  return async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const output = await fn(input as T, ctx)
      return { success: true, output: output ?? null }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
}
