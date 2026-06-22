// ── Plan-mode chat via Claude Agent SDK ─────────────────────────────────────
//
// Coro plan mode calls {@link PhaseExecutorRuntime.chat} on the Anthropic
// executor. A direct `/v1/messages` REST call with an OAuth bearer token
// (claudeLogin / oauth auth) hits Anthropic's *subscription* usage gates,
// which surface as HTTP 429 `rate_limit_error` with a useless `"Error"`
// body — even when the account is not API rate-limited and regular job
// phases work fine through the Claude Code subprocess.
//
// Job phases already route through {@link AnthropicExecutor.executePhase},
// which spawns Claude Code and lets it manage subscription auth the same
// way the CLI does. Plan mode should follow that path for subscription
// auth so behaviour is consistent end-to-end.
//
// API-key billing (`method: apiKey`) keeps the lightweight REST
// implementation in {@link AnthropicExecutor.chat} — there is no
// subscription channel mismatch and the subprocess startup cost is
// unnecessary for a short conversational turn.

import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@coro-ai/plugin-sdk'
import type {
  ChatRequest,
  ChatResult,
  ChatToolCallRecord,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
} from '@coro-ai/plugin-sdk'
import type { ClaudeAuthConfig } from './types'

/** Minimal surface {@link chatViaAgentSdk} needs from {@link AnthropicExecutor}. */
export interface AnthropicChatHost {
  executePhase(req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent>
}

/** Sentinel allowlist entry — blocks every SDK tool when plan mode has no tools. */
const CHAT_NO_TOOLS_ALLOWLIST = '__coro_chat_no_tools__'

export function shouldChatViaAgentSdk(auth: ClaudeAuthConfig): boolean {
  const method = auth.method ?? 'claudeLogin'
  return method === 'claudeLogin' || method === 'oauth'
}

function formatChatUserPrompt(messages: ChatRequest['messages']): string {
  if (messages.length === 0) return 'Hello.'
  if (messages.length === 1 && messages[0].role === 'user') {
    return messages[0].content
  }
  return messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

function computeChatMaxTurns(req: ChatRequest): number {
  const toolRounds = req.maxToolRounds ?? 5
  const hasTools = (req.tools?.length ?? 0) > 0 && typeof req.runTool === 'function'
  if (!hasTools) return 3
  // Each tool round is at least one model turn + one tool-result turn.
  return Math.max(toolRounds * 3, 15)
}

function mcpText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function mcpError(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const }
}

/**
 * Plan-mode {@link ChatTool} definitions carry JSON Schema (for the
 * Messages API path). The Claude Agent SDK MCP `tool()` helper only
 * accepts Zod, so we derive a loose Zod object from the declared
 * property types. Argument validation still happens in the runner's
 * `runTool` dispatcher.
 */
function chatToolZodShape(inputSchema: object): Record<string, z.ZodTypeAny> {
  if (inputSchema && typeof inputSchema === 'object' && 'properties' in inputSchema) {
    const props = (inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {}
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, spec] of Object.entries(props)) {
      shape[key] = spec?.type === 'number' ? z.number() : z.string()
    }
    return shape
  }
  return {}
}

function buildChatMcpServer(
  req: ChatRequest,
  toolCalls: ChatToolCallRecord[],
) {
  const tools = req.tools ?? []
  const runTool = req.runTool
  if (tools.length === 0 || !runTool) {
    return createSdkMcpServer({ name: 'coro', tools: [] })
  }

  const mcpTools = tools.map(chatTool =>
    tool(
      chatTool.name,
      chatTool.description,
      chatToolZodShape(chatTool.inputSchema),
      async (args: Record<string, unknown>) => {
        req.onToolStart?.({ name: chatTool.name, input: args })
        const startedAt = Date.now()
        try {
          const output = await runTool(chatTool.name, args)
          const record: ChatToolCallRecord = {
            name: chatTool.name,
            input: args,
            output,
            durationMs: Date.now() - startedAt,
          }
          toolCalls.push(record)
          req.onToolEnd?.(record)
          return mcpText(output)
        } catch (err) {
          const message = (err as Error).message
          const record: ChatToolCallRecord = {
            name: chatTool.name,
            input: args,
            output: { error: message },
            durationMs: Date.now() - startedAt,
            error: message,
          }
          toolCalls.push(record)
          req.onToolEnd?.(record)
          return mcpError(message)
        }
      },
    ),
  )

  return createSdkMcpServer({ name: 'coro', tools: mcpTools })
}

function chatAllowedTools(req: ChatRequest): string[] {
  const tools = req.tools ?? []
  if (tools.length === 0) return [CHAT_NO_TOOLS_ALLOWLIST]
  return tools.map(t => `mcp__coro__${t.name}`)
}

export async function chatViaAgentSdk(
  executor: AnthropicChatHost,
  req: ChatRequest,
): Promise<ChatResult> {
  const workRoot = mkdtempSync(join(tmpdir(), 'coro-chat-'))
  const intelligenceDir = join(workRoot, '_intelligence')
  mkdirSync(intelligenceDir, { recursive: true })

  const toolCalls: ChatToolCallRecord[] = []
  const mcpInstance = buildChatMcpServer(req, toolCalls)
  const allowedTools = chatAllowedTools(req)
  const allowedSet = new Set(allowedTools)

  const phaseReq: PhaseExecutionRequest = {
    systemPrompt: req.systemPrompt ?? '',
    userPrompt: formatChatUserPrompt(req.messages),
    model: req.model,
    cwd: workRoot,
    intelligenceDir,
    mcpServer: { kind: 'sdk-instance', id: 'coro', instance: mcpInstance },
    pluginMcpServers: {},
    hookPolicy: {
      allowedTools,
      writeRoots: [workRoot],
      onPreToolUse: (toolName) => {
        if (allowedSet.has(CHAT_NO_TOOLS_ALLOWLIST)) {
          return {
            allow: false,
            reason: 'Plan mode chat does not use tools for this turn.',
          }
        }
        if (!allowedSet.has(toolName)) {
          return {
            allow: false,
            reason: `Blocked ${toolName}: only plan-mode lookup tools are available.`,
          }
        }
        return { allow: true }
      },
    },
    sessionState: {},
    maxTurns: computeChatMaxTurns(req),
    phase: 'chat',
    signal: req.signal,
  }

  const textParts: string[] = []
  let usage: ChatResult['usage'] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }

  for await (const event of executor.executePhase(phaseReq)) {
    if (event.type === 'text' && event.content) {
      textParts.push(event.content)
    } else if (event.type === 'usage') {
      usage = event.tokens
    }
  }

  return {
    output: textParts.join('').trim(),
    usage,
    toolCalls,
  }
}
