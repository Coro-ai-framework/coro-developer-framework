import type { McpServerConfig, Query } from '@anthropic-ai/claude-agent-sdk'
import { reattachAllDynamicMcpServers, type ReattachMcpResult } from './mcp-reattach'
import { isMcpHealExhaustedError } from './steering-errors'

export type DynamicMcpQuery = Pick<Query, 'setMcpServers' | 'mcpServerStatus' | 'reconnectMcpServer'>

export type HealMcpResult = ReattachMcpResult

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
  if (opts.rebuildServers) {
    const rebuilt = opts.rebuildServers()
    Object.assign(opts.dynamicMcpServers, rebuilt)
  }

  return reattachAllDynamicMcpServers(opts.liveQuery, opts.dynamicMcpServers, {
    forceReconnect: opts.forceReconnect ?? true,
  })
}

const DEFAULT_HEAL_TIMEOUT_MS = 8_000
const HEAL_RETRY_BACKOFF_MS = 250

/**
 * Bounded MCP heal for steering interrupts. Retries until healthy or
 * timeout (fits within the dispatcher's 10s interrupt race).
 */
export async function runBoundedMcpHeal(
  opts: HealMcpTransportOptions & { timeoutMs?: number },
): Promise<HealMcpResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_HEAL_TIMEOUT_MS)
  let last: HealMcpResult = {
    setResult: { added: [], removed: [], errors: {} },
    initialStatus: null,
    finalStatus: null,
    reconnected: false,
  }

  while (Date.now() < deadline) {
    last = await healMcpTransport(opts)
    const errText = last.reconnectError ?? ''
    if (isCoroMcpHealthy(last) && !isMcpHealExhaustedError(errText)) {
      return last
    }
    await new Promise(resolve => setTimeout(resolve, HEAL_RETRY_BACKOFF_MS))
  }

  return last
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
