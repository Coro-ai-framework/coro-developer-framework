// ── MCP inventory probe ──────────────────────────────────────────────────────
//
// Claude Code attaches servers Coro never configured — claude.ai account
// connectors above all — so the only way to know what a phase will see is
// to ask a live CLI process. An idle session answers `mcpServerStatus()`
// over the control channel without a user turn, so this costs no tokens.
// Remote servers connect in the background, so we poll until nothing is
// `pending` or the deadline passes, and report whatever we have then.

import { query, type McpServerConfig, type McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from 'pino'
import {
  mcpServerToolPrefix,
  type ExecutorMcpServerInfo,
  type ExecutorMcpServerStatus,
  type PluginMcpServerConfig,
} from '@coro-ai/plugin-sdk'
import { createIdlePromptStream } from './login'

const DEFAULT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 1_000
/** claude.ai connectors are listed ~3s after start; an empty list past this means there are none. */
const EMPTY_SETTLE_MS = 6_000

export interface InspectClaudeMcpServersOptions {
  cliPath: string
  cwd: string
  env: Record<string, string | undefined>
  pluginMcpServers?: Record<string, PluginMcpServerConfig>
  timeoutMs?: number
  signal?: AbortSignal
  logger: Logger
}

const KNOWN_STATUSES = new Set<ExecutorMcpServerStatus>(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])

export function toExecutorMcpServerInfo(status: McpServerStatus): ExecutorMcpServerInfo {
  const config = status.config as { url?: unknown } | undefined
  const url = typeof config?.url === 'string' ? config.url : undefined
  return {
    name: status.name,
    toolPrefix: mcpServerToolPrefix(status.name),
    status: KNOWN_STATUSES.has(status.status as ExecutorMcpServerStatus)
      ? status.status as ExecutorMcpServerStatus
      : 'unknown',
    ...(status.source ?? status.scope ? { source: status.source ?? status.scope } : {}),
    ...(url ? { url } : {}),
    tools: (status.tools ?? []).map(t => ({
      name: t.name,
      ...(t.annotations?.readOnly !== undefined ? { readOnly: t.annotations.readOnly } : {}),
      ...(t.annotations?.destructive !== undefined ? { destructive: t.annotations.destructive } : {}),
    })),
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

export async function inspectClaudeMcpServers(opts: InspectClaudeMcpServersOptions): Promise<ExecutorMcpServerInfo[]> {
  const startedAt = Date.now()
  const deadline = startedAt + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const idle = createIdlePromptStream()
  const q = query({
    prompt: idle.stream,
    options: {
      pathToClaudeCodeExecutable: opts.cliPath,
      cwd: opts.cwd,
      settingSources: ['project'],
      persistSession: false,
      permissionMode: 'dontAsk',
      ...(opts.pluginMcpServers && Object.keys(opts.pluginMcpServers).length > 0
        ? { mcpServers: opts.pluginMcpServers as unknown as Record<string, McpServerConfig> }
        : {}),
      env: opts.env,
      stderr: (chunk: string) => {
        const text = String(chunk).trim()
        if (text) opts.logger.debug(`[mcp-inventory] ${text}`)
      },
    } as Parameters<typeof query>[0]['options'],
  })

  let latest: McpServerStatus[] = []
  try {
    while (!opts.signal?.aborted) {
      latest = await q.mcpServerStatus()
      const settled = latest.length > 0
        ? latest.every(s => s.status !== 'pending')
        : Date.now() - startedAt >= EMPTY_SETTLE_MS
      if (settled || Date.now() >= deadline) break
      await sleep(POLL_INTERVAL_MS, opts.signal)
    }
  } catch (err) {
    opts.logger.warn({ err }, 'MCP inventory probe failed — reporting what was seen so far')
  } finally {
    idle.close()
    q.close()
  }
  return latest.map(toExecutorMcpServerInfo)
}
