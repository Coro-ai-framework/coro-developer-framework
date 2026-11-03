import type { Job } from '@coro-ai/cloud-protocol'
import type { PhaseExecutorRuntime, PluginMcpServerConfig } from '@coro-ai/plugin-sdk'
import type { Logger } from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import { readTicketingPolicy, sourceTicketOf } from '../jobs/ticketing'
import { getMcpInventory, type McpInventory } from './inventory'
import {
  isMcpTrackerSelector,
  providerOf,
  resolveTrackerBinding,
  type TrackerResolution,
} from './binding'

export interface ResolveJobTrackerArgs {
  job: Pick<Job, 'params'>
  registry: Pick<PluginRegistry, 'resolveTracker'>
  executor?: Pick<PhaseExecutorRuntime, 'inspectMcpServers' | 'manifest'>
  pluginMcpServers: Record<string, PluginMcpServerConfig>
  cwd: string
  logger: Logger
  refresh?: boolean
  /** Take the inventory even when a plugin answers, so every candidate is listed. */
  alwaysInventory?: boolean
}

/**
 * Whether resolving needs to look at MCP servers at all. A plugin that
 * already answers keeps the job from paying for an inventory probe.
 */
function needsInventory(policyTracker: string, jobTracker: string | undefined, registry: ResolveJobTrackerArgs['registry']): boolean {
  if (policyTracker === 'none') return false
  if (policyTracker !== 'auto') return isMcpTrackerSelector(policyTracker)
  if (jobTracker) return isMcpTrackerSelector(jobTracker)
  try {
    registry.resolveTracker({})
    return false
  } catch {
    return true
  }
}

export async function resolveJobTracker(args: ResolveJobTrackerArgs): Promise<TrackerResolution> {
  const policyTracker = readTicketingPolicy(args.job)?.tracker ?? 'auto'
  const rawJobTracker = args.job.params['tracker']
  const jobTracker = typeof rawJobTracker === 'string' && rawJobTracker.trim() ? rawJobTracker.trim() : undefined
  const ticket = sourceTicketOf(args.job.params)
  const preferProvider = providerOf(ticket?.pluginId)

  let inventory: McpInventory | undefined
  if (args.alwaysInventory || needsInventory(policyTracker, jobTracker, args.registry)) {
    try {
      inventory = await getMcpInventory({
        ...(args.executor ? { executor: args.executor } : {}),
        pluginMcpServers: args.pluginMcpServers,
        cwd: args.cwd,
        logger: args.logger,
        ...(args.refresh ? { refresh: true } : {}),
      })
    } catch (err) {
      args.logger.warn({ err }, 'MCP inventory failed; resolving tracker without it')
    }
  }

  return resolveTrackerBinding({
    policyTracker,
    ...(jobTracker ? { jobTracker } : {}),
    ...(preferProvider ? { preferProvider } : {}),
    registry: args.registry,
    ...(inventory ? { inventory } : {}),
  })
}

/** One line for the activity log. */
export function describeTrackerResolution(resolution: TrackerResolution): string {
  const b = resolution.binding
  if (b) return `Tracker: ${b.displayName} (${b.selector}) — ${resolution.reason}`
  return `Tracker: none — ${resolution.reason}`
}
