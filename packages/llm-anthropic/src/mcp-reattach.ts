import type { McpServerConfig, McpSetServersResult, Query } from '@anthropic-ai/claude-agent-sdk'

type DynamicMcpQuery = Pick<Query, 'setMcpServers' | 'mcpServerStatus' | 'reconnectMcpServer'>

export type ReattachMcpResult = {
  setResult: McpSetServersResult
  initialStatus: string | null
  finalStatus: string | null
  reconnected: boolean
  reconnectError?: string
}

function isSdkMcpServer(config: McpServerConfig | undefined): boolean {
  return config !== undefined && (config as { type?: string }).type === 'sdk'
}

async function reconnectExternalServer(
  liveQuery: DynamicMcpQuery,
  serverName: string,
  forceReconnect: boolean,
  setResult: McpSetServersResult,
  currentStatus: string | null,
): Promise<{ reconnected: boolean; reconnectError?: string; finalStatus: string | null }> {
  const needsReconnect =
    forceReconnect ||
    (currentStatus !== null && currentStatus !== 'connected' && !setResult.errors[serverName])

  if (!needsReconnect) {
    return { reconnected: false, finalStatus: currentStatus }
  }

  let reconnected = false
  let reconnectError: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await liveQuery.reconnectMcpServer(serverName)
      reconnected = true
      reconnectError = undefined
      break
    } catch (err) {
      reconnectError = err instanceof Error ? err.message : String(err)
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  }

  const statuses = await liveQuery.mcpServerStatus()
  const finalStatus = statuses.find(s => s.name === serverName)?.status ?? null
  return { reconnected, reconnectError, finalStatus }
}

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
/**
 * Re-attach every dynamic MCP server after `setMcpServers`. External
 * (stdio/http) servers get `reconnectMcpServer`; SDK in-process servers
 * rely on `setMcpServers` + optional instance rebuild only.
 */
export async function reattachAllDynamicMcpServers(
  liveQuery: DynamicMcpQuery,
  dynamicMcpServers: Record<string, McpServerConfig>,
  options: { forceReconnect?: boolean } = {},
): Promise<ReattachMcpResult> {
  const forceReconnect = options.forceReconnect === true
  const setResult = await liveQuery.setMcpServers(dynamicMcpServers)
  const statuses = await liveQuery.mcpServerStatus()
  const statusByName = new Map<string, string | null>(
    statuses.map(s => [s.name, s.status ?? null]),
  )

  let reconnected = false
  let reconnectError: string | undefined

  for (const serverName of Object.keys(dynamicMcpServers)) {
    if (isSdkMcpServer(dynamicMcpServers[serverName])) continue
    const result = await reconnectExternalServer(
      liveQuery,
      serverName,
      forceReconnect,
      setResult,
      statusByName.get(serverName) ?? null,
    )
    if (result.reconnected) reconnected = true
    if (result.reconnectError) reconnectError = result.reconnectError
    if (result.finalStatus !== null) statusByName.set(serverName, result.finalStatus)
  }

  const coroName = 'coro'
  return {
    setResult,
    initialStatus: statusByName.get(coroName) ?? null,
    finalStatus: statusByName.get(coroName) ?? null,
    reconnected,
    ...(reconnectError ? { reconnectError } : {}),
  }
}

export async function reattachDynamicMcpServers(
  liveQuery: DynamicMcpQuery,
  dynamicMcpServers: Record<string, McpServerConfig>,
  serverName: string,
  options: { forceReconnect?: boolean } = {},
): Promise<ReattachMcpResult> {
  const setResult = await liveQuery.setMcpServers(dynamicMcpServers)
  const statuses = await liveQuery.mcpServerStatus()
  const initialStatus = statuses.find(status => status.name === serverName)?.status ?? null

  if (isSdkMcpServer(dynamicMcpServers[serverName])) {
    return { setResult, initialStatus, finalStatus: initialStatus, reconnected: false }
  }

  const { reconnected, reconnectError, finalStatus } = await reconnectExternalServer(
    liveQuery,
    serverName,
    options.forceReconnect === true,
    setResult,
    initialStatus,
  )

  return {
    setResult,
    initialStatus,
    finalStatus,
    reconnected,
    ...(reconnectError ? { reconnectError } : {}),
  }
}
