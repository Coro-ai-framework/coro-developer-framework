import type { McpServerConfig, McpSetServersResult, Query } from '@anthropic-ai/claude-agent-sdk'

type DynamicMcpQuery = Pick<Query, 'setMcpServers' | 'mcpServerStatus' | 'reconnectMcpServer'>

/**
 * Re-attach dynamic MCP servers (the in-process Coro server + plugin
 * servers) on a resumed query. The Claude Agent SDK has historically
 * been flaky here — sometimes the SDK reports the server attached but
 * the connection is dead. We poll status, force a reconnect when needed,
 * and surface the final state to the caller for logging.
 *
 * **forceReconnect** — when true (used after a user-initiated
 * `q.interrupt()`), we ALWAYS call `reconnectMcpServer`, even when the
 * SDK reports status='connected'. The SDK's status field tracks only
 * the transport-open boolean; after an interrupt the request/response
 * correlation table inside the SDK is corrupted (in-flight
 * control_request promises got aborted, but the channel itself is
 * still marked "connected"). The next `mcp__coro__*` call then hangs
 * or fails with "Stream closed". A hard reconnect rebuilds the
 * correlation table from scratch. Without this flag the original
 * status-gated heuristic skips the reconnect and the agent loses MCP
 * tools for the rest of the phase — see the dashboard screenshot
 * showing `status=connected reconnected=false errors={}` followed by
 * "MCP stream closed" tool-call failures.
 */
export async function reattachDynamicMcpServers(
  liveQuery: DynamicMcpQuery,
  dynamicMcpServers: Record<string, McpServerConfig>,
  serverName: string,
  options: { forceReconnect?: boolean } = {},
): Promise<{
  setResult: McpSetServersResult
  initialStatus: string | null
  finalStatus: string | null
  reconnected: boolean
}> {
  const setResult = await liveQuery.setMcpServers(dynamicMcpServers)
  const readStatus = async () => {
    const statuses = await liveQuery.mcpServerStatus()
    return statuses.find(status => status.name === serverName)?.status ?? null
  }

  const initialStatus = await readStatus()
  let finalStatus = initialStatus
  let reconnected = false

  const needsReconnect =
    options.forceReconnect === true ||
    (finalStatus !== null && finalStatus !== 'connected' && !setResult.errors[serverName])

  if (needsReconnect) {
    try {
      await liveQuery.reconnectMcpServer(serverName)
      reconnected = true
    } catch {
      // The SDK occasionally throws here when the underlying child
      // process already cleaned up the transport. The next call to
      // `setMcpServers` (on the following iteration) will recreate
      // it. Don't propagate — the caller will log the final status.
    }
    finalStatus = await readStatus()
  }

  return {
    setResult,
    initialStatus,
    finalStatus,
    reconnected,
  }
}
