// ── Plan-mode chat MCP helpers ───────────────────────────────────────────────
//
// Shared by Coro plan mode (intake) and LLM executor `chat()` paths.
// Keeps allowlist / turn-budget logic provider-neutral.

import type { ChatRequest } from './types'

/** Sentinel entry — blocks every SDK tool when plan mode has no tools. */
export const CHAT_NO_TOOLS_ALLOWLIST = '__coro_chat_no_tools__'

export function chatPluginMcpServerIds(req: ChatRequest): string[] {
  return Object.keys(req.pluginMcpServers ?? {})
}

/** True when built-in intake tools and/or BYO plan-mode MCP servers are attached. */
export function chatHasTools(req: ChatRequest): boolean {
  const hasBuiltin = (req.tools?.length ?? 0) > 0 && typeof req.runTool === 'function'
  const hasMcp = chatPluginMcpServerIds(req).length > 0
  return hasBuiltin || hasMcp
}

/** SDK-visible names for runner-dispatched intake tools (`mcp__coro__*`). */
export function chatBuiltinToolAllowlist(req: ChatRequest): string[] {
  return (req.tools ?? []).map(t => `mcp__coro__${t.name}`)
}

export function isPlanModeMcpToolName(toolName: string, serverIds: ReadonlyArray<string>): boolean {
  for (const id of serverIds) {
    if (toolName.startsWith(`mcp__${id}__`)) return true
  }
  return false
}

export interface ChatToolAllowPolicy {
  /**
   * Value for `hookPolicy.allowedTools`. Always `null` for plan-mode chat
   * so {@link hooks.ts} does not run its exact-name Set gate before
   * `onPreToolUse` — that gate cannot express BYO MCP prefix allowlists.
   */
  hookAllowedTools: null
  checkToolAllowed: (toolName: string) => { allow: boolean; reason?: string }
}

/** Build hook allowlist + checker for plan-mode chat (built-in + BYO MCP). */
export function buildChatToolAllowPolicy(req: ChatRequest): ChatToolAllowPolicy {
  const serverIds = chatPluginMcpServerIds(req)
  const builtinNames = chatBuiltinToolAllowlist(req)
  const hasAny = builtinNames.length > 0 || serverIds.length > 0

  if (!hasAny) {
    return {
      hookAllowedTools: null,
      checkToolAllowed: () => ({
        allow: false,
        reason: 'Plan mode chat does not use tools for this turn.',
      }),
    }
  }

  const allowedSet = new Set(builtinNames)
  return {
    hookAllowedTools: null,
    checkToolAllowed: (toolName: string) => {
      // Claude Code may invoke ToolSearch when many MCP tools are attached.
      if (toolName === 'ToolSearch') return { allow: true }
      if (allowedSet.has(toolName)) return { allow: true }
      if (isPlanModeMcpToolName(toolName, serverIds)) return { allow: true }
      return {
        allow: false,
        reason: `Blocked ${toolName}: only plan-mode lookup tools are available.`,
      }
    },
  }
}

export function computeChatMaxTurns(req: ChatRequest): number {
  const toolRounds = req.maxToolRounds ?? 5
  if (!chatHasTools(req)) return 3
  return Math.max(toolRounds * 3, 15)
}

/** Parse `mcp__<serverId>__<toolName>` for intake UI summaries. */
export function parseMcpToolName(toolName: string): { serverId: string; toolName: string } | null {
  if (!toolName.startsWith('mcp__')) return null
  const rest = toolName.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
}
