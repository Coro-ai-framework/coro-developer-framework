// ── External MCP server client (stdio / sse / http) ─────────────────────────
//
// The Anthropic SDK natively spawns and bridges plugin-declared MCP
// servers (GitHub, Jira, …) via its `mcpServers` config. The OpenAI
// Responses API has no equivalent — every callable tool must be a flat
// `function` declared in the request. This module bridges that gap by
// instantiating a real MCP client per plugin server, listing its
// tools, and forwarding `tools/call` requests so the executor can
// expose them as `mcp__<serverId>__<toolName>` functions to OpenAI.
//
// Lifecycle: one instance per plugin server per phase. Spawned
// children are terminated in `close()`; failures during init never
// crash the executor — the server is reported as failed and its tools
// are simply absent from this phase's tool list.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { PluginMcpServerConfig } from '@coro-ai/plugin-sdk'

export interface ExternalMcpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface ExternalMcpClientConnection {
  serverId: string
  client: Client
  tools: ExternalMcpTool[]
  close(): Promise<void>
}

/**
 * Connect to an external plugin-declared MCP server and enumerate its
 * tools. Resolves on success; throws on transport / handshake / list
 * failure so the caller can record the server as unsupported.
 */
export async function connectExternalMcpServer(
  serverId: string,
  config: PluginMcpServerConfig,
): Promise<ExternalMcpClientConnection> {
  const transport = buildTransport(config)
  const client = new Client(
    { name: `coro-openai-${serverId}`, version: '0.1.0' },
    { capabilities: {} },
  )
  await client.connect(transport)
  let tools: ExternalMcpTool[] = []
  try {
    const result = await client.listTools()
    tools = (result.tools ?? []).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? undefined,
    }))
  } catch (err) {
    await safeClose(client)
    throw err
  }
  return {
    serverId,
    client,
    tools,
    async close() {
      await safeClose(client)
    },
  }
}

function buildTransport(config: PluginMcpServerConfig) {
  switch (config.type) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      })
    case 'sse':
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      })
    case 'http':
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      })
    default: {
      const exhaustive: never = config
      throw new Error(`Unknown MCP server transport: ${JSON.stringify(exhaustive)}`)
    }
  }
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close()
  } catch {
    // Best-effort close — already-disconnected clients throw harmlessly.
  }
}
