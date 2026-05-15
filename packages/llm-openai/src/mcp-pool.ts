// ── External MCP connection pool ──────────────────────────────────────────────
//
// One stdio child per (job, serverId), reused across phases AND
// subagent invocations within the same job. Without this, each
// `executePhase` (and therefore each `run_subagent` dispatch) would
// spawn fresh stdio children for every external MCP server — visible
// as multiple FastMCP/GitHub-MCP startup banners in the runner log
// when a coder makes back-to-back subagent calls.
//
// Lifetime: ref-counted. When the last bridge using a connection
// disposes, we keep the connection alive for `IDLE_GRACE_MS` so a
// rapid re-acquire (next phase / next subagent call) reuses it.
// After the grace period with zero refs, the connection is closed.

import type { PluginMcpServerConfig } from '@coro/plugin-sdk'
import {
  connectExternalMcpServer,
  type ExternalMcpClientConnection,
} from './mcp-external-client'

const IDLE_GRACE_MS = 60_000

interface PoolEntry {
  conn: ExternalMcpClientConnection
  refs: number
  idleTimer?: NodeJS.Timeout
}

/**
 * Per-executor pool of external MCP connections, keyed by
 * `${scopeKey}::${serverId}`. The scope key is typically the job's
 * working directory so that connections are NOT shared across
 * unrelated jobs running in the same runner process.
 */
export class ExternalMcpConnectionPool {
  private readonly entries = new Map<string, PoolEntry>()

  async acquire(
    scopeKey: string,
    serverId: string,
    config: PluginMcpServerConfig,
  ): Promise<ExternalMcpClientConnection> {
    const key = `${scopeKey}::${serverId}`
    const existing = this.entries.get(key)
    if (existing) {
      existing.refs++
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer)
        existing.idleTimer = undefined
      }
      return existing.conn
    }
    const conn = await connectExternalMcpServer(serverId, config)
    this.entries.set(key, { conn, refs: 1 })
    return conn
  }

  release(scopeKey: string, serverId: string): void {
    const key = `${scopeKey}::${serverId}`
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0) return
    entry.idleTimer = setTimeout(() => {
      const cur = this.entries.get(key)
      if (!cur || cur.refs > 0) return
      this.entries.delete(key)
      cur.conn.close().catch(() => {/* best-effort */})
    }, IDLE_GRACE_MS)
    // Don't keep the event loop alive just to close an idle MCP child.
    entry.idleTimer.unref?.()
  }

  /** Force-close everything. Used on executor.dispose(). */
  async drain(): Promise<void> {
    const all = Array.from(this.entries.values())
    this.entries.clear()
    await Promise.all(
      all.map(async e => {
        if (e.idleTimer) clearTimeout(e.idleTimer)
        try { await e.conn.close() } catch { /* best-effort */ }
      }),
    )
  }
}
