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

interface ToolBinding {
  openAiName: string
  serverId: string
  toolName: string
  definition: RegisteredTool
}

export interface McpBridgeOptions {
  coroServer: McpServerDescriptor
  pluginServers: Record<string, PluginMcpServerConfig>
  hookPolicy: HookPolicy
  cwd: string
  phase?: string
  signal?: AbortSignal
}

export class McpFunctionBridge {
  private readonly bindings = new Map<string, ToolBinding>()
  readonly unsupportedServers: string[]

  constructor(private readonly opts: McpBridgeOptions) {
    this.unsupportedServers = this.collectServers()
  }

  listTools(): OpenAiFunctionTool[] {
    return Array.from(this.bindings.values()).map(binding => ({
      type: 'function' as const,
      name: binding.openAiName,
      description: this.describeTool(binding),
      parameters: toJsonSchema(binding.definition.inputSchema ?? {}),
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
      const result = await binding.definition.handler(input, { signal: this.opts.signal })
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

  private collectServers(): string[] {
    const unsupported: string[] = []
    this.addSdkServer('coro', this.opts.coroServer.instance)
    for (const serverId of Object.keys(this.opts.pluginServers)) {
      unsupported.push(serverId)
    }
    return unsupported
  }

  private addSdkServer(serverId: string, raw: unknown): void {
    const instance = unwrapSdkInstance(raw)
    if (!instance?._registeredTools) return
    for (const [toolName, definition] of Object.entries(instance._registeredTools)) {
      if (definition.enabled === false) continue
      const openAiName = `mcp__${serverId}__${toolName}`
      this.bindings.set(openAiName, { openAiName, serverId, toolName, definition })
    }
  }

  private describeTool(binding: ToolBinding): string {
    const prefix = `MCP tool ${binding.serverId}.${binding.toolName}.`
    return binding.definition.description
      ? `${prefix} ${binding.definition.description}`
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
