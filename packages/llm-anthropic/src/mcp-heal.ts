import type { McpServerConfig, McpSetServersResult, Query } from '@anthropic-ai/claude-agent-sdk'
import { reattachDynamicMcpServers } from './mcp-reattach'

export type DynamicMcpQuery = Pick<Query, 'setMcpServers' | 'mcpServerStatus' | 'reconnectMcpServer'>

export type HealMcpResult = {
  setResult: McpSetServersResult
  initialStatus: string | null
  finalStatus: string | null
  reconnected: boolean
  reconnectError?: string
}

export type HealMcpTransportOptions = {
  liveQuery: DynamicMcpQuery
  /** Current MCP server map (mutated in-place when `rebuildServers` runs). */
  dynamicMcpServers: Record<string, McpServerConfig>
  serverName?: string
  forceReconnect?: boolean
  /**
   * When set, replaces `dynamicMcpServers[serverName]` with a fresh Coro
   * SDK instance before `setMcpServers`. Required for in-process SDK MCP
   * healing after `interrupt()` — reconnect is a no-op for SDK servers.
   */
  rebuildServers?: () => Record<string, McpServerConfig>
}

/**
 * Central MCP heal pipeline: optional fresh server instance, then
 * `setMcpServers` + status poll + bounded reconnect for external servers.
 */
export async function healMcpTransport(
  opts: HealMcpTransportOptions,
): Promise<HealMcpResult> {
  const serverName = opts.serverName ?? 'coro'

  if (opts.rebuildServers) {
    const rebuilt = opts.rebuildServers()
    Object.assign(opts.dynamicMcpServers, rebuilt)
  }

  return reattachDynamicMcpServers(opts.liveQuery, opts.dynamicMcpServers, serverName, {
    forceReconnect: opts.forceReconnect ?? true,
  })
}

/** Whether the Coro MCP server registered cleanly after a heal attempt. */
export function isCoroMcpHealthy(refresh: HealMcpResult, serverName = 'coro'): boolean {
  const coroErrored = Boolean(refresh.setResult.errors[serverName])
  const transportOk = refresh.finalStatus === 'connected' || refresh.finalStatus === null
  return !coroErrored && transportOk
}

export const MCP_RETRY_NUDGE =
  '[system notice] Your previous tool call failed because the MCP transport ' +
  'was reset (typically by a developer steering interrupt or a transient SDK ' +
  'race). The connection has been rebuilt and is healthy. Retry the exact same ' +
  'tool call — do NOT change your plan or invent workarounds based on this failure.'
