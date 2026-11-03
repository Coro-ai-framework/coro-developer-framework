// ── Tracker binding ──────────────────────────────────────────────────────────
//
// Which tracker a job talks to, and through which tools. Two sources:
//
//   - a Coro tracker plugin, reached through the `tracker_*` tools on the
//     coro MCP server;
//   - any MCP server the session already has (a claude.ai connector, a
//     Claude Code plugin, a BYO server) that matches a tracker profile.
//
// `ticketing.tracker` picks between them: `"auto"` (default), a plugin id,
// `"mcp:<server>"`, or `"none"`. Auto prefers the job's own `params.tracker`,
// then a configured plugin, then exactly one connected, auto-selectable MCP
// server. More than one candidate is never guessed between: the job runs
// without a tracker and the candidates are reported so the operator can pin
// one.

import type { ExecutorMcpServerInfo, ExecutorMcpServerStatus } from '@coro-ai/plugin-sdk'
import type { PluginRegistry } from '../plugins/registry'
import type { TrackerPluginRuntime } from '../plugins/types'
import type { McpInventory } from './inventory'
import {
  TRACKER_MCP_PROFILES,
  TRACKER_OPS,
  isReadOp,
  matchTrackerProfile,
  type RedirectArgs,
  type RedirectOp,
  type TrackerMcpProfile,
  type TrackerOp,
} from './profiles'

export const MCP_TRACKER_PREFIX = 'mcp:'

export interface TrackerBinding {
  source: 'plugin' | 'mcp'
  /** Plugin manifest id, or the MCP server name as the session reports it. */
  id: string
  /** The value that pins this binding in `ticketing.tracker` / `params.tracker`. */
  selector: string
  provider: string
  displayName: string
  profileId?: string
  status: ExecutorMcpServerStatus
  /** Fully-qualified tool names by operation. */
  tools: Partial<Record<TrackerOp, string>>
  readTools: string[]
  writeTools: string[]
  notes: string[]
}

export interface TrackerResolution {
  binding?: TrackerBinding
  /** Every tracker-shaped MCP server seen, bound or not. */
  candidates: TrackerBinding[]
  /** Why there is no binding, or which rule chose this one. */
  reason: string
}

const PLUGIN_TOOL_OPS: Partial<Record<TrackerOp, string>> = {
  getIssue: 'mcp__coro__tracker_get_issue',
  getComments: 'mcp__coro__tracker_get_comments',
  comment: 'mcp__coro__tracker_comment_issue',
  transition: 'mcp__coro__tracker_transition_issue',
}

export function isMcpTrackerSelector(selector: string | undefined): selector is string {
  return typeof selector === 'string' && selector.startsWith(MCP_TRACKER_PREFIX)
}

export function pluginTrackerBinding(plugin: TrackerPluginRuntime): TrackerBinding {
  const tools = { ...PLUGIN_TOOL_OPS }
  return {
    source: 'plugin',
    id: plugin.manifest.id,
    selector: plugin.manifest.id,
    provider: plugin.manifest.id,
    displayName: plugin.manifest.displayName ?? plugin.manifest.id,
    status: 'connected',
    tools,
    readTools: [tools.getIssue!, tools.getComments!],
    writeTools: [tools.comment!, tools.transition!],
    notes: [],
  }
}

function serverMatchesSelector(server: ExecutorMcpServerInfo, wanted: string): boolean {
  const w = wanted.toLowerCase()
  const prefixId = server.toolPrefix.replace(/^mcp__/, '').replace(/__$/, '').toLowerCase()
  return server.name.toLowerCase() === w || prefixId === w
}

export function mcpTrackerBinding(server: ExecutorMcpServerInfo, profile?: TrackerMcpProfile): TrackerBinding {
  const qualify = (name: string) => `${server.toolPrefix}${name}`
  const tools: Partial<Record<TrackerOp, string>> = {}
  for (const op of TRACKER_OPS) {
    const name = profile?.tools[op]
    if (name) tools[op] = qualify(name)
  }

  const readTools = new Set<string>()
  const writeTools = new Set<string>()
  if (server.tools.length > 0) {
    const opByName = new Map<string, TrackerOp>()
    for (const op of TRACKER_OPS) {
      const name = profile?.tools[op]
      if (name && !opByName.has(name)) opByName.set(name, op)
    }
    for (const t of server.tools) {
      const op = opByName.get(t.name)
      // Annotations win; without them a profile-known read is a read, and
      // anything unknown is treated as a write so plan mode cannot reach it.
      const read = t.readOnly ?? (op ? isReadOp(op) : false)
      ;(read ? readTools : writeTools).add(qualify(t.name))
    }
  } else {
    for (const op of TRACKER_OPS) {
      const name = profile?.tools[op]
      if (name) (isReadOp(op) ? readTools : writeTools).add(qualify(name))
    }
    for (const t of readTools) writeTools.delete(t)
  }

  return {
    source: 'mcp',
    id: server.name,
    selector: `${MCP_TRACKER_PREFIX}${server.name}`,
    provider: profile?.provider ?? 'unknown',
    displayName: profile ? `${profile.displayName} via ${server.name}` : server.name,
    ...(profile ? { profileId: profile.id } : {}),
    status: server.status,
    tools,
    readTools: [...readTools].sort(),
    writeTools: [...writeTools].sort(),
    notes: profile?.notes ?? [],
  }
}

function usable(status: ExecutorMcpServerStatus): boolean {
  return status === 'connected' || status === 'unknown'
}

export interface ResolveTrackerBindingArgs {
  /** `ticketing.tracker` from the job's policy snapshot. */
  policyTracker: string
  /** `job.params.tracker`, when the job (or its source ticket) named one. */
  jobTracker?: string
  /** Provider of the job's source ticket, used to break ties between MCP candidates. */
  preferProvider?: string
  registry: Pick<PluginRegistry, 'resolveTracker'>
  inventory?: McpInventory
}

export function listMcpTrackerCandidates(inventory: McpInventory | undefined): Array<{ binding: TrackerBinding; profile: TrackerMcpProfile }> {
  const out: Array<{ binding: TrackerBinding; profile: TrackerMcpProfile }> = []
  for (const server of inventory?.servers ?? []) {
    const profile = matchTrackerProfile(server)
    if (profile) out.push({ binding: mcpTrackerBinding(server, profile), profile })
  }
  return out
}

function bindSelector(
  selector: string,
  args: ResolveTrackerBindingArgs,
  candidates: TrackerBinding[],
): TrackerResolution {
  if (isMcpTrackerSelector(selector)) {
    const wanted = selector.slice(MCP_TRACKER_PREFIX.length)
    const server = args.inventory?.servers.find(s => serverMatchesSelector(s, wanted))
    if (!server) {
      return { candidates, reason: `MCP server "${wanted}" is not attached to this session` }
    }
    const binding = mcpTrackerBinding(server, matchTrackerProfile(server))
    if (!usable(server.status)) {
      return { candidates, reason: `MCP server "${server.name}" is ${server.status}` }
    }
    return { binding, candidates, reason: `pinned to ${selector}` }
  }
  try {
    const plugin = args.registry.resolveTracker({ tracker: selector })
    return { binding: pluginTrackerBinding(plugin), candidates, reason: `pinned to plugin "${selector}"` }
  } catch (err) {
    return { candidates, reason: (err as Error).message }
  }
}

export function resolveTrackerBinding(args: ResolveTrackerBindingArgs): TrackerResolution {
  const all = listMcpTrackerCandidates(args.inventory)
  const candidates = all.map(c => c.binding)

  if (args.policyTracker === 'none') return { candidates, reason: 'ticketing.tracker is "none"' }
  if (args.policyTracker !== 'auto') return bindSelector(args.policyTracker, args, candidates)
  if (args.jobTracker) return bindSelector(args.jobTracker, args, candidates)

  try {
    const plugin = args.registry.resolveTracker({})
    return { binding: pluginTrackerBinding(plugin), candidates, reason: `tracker plugin "${plugin.manifest.id}"` }
  } catch {
    // No unambiguous plugin; fall through to MCP servers.
  }

  let pool = all.filter(c => c.profile.autoSelect && usable(c.binding.status))
  if (args.preferProvider && pool.some(c => c.profile.provider === args.preferProvider)) {
    pool = pool.filter(c => c.profile.provider === args.preferProvider)
  }
  if (pool.length === 1) {
    const only = pool[0]!.binding
    return { binding: only, candidates, reason: `only connected tracker MCP server (${only.id})` }
  }
  if (pool.length > 1) {
    return {
      candidates,
      reason:
        `several tracker MCP servers are connected (${pool.map(c => c.binding.selector).join(', ')}); ` +
        'set ticketing.tracker to pick one',
    }
  }
  const waiting = all.filter(c => c.profile.autoSelect && !usable(c.binding.status))
  return {
    candidates,
    reason: waiting.length > 0
      ? `no connected tracker; ${waiting.map(c => `${c.binding.id} is ${c.binding.status}`).join(', ')}`
      : 'no tracker plugin or tracker MCP server found',
  }
}

/**
 * The redirect a generic `tracker_*` tool returns when the job's tracker is
 * an MCP server: which bound tool to call instead, and with what.
 */
export function mcpTrackerRedirect(
  binding: TrackerBinding,
  op: RedirectOp,
  args: RedirectArgs,
): { tool: string; args: Record<string, unknown> } | undefined {
  const tool = binding.tools[op]
  if (!tool) return undefined
  const profile = binding.profileId ? profileById(binding.profileId) : undefined
  const shaped = profile?.args?.[op]?.(args) ?? { key: args.key, ...(args.body ? { body: args.body } : {}), ...(args.status ? { status: args.status } : {}) }
  return { tool, args: shaped }
}

const TRACKER_PROFILES_BY_ID = new Map(TRACKER_MCP_PROFILES.map(p => [p.id, p]))

function profileById(id: string): TrackerMcpProfile | undefined {
  return TRACKER_PROFILES_BY_ID.get(id)
}

/** Map a plugin id or source-ticket plugin id to the provider family profiles use. */
export function providerOf(trackerId: string | undefined): string | undefined {
  if (!trackerId) return undefined
  if (trackerId === 'jira' || trackerId === 'linear' || trackerId === 'github-issues') return trackerId
  return undefined
}
