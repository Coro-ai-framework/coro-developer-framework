import type { McpServerConfig, McpSetServersResult, Query } from '@anthropic-ai/claude-agent-sdk'

type DynamicMcpQuery = Pick<Query, 'setMcpServers' | 'mcpServerStatus' | 'reconnectMcpServer'>

/**
 * Re-attach dynamic MCP servers (the in-process Coro server + plugin
 * servers) on a resumed query. The Claude Agent SDK has historically
 * been flaky here — sometimes the SDK reports the server attached but
 * the connection is dead. We poll status, force a reconnect when needed,
 * and surface the final state to the caller for logging.
 */
export async function reattachDynamicMcpServers(
  liveQuery: DynamicMcpQuery,
  dynamicMcpServers: Record<string, McpServerConfig>,
  serverName: string,
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

  if (finalStatus && finalStatus !== 'connected' && !setResult.errors[serverName]) {
    await liveQuery.reconnectMcpServer(serverName)
    reconnected = true
    finalStatus = await readStatus()
  }

  return {
    setResult,
    initialStatus,
    finalStatus,
    reconnected,
  }
}
