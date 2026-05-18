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
  /**
   * Populated when `reconnectMcpServer` threw on the final attempt. The
   * previous implementation swallowed this silently, which made callers
   * believe MCP was healthy after a `forceReconnect: true` even when
   * the transport rebuild had failed. Callers MUST surface this in
   * their log line; the next `mcp__coro__*` call will otherwise fail
   * with `Stream closed` and look like a fresh bug.
   */
  reconnectError?: string
}> {
  const setResult = await liveQuery.setMcpServers(dynamicMcpServers)
  const readStatus = async () => {
    const statuses = await liveQuery.mcpServerStatus()
    return statuses.find(status => status.name === serverName)?.status ?? null
  }

  const initialStatus = await readStatus()
  let finalStatus = initialStatus
  let reconnected = false
  let reconnectError: string | undefined

  // SDK-type ("in-process") MCP servers do not have a transport to
  // reset — they are called directly via an in-process function table.
  // The Anthropic SDK explicitly rejects `reconnectMcpServer` for them
  // with `"SDK servers should be handled in print.ts"`, which produced
  // a constant false-positive `reconnectError` in our logs and made
  // the auto-recovery steering nudge unreachable (see executor.ts
  // detector gate). For SDK servers, a successful `setMcpServers` IS
  // the entire reattach surface — there is nothing else to do.
  const serverConfig = dynamicMcpServers[serverName]
  const isSdkServer = serverConfig !== undefined && (serverConfig as { type?: string }).type === 'sdk'

  const needsReconnect =
    !isSdkServer && (
      options.forceReconnect === true ||
      (finalStatus !== null && finalStatus !== 'connected' && !setResult.errors[serverName])
    )

  if (needsReconnect) {
    // One bounded retry with a small backoff — the SDK's
    // `reconnectMcpServer` regularly races the child-process MCP
    // transport during shutdown/restart and throws on the first call
    // even though the second call seconds later succeeds. Retrying
    // once eliminates the most common transient failure without
    // masking real breakage.
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
    finalStatus = await readStatus()
  }

  return {
    setResult,
    initialStatus,
    finalStatus,
    reconnected,
    ...(reconnectError ? { reconnectError } : {}),
  }
}
