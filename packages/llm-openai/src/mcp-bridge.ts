import { z } from 'zod'
import {
  enforceAllowedTools,
  enforceWriteGuard,
  formatToolCallLogLine,
} from '@coro/plugin-sdk'
import type {
  HookPolicy,
  McpServerDescriptor,
  PhaseExecutorEvent,
  PluginMcpServerConfig,
} from '@coro/plugin-sdk'
import {
  connectExternalMcpServer,
  type ExternalMcpClientConnection,
} from './mcp-external-client'
import type { ExternalMcpConnectionPool } from './mcp-pool'

export interface OpenAiFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: boolean
}

export interface OpenAiToolCall {
  callId: string
  name: string
  argumentsJson: string
}

export interface OpenAiFunctionOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

interface RegisteredTool {
  description?: string
  inputSchema?: Record<string, unknown>
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
  enabled?: boolean
}

interface SdkServerInstance {
  _registeredTools?: Record<string, RegisteredTool>
}

type ToolBinding =
  | {
      kind: 'sdk'
      openAiName: string
      serverId: string
      toolName: string
      description?: string
      inputSchema?: Record<string, unknown>
      handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>
    }
  | {
      kind: 'external'
      openAiName: string
      serverId: string
      toolName: string
      description?: string
      inputSchema?: Record<string, unknown>
      connection: ExternalMcpClientConnection
    }

export interface McpBridgeOptions {
  coroServer: McpServerDescriptor
  pluginServers: Record<string, PluginMcpServerConfig>
  hookPolicy: HookPolicy
  cwd: string
  phase?: string
  signal?: AbortSignal
  /**
   * Optional shared pool of external MCP connections. When provided,
   * external stdio/sse/http servers are acquired from the pool
   * (keyed by {@link externalScopeKey} + serverId) instead of
   * being spawned fresh for every bridge. The pool keeps connections
   * alive across phases and subagent invocations within the same job
   * to avoid the FastMCP / GitHub-MCP respawn storm.
   */
  externalPool?: ExternalMcpConnectionPool
  /** Required when {@link externalPool} is set. Typically the job working dir. */
  externalScopeKey?: string
}

export interface ExternalMcpFailure {
  serverId: string
  reason: string
}

export class McpFunctionBridge {
  private readonly bindings = new Map<string, ToolBinding>()
  private readonly externalConnections: ExternalMcpClientConnection[] = []
  /** Server IDs we acquired from the pool (vs. spawned standalone). */
  private readonly pooledServerIds: string[] = []
  readonly externalFailures: ExternalMcpFailure[] = []

  constructor(private readonly opts: McpBridgeOptions) {
    this.addSdkServer('coro', this.opts.coroServer.instance)
  }

  /**
   * Connect to every plugin-declared external MCP server (stdio /
   * sse / http) and register their tools. Failures are collected in
   * {@link externalFailures} so the executor can warn the agent
   * without aborting the phase.
   */
  async init(): Promise<void> {
    const entries = Object.entries(this.opts.pluginServers)
    if (entries.length === 0) return
    const pool = this.opts.externalPool
    const scopeKey = this.opts.externalScopeKey
    await Promise.all(
      entries.map(async ([serverId, config]) => {
        try {
          const connection = pool && scopeKey
            ? await pool.acquire(scopeKey, serverId, config)
            : await connectExternalMcpServer(serverId, config)
          if (pool && scopeKey) {
            this.pooledServerIds.push(serverId)
          } else {
            this.externalConnections.push(connection)
          }
          for (const tool of connection.tools) {
            const openAiName = `mcp__${serverId}__${tool.name}`
            this.bindings.set(openAiName, {
              kind: 'external',
              openAiName,
              serverId,
              toolName: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              connection,
            })
          }
        } catch (err) {
          this.externalFailures.push({
            serverId,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }),
    )
  }

  /** Terminate all spawned MCP child processes / network clients. */
  async dispose(): Promise<void> {
    // Standalone (non-pooled) connections: close immediately.
    await Promise.all(
      this.externalConnections.map(async c => {
        try {
          await c.close()
        } catch {
          // best-effort
        }
      }),
    )
    this.externalConnections.length = 0
    // Pooled connections: just release; the pool decides when to close.
    const pool = this.opts.externalPool
    const scopeKey = this.opts.externalScopeKey
    if (pool && scopeKey) {
      for (const serverId of this.pooledServerIds) pool.release(scopeKey, serverId)
    }
    this.pooledServerIds.length = 0
  }

  listTools(): OpenAiFunctionTool[] {
    return Array.from(this.bindings.values()).map(binding => ({
      type: 'function' as const,
      name: binding.openAiName,
      description: this.describeTool(binding),
      parameters: toJsonSchema(binding.inputSchema ?? {}),
      // Strict mode (constrained decoding) was tried but caused the
      // model to emit `{}` arguments for tools whose Zod schemas use
      // `z.record(..., z.unknown())`, `.optional()`, or `z.union(...)`
      // — these don't satisfy OpenAI's strict requirements (every
      // property required, additionalProperties:false on every nested
      // object, no permissive "any" types) and constrained decoding
      // collapses to the empty object. Defensive validation in the
      // tool handler (see tools/run-subagent.ts) is the primary
      // safety net instead.
      strict: false,
    }))
  }

  hasTool(name: string): boolean {
    return this.bindings.has(name)
  }

  async call(call: OpenAiToolCall): Promise<{ item: OpenAiFunctionOutputItem; events: PhaseExecutorEvent[] }> {
    const binding = this.bindings.get(call.name)
    if (!binding) {
      const output = `Tool ${call.name} is not registered.`
      return {
        item: { type: 'function_call_output', call_id: call.callId, output },
        events: [
          { type: 'tool_result', toolName: call.name, output, isError: true },
        ],
      }
    }

    const input = parseArguments(call.argumentsJson)

    // ── Schema validation (SDK tools only) ────────────────────────────────
    //
    // The MCP SDK's CallTool dispatcher Zod-validates inputs before
    // calling a tool's handler. Our bridge calls handlers directly
    // (via `_registeredTools[name].handler`) and therefore bypasses
    // that validation entirely. Without this guard, the model can
    // call e.g. `escalate({message: "..."})` instead of
    // `escalate({reason: "..."})` and the handler runs with
    // `reason: undefined`, silently writing an empty escalation
    // message to the job. We mirror the SDK's pre-handler validation
    // here so wrong shapes turn into informative tool errors the
    // model can recover from.
    //
    // External MCP servers do their own server-side validation, so we
    // skip them.
    if (binding.kind === 'sdk' && binding.inputSchema) {
      const validation = validateInputAgainstZodShape(binding.inputSchema, input)
      if (!validation.ok) {
        const output =
          `Invalid arguments for ${binding.openAiName}. ${validation.message} ` +
          `Accepted fields: ${describeShape(binding.inputSchema)}.`
        return {
          item: { type: 'function_call_output', call_id: call.callId, output },
          events: [
            { type: 'tool_result', toolName: binding.openAiName, output, isError: true },
          ],
        }
      }
    }

    const policy = await this.enforcePolicy(binding.openAiName, binding.toolName, input)
    if (!policy.allow) {
      const output = policy.reason ?? `Tool ${binding.openAiName} was blocked by policy.`
      return {
        item: { type: 'function_call_output', call_id: call.callId, output },
        events: [
          { type: 'tool_result', toolName: binding.openAiName, output, isError: true },
        ],
      }
    }

    const events: PhaseExecutorEvent[] = [
      {
        type: 'tool_call',
        toolName: binding.openAiName,
        input,
        isMcp: true,
      },
      {
        type: 'log',
        level: 'info',
        message: formatToolCallLogLine({ toolName: binding.openAiName, input }),
      },
    ]

    try {
      const result = binding.kind === 'sdk'
        ? await binding.handler(input, { signal: this.opts.signal })
        : await binding.connection.client.callTool({
            name: binding.toolName,
            arguments: input,
          })
      const output = stringifyMcpResult(result)
      events.push({ type: 'tool_result', toolName: binding.openAiName, output })
      return {
        item: { type: 'function_call_output', call_id: call.callId, output },
        events,
      }
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err)
      events.push({ type: 'tool_result', toolName: binding.openAiName, output, isError: true })
      return {
        item: { type: 'function_call_output', call_id: call.callId, output },
        events,
      }
    }
  }

  private addSdkServer(serverId: string, raw: unknown): void {
    const instance = unwrapSdkInstance(raw)
    if (!instance?._registeredTools) return
    for (const [toolName, definition] of Object.entries(instance._registeredTools)) {
      if (definition.enabled === false) continue
      const openAiName = `mcp__${serverId}__${toolName}`
      this.bindings.set(openAiName, {
        kind: 'sdk',
        openAiName,
        serverId,
        toolName,
        description: definition.description,
        inputSchema: definition.inputSchema,
        handler: definition.handler,
      })
    }
  }

  private describeTool(binding: ToolBinding): string {
    const prefix = `MCP tool ${binding.serverId}.${binding.toolName}.`
    return binding.description
      ? `${prefix} ${binding.description}`
      : prefix
  }

  private async enforcePolicy(openAiName: string, rawToolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> {
    const allowed = this.opts.hookPolicy.allowedTools
    const allowedDecision = enforceAllowedTools(openAiName, allowed, { phase: this.opts.phase })
    if (!allowedDecision.allow) return allowedDecision

    const rawAllowedDecision = enforceAllowedTools(rawToolName, allowed, { phase: this.opts.phase })
    if (!rawAllowedDecision.allow && allowed?.includes(openAiName) !== true) return rawAllowedDecision

    const pre = await this.opts.hookPolicy.onPreToolUse?.(openAiName, input)
    if (pre && !pre.allow) return pre

    return enforceWriteGuard({
      toolName: openAiName,
      toolInput: input,
      cwd: this.opts.cwd,
      writeRoots: this.opts.hookPolicy.writeRoots,
      writeToolNames: ['mcp__coro__file_write', 'mcp__coro__file_edit', 'file_write', 'file_edit'],
      pathInputKeys: ['path', 'file_path'],
    })
  }
}

function unwrapSdkInstance(raw: unknown): SdkServerInstance | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const maybeConfigInstance = record['instance']
  if (maybeConfigInstance && typeof maybeConfigInstance === 'object') {
    return maybeConfigInstance as SdkServerInstance
  }
  return raw as SdkServerInstance
}

function parseArguments(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { value: json }
  }
}

function toJsonSchema(rawShape: Record<string, unknown>): Record<string, unknown> {
  try {
    const schema = isZodSchema(rawShape)
      ? (rawShape as unknown as z.ZodTypeAny)
      : z.object(rawShape as z.core.$ZodLooseShape)
    return z.toJSONSchema(schema) as Record<string, unknown>
  } catch {
    return {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }
  }
}

/**
 * Validate a tool-call input against the registered Zod shape. Used
 * by {@link McpFunctionBridge.call} to catch wrong argument shapes
 * (`{message:...}` instead of `{reason:...}`, missing required
 * fields, …) before the handler ever runs. Mirrors what the MCP
 * SDK's CallTool dispatcher does on the Anthropic path.
 *
 * Accepts either a raw Zod shape (`{message: z.string()}`) or an
 * already-built Zod object schema (`z.object({...})`) — both forms
 * are valid registrations on the MCP SDK.
 */
function validateInputAgainstZodShape(
  shape: Record<string, unknown>,
  input: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  try {
    const schema = isZodSchema(shape)
      ? (shape as unknown as z.ZodTypeAny)
      : z.object(shape as z.core.$ZodLooseShape)
    const result = schema.safeParse(input)
    if (result.success) return { ok: true }
    const issues = result.error.issues.slice(0, 4).map(i => {
      const path = i.path.length > 0 ? i.path.join('.') : '(root)'
      return `${path}: ${i.message}`
    })
    return { ok: false, message: `Validation failed — ${issues.join('; ')}.` }
  } catch (err) {
    return { ok: false, message: `Schema check threw: ${(err as Error).message}` }
  }
}

function isZodSchema(value: unknown): boolean {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as { safeParse?: unknown }).safeParse === 'function',
  )
}

/**
 * Render the accepted top-level field names + a hint at their type
 * for the error message we send back to the model. Cheap and fully
 * derived from the registered Zod shape so it stays in sync.
 */
function describeShape(shape: Record<string, unknown>): string {
  // For an already-built z.object, the shape lives under `.shape` (Zod 4)
  // or `._def.shape()` (Zod 3). Fall back to the raw object otherwise.
  const inner: Record<string, unknown> = isZodSchema(shape)
    ? ((shape as unknown as { shape?: Record<string, unknown> }).shape ?? {})
    : shape
  const entries = Object.entries(inner)
  if (entries.length === 0) return '(no fields)'
  return entries
    .map(([k, v]) => {
      const def = (v as { def?: { type?: string } } | undefined)?.def?.type
      return def ? `${k}: ${def}` : k
    })
    .join(', ')
}

function stringifyMcpResult(result: unknown): string {
  if (isMcpTextResult(result)) {
    const textBlocks = result.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
    if (textBlocks.length > 0) return textBlocks.join('\n')
  }
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function isMcpTextResult(value: unknown): value is { content: Array<{ type: string; text?: string }> } {
  return Boolean(
    value
      && typeof value === 'object'
      && Array.isArray((value as { content?: unknown }).content),
  )
}
