import fs from 'fs/promises'
import path from 'path'
import { Logger } from 'pino'
import type { Settings } from '../config/settings'
import type { TrackerClient, TrackerProvider } from '../clients/tracker'
import type { PluginRegistry } from '../plugins/registry'
import { Job } from '../jobs/types'
import { parseWorkflowConfig, stripFrontMatter, getPhaseConfig } from '../workflow-parser'

// ── Tracker prompt context ────────────────────────────────────────────────────
//
// Surfaced into the system prompt so agents — chiefly the campaign-planner —
// have a deterministic signal for whether to call any tracker tool (the
// generic `tracker_*` proxy *or* the active plugin's native
// `mcp__<pluginId>__*` tools). Prior to this, the prompt carried no tracker
// information at all and the agent could only discover availability by
// issuing a *destructive* call (e.g. `mcp__jira__jira_create_issue` would
// actually create an issue on success), so it played safe and skipped the
// tracker branch even when the tenant had wired up GitHub Issues / Jira /
// Linear. See campaign-planner.md §3 for the agent-side decision rule that
// keys off this struct.

export interface TrackerPromptContext {
  /**
   * Effective tracker provider as the user sees it. Mirrors
   * `settings.tracker.provider` when set explicitly; falls back to
   * `'none'` when no tracker is wired up so the agent never has to
   * reason about the JiraTrackerClient stub the factory returns when
   * everything is empty.
   */
  provider: TrackerProvider | 'none'
  /** True when `trackerClient.isAvailable()` — i.e. tool calls will hit a real backend. */
  available: boolean
  /**
   * Provider-specific defaults the agent can plug straight into tool args.
   * Keys are intentionally provider-specific (`owner` for GitHub,
   * `teamKey` for Linear) so the agent prompt can read the value
   * unambiguously without per-provider branches in code.
   */
  defaults?: Record<string, string>
}

/**
 * Build the prompt-side view of the tracker stack from the runtime
 * `Settings` + the constructed `TrackerClient`. Pure — safe to call
 * once per phase without I/O.
 */
export function computeTrackerPromptContext(
  settings: Settings,
  trackerClient: TrackerClient,
): TrackerPromptContext {
  const available = trackerClient.isAvailable()
  // `settings.tracker.provider` is the user's explicit choice from the
  // dashboard. When unset we trust the client's `provider` field only if
  // it actually resolved to a usable backend; otherwise we report `'none'`
  // so the agent doesn't see a misleading `'jira'` from the empty stub.
  const provider: TrackerProvider | 'none' = settings.tracker?.provider
    ?? (available ? trackerClient.provider : 'none')

  const defaults: Record<string, string> = {}
  if (provider === 'github' && settings.github.owner) {
    defaults['owner'] = settings.github.owner
  }
  if (provider === 'linear' && settings.linear?.teamKey) {
    defaults['teamKey'] = settings.linear.teamKey
  }

  return {
    provider,
    available,
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
  }
}

// ── SCM prompt context ───────────────────────────────────────────────────────

export interface ScmPromptContext {
  available: boolean
  resolved: string | 'none'
  requested?: string
  default?: string
  installed: string[]
}

export function computeScmPromptContext(
  job: Job,
  plugins: PluginRegistry,
): ScmPromptContext {
  const requested = typeof job.params['scm'] === 'string' && job.params['scm'].length > 0
    ? job.params['scm'] as string
    : undefined
  const defaults = plugins.getDefaults()
  const installed = plugins.byKind('scm').map(plugin => plugin.manifest.id).sort()

  try {
    const resolved = plugins.resolveScm(requested ? { scm: requested } : {})
    return {
      available: true,
      resolved: resolved.manifest.id,
      ...(requested ? { requested } : {}),
      ...(defaults.scm ? { default: defaults.scm } : {}),
      installed,
    }
  } catch {
    return {
      available: false,
      resolved: 'none',
      ...(requested ? { requested } : {}),
      ...(defaults.scm ? { default: defaults.scm } : {}),
      installed,
    }
  }
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Assembles the system prompt for a Claude API call.
 *
 * The prompt is intentionally lean — just the ambient context the agent needs
 * before it can decide what to do next. Anything the agent might *not* need
 * every turn (memory, proposals, domain skills) is loaded on-demand via MCP
 * tools (`read_memory`, `list_proposals`) and native SDK skills.
 *
 * Sections included (in order):
 *   1. Workflow file      — phase list + high-level workflow prose
 *   2. Agent instructions — role-specific steps for the current phase
 *   3. Job context        — current job state as JSON, plus insights if any
 *
 * Static ambient content (behaviour rules, git conventions, infra context)
 * is loaded natively by the SDK via `settingSources: ['project']` from
 * `.claude/CLAUDE.md`. The intelligence repo is pulled once per job in the runner,
 * not per phase, so this function never does network I/O.
 */
/**
 * @param intelligenceDir Per-job intelligence overlay produced by
 *   {@link resolveJobIntelligence}. The runner passes its resolved path
 *   here so workflow + agent reads see the correct stack of layers
 *   (base → tenant → repo) for this specific job.
 */
export async function buildSystemPrompt(
  job: Job,
  intelligenceDir: string,
  logger: Logger,
  trackerInfo?: TrackerPromptContext,
  scmInfo?: ScmPromptContext,
): Promise<string> {
  const sections: string[] = []

  const workflowAbsPath = path.join(intelligenceDir, job.workflowPath)
  const workflowMd = await readSafe(workflowAbsPath, logger)
  const workflowConfig = workflowMd ? parseWorkflowConfig(workflowMd) : null

  if (workflowMd) {
    sections.push(banner('Current Workflow', job.workflowPath) + stripFrontMatter(workflowMd))
  } else {
    logger.warn({ workflowPath: job.workflowPath }, 'Workflow file not found — continuing without it')
  }

  const phaseConf = workflowConfig ? getPhaseConfig(workflowConfig, job.phase) : null
  const agentRelPath = phaseConf?.agent ?? null
  if (agentRelPath) {
    const agentMd = await readSafe(path.join(intelligenceDir, agentRelPath), logger)
    if (agentMd) {
      sections.push(banner('Your Role This Phase', agentRelPath) + agentMd)
    } else {
      logger.warn({ agentRelPath, phase: job.phase }, 'Agent file not found — skipping')
    }
  }

  sections.push(buildJobContext(job, trackerInfo, scmInfo))

  return sections.join('\n\n---\n\n')
}

// ── Job context ───────────────────────────────────────────────────────────────

function buildJobContext(job: Job, trackerInfo?: TrackerPromptContext, scmInfo?: ScmPromptContext): string {
  const context: Record<string, unknown> = {
    jobId: job.id,
    type: job.type,
    workflowPath: job.workflowPath,
    interactive: job.interactive,
    params: job.params,
    triggerSource: job.triggerSource,
    status: job.status,
    phase: job.phase,
    currentWorkItem: job.currentWorkItem,
    workItems: job.workItems,
    workItemLoopCount: job.workItemLoopCount,
    prMappings: job.prMappings,
    awaitingEvent: job.awaitingEvent ?? null,
    awaitingPrId: job.awaitingPrId ?? null,
    awaitingNextPhase: job.awaitingNextPhase ?? null,
    approvedAdvanceFromPhase: job.approvedAdvanceFromPhase ?? null,
    escalationMessage: job.escalationMessage ?? null,
  }

  // Surface tracker availability so agents (campaign-planner today, others
  // later) get a deterministic signal instead of having to probe with
  // destructive tool calls. We only set the key when the runner has computed
  // a context — tests that exercise the builder in isolation may skip it.
  if (trackerInfo) {
    context['tracker'] = trackerInfo
  }
  if (scmInfo) {
    context['scm'] = scmInfo
  }

  const parts = [
    '# Current Job\n\n' +
    'This is the job you are currently executing. ' +
    'All your actions must stay within the scope of this job.\n\n' +
    '```json\n' +
    JSON.stringify(context, null, 2) +
    '\n```',
  ]

  if (job.insights && job.insights.length > 0) {
    // Surface sibling provenance prominently so the agent can tell
    // sibling-inherited insights apart from this job's own. Sibling
    // insights are *fresher and more directly applicable* than memory
    // entries because they were discovered against the same target
    // repo, sandbox, and tenant minutes earlier — agents are
    // instructed to read them before consulting memory/known-pitfalls.
    const insightLines = job.insights.map((ins, i) => {
      const provenance = ins.sourceChildName
        ? `[campaign sibling: ${ins.sourceChildName} · ${ins.phase}]`
        : `[${ins.phase}]`
      return (
        `### ${i + 1}. ${provenance} ${ins.category}\n` +
        `**Summary:** ${ins.summary}\n` +
        `**Detail:** ${ins.detail}` +
        (ins.suggestion ? `\n**Suggestion:** ${ins.suggestion}` : '')
      )
    })
    const hasSiblingInsights = job.insights.some(i => i.sourceChildName)
    const lead = hasSiblingInsights
      ? 'The following learnings were recorded by earlier campaign siblings AND by upstream phases on this job. ' +
        'Sibling-inherited entries (marked `[campaign sibling: …]`) are fresher than memory and apply directly to ' +
        'this exact campaign — read them before doing anything else, and follow the recipes literally. '
      : 'The following learnings were recorded by agents during earlier phases. '
    parts.push(
      '\n\n## Insights from Upstream Agents\n\n' +
      lead +
      'Each represents a discovery, workaround, or pattern that may warrant a self-improvement ' +
      'proposal via `propose_change`.\n\n' +
      insightLines.join('\n\n'),
    )
  }

  return parts.join('')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readSafe(filePath: string, logger: Logger): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      logger.debug({ filePath }, 'File not found — skipping')
    } else {
      logger.warn({ filePath, code }, 'Could not read file — skipping')
    }
    return null
  }
}

function banner(label: string, source: string): string {
  return `# ${label}\n*Source: ${source}*\n\n`
}
