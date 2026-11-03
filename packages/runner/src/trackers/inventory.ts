// ── MCP inventory ────────────────────────────────────────────────────────────
//
// What MCP servers a session will see, and what each one offers. Executors
// that can ask their own runtime (`inspectMcpServers`) report everything,
// including servers they attach themselves; for the rest we only know the
// servers Coro configured, by URL and command, without tool lists.
//
// A live probe starts a CLI process and waits for remote servers to
// connect, so results are cached per executor and server set and shared
// between concurrent callers.

import type { Logger } from 'pino'
import {
  mcpServerToolPrefix,
  type ExecutorMcpServerInfo,
  type PhaseExecutorRuntime,
  type PluginMcpServerConfig,
} from '@coro-ai/plugin-sdk'

export const MCP_INVENTORY_TTL_MS = 15 * 60_000

export interface McpInventory {
  servers: ExecutorMcpServerInfo[]
  /** `executor` when the executor reported its own view; `config` when only Coro's config is known. */
  origin: 'executor' | 'config'
  executorId?: string
  observedAt: string
}

interface CacheEntry {
  inventory: McpInventory
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<McpInventory>>()
let lastInventory: McpInventory | undefined

/** Inventory built from Coro's own config. Status is unknown and tools are not listed. */
export function inventoryFromConfig(pluginMcpServers: Record<string, PluginMcpServerConfig>): McpInventory {
  return {
    origin: 'config',
    observedAt: new Date().toISOString(),
    servers: Object.entries(pluginMcpServers).map(([name, raw]) => {
      const cfg = raw as unknown as { url?: unknown }
      return {
        name,
        toolPrefix: mcpServerToolPrefix(name),
        status: 'unknown' as const,
        source: 'coro-config',
        ...(typeof cfg.url === 'string' ? { url: cfg.url } : {}),
        tools: [],
      }
    }),
  }
}

function cacheKey(executorId: string, servers: Record<string, PluginMcpServerConfig>): string {
  return `${executorId}|${Object.keys(servers).sort().join(',')}`
}

export interface GetMcpInventoryArgs {
  executor?: Pick<PhaseExecutorRuntime, 'inspectMcpServers' | 'manifest'>
  pluginMcpServers: Record<string, PluginMcpServerConfig>
  cwd: string
  logger: Logger
  /** Skip the cache. */
  refresh?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export async function getMcpInventory(args: GetMcpInventoryArgs): Promise<McpInventory> {
  const inspect = args.executor?.inspectMcpServers?.bind(args.executor)
  if (!inspect) {
    const inventory = inventoryFromConfig(args.pluginMcpServers)
    lastInventory = inventory
    return inventory
  }

  const executorId = args.executor?.manifest.id ?? 'executor'
  const key = cacheKey(executorId, args.pluginMcpServers)
  const hit = cache.get(key)
  if (!args.refresh && hit && hit.expiresAt > Date.now()) return hit.inventory

  const pending = inflight.get(key)
  if (pending) return pending

  const run = (async () => {
    const started = Date.now()
    const servers = await inspect({
      cwd: args.cwd,
      pluginMcpServers: args.pluginMcpServers,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    })
    // A probe that saw nothing usually failed to start; fall back to what
    // the config says rather than caching an empty world for 15 minutes.
    const inventory: McpInventory = servers.length > 0
      ? { origin: 'executor', executorId, observedAt: new Date().toISOString(), servers }
      : inventoryFromConfig(args.pluginMcpServers)
    if (servers.length > 0) cache.set(key, { inventory, expiresAt: Date.now() + MCP_INVENTORY_TTL_MS })
    lastInventory = inventory
    args.logger.info(
      {
        executorId,
        servers: inventory.servers.map(s => `${s.name}:${s.status}`),
        durationMs: Date.now() - started,
      },
      'MCP inventory refreshed',
    )
    return inventory
  })().finally(() => inflight.delete(key))
  inflight.set(key, run)
  return run
}

/** Most recent inventory any caller produced, for read-only surfaces. */
export function peekMcpInventory(): McpInventory | undefined {
  return lastInventory
}

export function resetMcpInventoryCache(): void {
  cache.clear()
  inflight.clear()
  lastInventory = undefined
}
