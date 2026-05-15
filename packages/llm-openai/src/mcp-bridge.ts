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

export interface OpenAiFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: false
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
}

export interface ExternalMcpFailure {
  serverId: string
  reason: string
}

export class McpFunctionBridge {
  private readonly bindings = new Map<string, ToolBinding>()
  private readonly externalConnections: ExternalMcpClientConnection[] = []
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
    await Promise.all(
      entries.map(async ([serverId, config]) => {
        try {
          const connection = await connectExternalMcpServer(serverId, config)
          this.externalConnections.push(connection)
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
  }

  listTools(): OpenAiFunctionTool[] {
    return Array.from(this.bindings.values()).map(binding => ({
      type: 'function' as const,
      name: binding.openAiName,
      description: this.describeTool(binding),
      parameters: toJsonSchema(binding.inputSchema ?? {}),
      strict: false as const,
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
    const policy = this.enforcePolicy(binding.openAiName, binding.toolName, input)
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

  private enforcePolicy(openAiName: string, rawToolName: string, input: Record<string, unknown>): { allow: boolean; reason?: string } {
    const allowed = this.opts.hookPolicy.allowedTools
    const allowedDecision = enforceAllowedTools(openAiName, allowed, { phase: this.opts.phase })
    if (!allowedDecision.allow) return allowedDecision

    const rawAllowedDecision = enforceAllowedTools(rawToolName, allowed, { phase: this.opts.phase })
    if (!rawAllowedDecision.allow && allowed?.includes(openAiName) !== true) return rawAllowedDecision

    const pre = this.opts.hookPolicy.onPreToolUse?.(openAiName, input)
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
    return z.toJSONSchema(z.object(rawShape as z.core.$ZodLooseShape)) as Record<string, unknown>
  } catch {
    return {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }
  }
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
