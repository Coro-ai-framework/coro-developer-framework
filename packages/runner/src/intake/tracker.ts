// ── Plan-mode tracker access ─────────────────────────────────────────────────
//
// Plan mode reads tickets and never changes them. The job that plan mode
// dispatches owns every ticket update, following the ticketing policy, so a
// comment or transition made mid-investigation would be one the policy never
// asked for and nobody can see in the run.
//
// For an MCP-bound tracker this means: its read tools are pre-approved (and
// its server attached) when `read.planMode` is on, and every tracker write
// tool — the bound one's and any other tracker-shaped server's — is refused.

import { isClaudeAiConnectorToolName, type PhaseExecutorRuntime, type PluginMcpServerConfig } from '@coro-ai/plugin-sdk'
import type { Logger } from 'pino'
import { ticketingWritesEnabled, type ResolvedTicketingPolicy } from '../config/ticketing'
import { CLAUDE_AI_SERVER_ID } from './permissions'
import type { PluginRegistry } from '../plugins/registry'
import { resolveJobTracker } from '../trackers/resolve-job'
import type { TrackerBinding, TrackerResolution } from '../trackers/binding'
import type { TrackerOp } from '../trackers/profiles'

export const PLAN_MODE_TRACKER_WRITE_REASON =
  'Plan mode does not change tickets. The dispatched job makes ticket updates per the team\'s ticketing policy; ' +
  'if the developer wants something different for this run, put it in the run\'s "ticketing" field.'

export const PLAN_MODE_TRACKER_READ_OFF_REASON =
  'Ticket reads are turned off for plan mode (ticketing.read.planMode). Ask the developer to paste what you need.'

export interface IntakeTrackerPrompt {
  displayName: string
  source: 'plugin' | 'mcp'
  /** Value for `trackerRef.pluginId` on the run. */
  refId: string
  /** MCP tools by operation, for an MCP-bound tracker with reads on. */
  readTools: Partial<Record<TrackerOp, string>>
  notes: string[]
  readsOff: boolean
  writesEnabled: boolean
  createSourceTicket: ResolvedTicketingPolicy['createSourceTicket']['mode']
}

export interface IntakeTrackerAccess {
  resolution: TrackerResolution
  blockedTools: Map<string, string>
  preApprovedTools: Set<string>
  /** A configured MCP server the binding lives on, attached even when its access is off. */
  attachServerId?: string
  /**
   * The plan-mode access id gating the bound server's tools (`claude_ai` for
   * connectors). A conversation that set it to off keeps it off.
   */
  accessId?: string
  prompt?: IntakeTrackerPrompt
}

export function planIntakeTrackerAccess(
  policy: ResolvedTicketingPolicy,
  resolution: TrackerResolution,
  configuredServerIds: ReadonlySet<string>,
): IntakeTrackerAccess {
  const blockedTools = new Map<string, string>()
  const preApprovedTools = new Set<string>()
  const binding = resolution.binding
  const readsOn = policy.read.planMode

  const mcpTrackers: TrackerBinding[] = [
    ...resolution.candidates.filter(c => c.source === 'mcp'),
    ...(binding?.source === 'mcp' && !resolution.candidates.some(c => c.id === binding.id) ? [binding] : []),
  ]
  for (const tracker of mcpTrackers) {
    for (const tool of tracker.writeTools) blockedTools.set(tool, PLAN_MODE_TRACKER_WRITE_REASON)
  }

  let attachServerId: string | undefined
  let accessId: string | undefined
  if (binding?.source === 'mcp') {
    accessId = configuredServerIds.has(binding.id)
      ? binding.id
      : binding.readTools.concat(binding.writeTools).some(isClaudeAiConnectorToolName) ? CLAUDE_AI_SERVER_ID : undefined
    if (readsOn) {
      for (const tool of binding.readTools) preApprovedTools.add(tool)
      if (configuredServerIds.has(binding.id)) attachServerId = binding.id
    } else {
      for (const tool of binding.readTools) blockedTools.set(tool, PLAN_MODE_TRACKER_READ_OFF_REASON)
    }
  }

  return {
    resolution,
    blockedTools,
    preApprovedTools,
    ...(attachServerId ? { attachServerId } : {}),
    ...(accessId ? { accessId } : {}),
    ...(binding
      ? {
          prompt: {
            displayName: binding.displayName,
            source: binding.source,
            refId: binding.source === 'mcp' ? binding.selector : binding.id,
            readTools: binding.source === 'mcp' && readsOn ? readToolsOf(binding) : {},
            notes: binding.source === 'mcp' ? binding.notes : [],
            readsOff: !readsOn,
            writesEnabled: ticketingWritesEnabled(policy),
            createSourceTicket: policy.createSourceTicket.mode,
          },
        }
      : {}),
  }
}

function readToolsOf(binding: TrackerBinding): Partial<Record<TrackerOp, string>> {
  const out: Partial<Record<TrackerOp, string>> = {}
  for (const [op, tool] of Object.entries(binding.tools) as Array<[TrackerOp, string]>) {
    if (binding.readTools.includes(tool)) out[op] = tool
  }
  return out
}

export async function resolveIntakeTrackerAccess(args: {
  policy: ResolvedTicketingPolicy
  registry: Pick<PluginRegistry, 'resolveTracker'>
  executor?: Pick<PhaseExecutorRuntime, 'inspectMcpServers' | 'manifest'>
  userMcpServers: Record<string, PluginMcpServerConfig>
  cwd: string
  logger: Logger
}): Promise<IntakeTrackerAccess> {
  const resolution = await resolveJobTracker({
    job: { params: { ticketingPolicy: args.policy } },
    registry: args.registry,
    ...(args.executor ? { executor: args.executor } : {}),
    pluginMcpServers: args.userMcpServers,
    cwd: args.cwd,
    logger: args.logger,
  })
  return planIntakeTrackerAccess(args.policy, resolution, new Set(Object.keys(args.userMcpServers)))
}
