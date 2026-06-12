import fs from 'fs/promises'
import path from 'path'
import { Logger } from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import type { TrackerPluginRuntime } from '../plugins/types'
import { Job } from '@coro-ai/cloud-protocol'
import type { Insight } from '@coro-ai/cloud-protocol'
import { propagableInsights } from '../insights'
import {
  buildWorkspaceLayoutPromptBlock,
  resolveJobWorkspaceLayout,
} from '../jobs/workspace-layout'
import { parseWorkflowConfig, stripFrontMatter, getPhaseConfig } from '../workflow-parser'
import type { LocalConfig } from '../config/local-config'
import { resolveGuardrails } from '../guardrails/merge'

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
//
// The plugin registry is the single source of truth: if a tracker plugin
// resolves cleanly, `tracker.available === true` and `tracker.pluginId`
// carries its manifest id (`jira`, `linear`, `github-issues`, …). Agents
// branch on `tracker.pluginId` — see `campaign-planner.md` §3 and
// `campaign-planning/SKILL.md`.

export interface TrackerPromptContext {
  /** True when a tracker plugin resolves; agents key every tracker step off this. */
  available: boolean
  /**
   * Plugin manifest id of the active tracker, or `'none'` when no
   * tracker plugin resolves. Agent docs reference this as
   * `tracker.pluginId` (`'jira'`, `'linear'`, `'github-issues'`, …).
   */
  pluginId: string
  /**
   * Provider-specific defaults the agent can plug straight into tool args.
   * Sourced from the active plugin's optional `promptDefaults()` —
   * keys are intentionally provider-specific (`owner` for GitHub Issues,
   * `teamKey` for Linear) so the agent prompt can reference them
   * unambiguously without per-provider branches in code.
   */
  defaults?: Record<string, string>
}

/**
 * Build the prompt-side view of the tracker stack from the
 * {@link PluginRegistry}. Pure — safe to call once per phase without I/O.
 *
 * Resolution rules:
 *   - One tracker plugin installed → that plugin wins.
 *   - Multiple installed → `plugins.defaults.tracker` chooses; absent
 *     defaults surface as a `PluginResolutionError` which we catch and
 *     report as `available: false` so the agent degrades gracefully
 *     instead of crashing the prompt build.
 *   - Zero installed → `available: false`, `pluginId: 'none'`.
 */
export function computeTrackerPromptContext(plugins: PluginRegistry): TrackerPromptContext {
  let runtime: TrackerPluginRuntime | undefined
  try {
    runtime = plugins.resolveTracker({})
  } catch {
    // Either nothing is installed or the choice is ambiguous and no
    // default is configured. Either way, the agent sees "no tracker".
    return { available: false, pluginId: 'none' }
  }

  const defaults = runtime.promptDefaults?.()
  return {
    available: true,
    pluginId: runtime.manifest.id,
    ...(defaults && Object.keys(defaults).length > 0 ? { defaults } : {}),
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
  const repoSlug = typeof job.params['repoSlug'] === 'string' ? (job.params['repoSlug'] as string) : undefined
  const defaults = plugins.getDefaults()
  const installed = plugins.byKind('scm').map(plugin => plugin.manifest.id).sort()

  try {
    // Prefer URL-based disambiguation when the job carries a repo URL
    // and no explicit `scm` override — otherwise the rendered context
    // can advertise the wrong plugin to the agent (e.g. github URL +
    // bitbucket default → prompt says "scm: bitbucket").
    let resolved
    if (!requested && repoSlug && repoSlug.includes('://')) {
      resolved = plugins.resolveByRemote(repoSlug) ?? plugins.resolveScm({})
    } else {
      resolved = plugins.resolveScm(requested ? { scm: requested } : {})
    }
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

// ── Guardrails prompt context ─────────────────────────────────────────────────

export interface GuardrailsPromptRule {
  id: string
  on: string
  check: string
  enabled: boolean
  during?: string[]
  config?: Record<string, unknown>
}

export interface GuardrailsPromptContext {
  enabled: boolean
  rules: GuardrailsPromptRule[]
}

/** Effective runner guardrails for the job-context JSON block. */
export function computeGuardrailsPromptContext(
  config?: LocalConfig | null,
): GuardrailsPromptContext {
  const { resolved } = resolveGuardrails(config?.guardrails ?? null)
  return {
    enabled: resolved.enabled,
    rules: resolved.rules.map(rule => ({
      id: rule.id,
      on: rule.on,
      check: rule.check,
      enabled: rule.enabled !== false,
      ...(rule.during?.length ? { during: rule.during } : {}),
      ...(rule.config && Object.keys(rule.config).length > 0 ? { config: rule.config } : {}),
    })),
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
 * @param executorCapabilities Capability descriptor for the phase
 *   executor that will run this prompt. Optional — when undefined the
 *   builder preserves its historical behaviour and assumes the
 *   Anthropic SDK's native `.claude/CLAUDE.md` walk-up will inject the
 *   ambient runtime instructions. When the caller passes a descriptor
 *   whose `supportsClaudeMdNativeWalkUp` is `false` (any non-Anthropic
 *   executor), the builder prepends the resolved overlay's
 *   `.claude/CLAUDE.md` directly so the model sees the same ambient
 *   guidance regardless of provider.
 */
export async function buildSystemPrompt(
  job: Job,
  intelligenceDir: string,
  logger: Logger,
  trackerInfo?: TrackerPromptContext,
  scmInfo?: ScmPromptContext,
  guardrailsInfo?: GuardrailsPromptContext,
  executorCapabilities?: { supportsClaudeMdNativeWalkUp: boolean },
  jobWorkingDir?: string,
): Promise<string> {
  const sections: string[] = []

  // When the active executor cannot natively walk `.claude/CLAUDE.md`
  // up the directory tree (everything except the Anthropic SDK), inject
  // the per-job overlay's CLAUDE.md as the first system block. The
  // resolver guarantees the file exists at the layered intelligence
  // root for every tenant; if it is missing we log and continue so a
  // partial overlay never crashes the prompt build.
  if (executorCapabilities && !executorCapabilities.supportsClaudeMdNativeWalkUp) {
    const claudeMdPath = path.join(intelligenceDir, '.claude', 'CLAUDE.md')
    const claudeMd = await readSafe(claudeMdPath, logger)
    if (claudeMd) {
      sections.push(banner('Ambient Runtime Instructions', '.claude/CLAUDE.md') + claudeMd)
    } else {
      logger.warn(
        { claudeMdPath },
        'Executor lacks native CLAUDE.md walk-up but the overlay has no .claude/CLAUDE.md to inject',
      )
    }
  }

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

  if (jobWorkingDir) {
    sections.push(
      buildWorkspaceLayoutPromptBlock(resolveJobWorkspaceLayout(job, jobWorkingDir)),
    )
  }

  sections.push(buildJobContext(job, trackerInfo, scmInfo, guardrailsInfo, jobWorkingDir))

  return sections.join('\n\n---\n\n')
}

// ── Job context ───────────────────────────────────────────────────────────────

function buildJobContext(
  job: Job,
  trackerInfo?: TrackerPromptContext,
  scmInfo?: ScmPromptContext,
  guardrailsInfo?: GuardrailsPromptContext,
  jobWorkingDir?: string,
): string {
  const workspace = jobWorkingDir
    ? resolveJobWorkspaceLayout(job, jobWorkingDir)
    : undefined

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
    ...(workspace
      ? {
          workspace: {
            jobWorkingDir: workspace.jobWorkingDir,
            repoCheckoutDir: workspace.repoCheckoutDir ?? null,
            repoCheckoutAbsDir: workspace.repoCheckoutAbsDir ?? null,
          },
        }
      : {}),
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
  if (guardrailsInfo) {
    context['guardrails'] = guardrailsInfo
  }

  const parts = [
    '# Current Job\n\n' +
    'This is the job you are currently executing. ' +
    'All your actions must stay within the scope of this job.\n\n' +
    '```json\n' +
    JSON.stringify(context, null, 2) +
    '\n```',
  ]

  // Campaign parents accumulate their children's insights on
  // `campaignAggregatedInsights` — the dispatcher seeds those into each
  // *future* child via `initialInsights`, but the parent's own
  // post-coordination phases (campaign-integration, aggregation) read this
  // prompt too. Merge them in so the integrator/evaluator benefits from
  // every quirk the children already documented instead of re-discovering
  // them. Dedup defensively: an insight may exist on both lists when an
  // earlier phase already copied it onto the parent.
  const ownInsights = job.insights ?? []
  const aggregatedInsights = job.campaignAggregatedInsights ?? []
  const insightKey = (i: Insight): string =>
    i.id ?? `${i.sourceChildName ?? ''}|${i.phase}|${i.summary}`
  const seenInsightKeys = new Set(ownInsights.map(insightKey))
  const mergedInsights = [...ownInsights]
  for (const ins of aggregatedInsights) {
    const key = insightKey(ins)
    if (seenInsightKeys.has(key)) continue
    seenInsightKeys.add(key)
    mergedInsights.push(ins)
  }

  const insightsForPrompt = propagableInsights(mergedInsights)
  if (insightsForPrompt.length > 0) {
    // Surface sibling provenance prominently so the agent can tell
    // sibling-inherited insights apart from this job's own. Sibling
    // insights are *fresher and more directly applicable* than memory
    // entries because they were discovered against the same target
    // repo, sandbox, and tenant minutes earlier — agents are
    // instructed to read them before consulting memory/known-pitfalls.
    //
    // Rejected insights stay on the job for audit but are omitted here
    // and at campaign sibling copy — they must not steer agents or
    // downstream children. We surface curation state (status, edits,
    // layer override) for the entries that remain.
    const counts = { pending: 0, approved: 0, rejected: 0 }
    for (const ins of insightsForPrompt) counts[(ins.status ?? 'pending')]++

    const insightLines = insightsForPrompt.map((ins, i) => {
      const provenance = ins.sourceChildName
        ? `[campaign sibling: ${ins.sourceChildName} · ${ins.phase}]`
        : `[${ins.phase}]`
      const status = ins.status ?? 'pending'
      const userOverrode = Boolean(ins.editedSummary || ins.editedDetail || ins.editedSuggestion)
      const summary = ins.editedSummary ?? ins.summary
      const detail = ins.editedDetail ?? ins.detail
      const suggestion = ins.editedSuggestion ?? ins.suggestion
      const layerLine = ins.userLayer
        ? `\n**Layer (user-assigned):** ${ins.userLayer}`
        : ins.suggestedLayer
          ? `\n**Layer (agent-suggested):** ${ins.suggestedLayer}`
          : ''
      const editLine = userOverrode ? `\n**Edited by user:** yes — prefer the fields above` : ''
      return (
        `### ${i + 1}. [status: ${status}] ${provenance} ${ins.category}\n` +
        `**Summary:** ${summary}\n` +
        `**Detail:** ${detail}` +
        (suggestion ? `\n**Suggestion:** ${suggestion}` : '') +
        layerLine +
        editLine
      )
    })
    const hasSiblingInsights = insightsForPrompt.some(i => i.sourceChildName)
    const siblingLead = hasSiblingInsights
      ? 'The following learnings were recorded by earlier campaign siblings AND by upstream phases on this job. ' +
        'Sibling-inherited entries (marked `[campaign sibling: …]`) are fresher than memory and apply directly to ' +
        'this exact campaign — read them before doing anything else, and follow the recipes literally. '
      : 'The following learnings were recorded by agents during earlier phases. '
    const curationLead =
      `\n\n**User curation summary:** ${counts.approved} approved · ${counts.pending} pending · ${counts.rejected} rejected. ` +
      `If you are the evaluator, treat \`status\` as the user's explicit decision: ship only \`approved\` entries ` +
      `(preferring any edited Summary/Detail/Suggestion), skip \`rejected\` entirely, and skip \`pending\` while ` +
      `reporting the count in your evaluation. If no entries are \`approved\`, do not open a self-improvement PR. ` +
      `Route each approved entry by \`Layer (user-assigned)\` when present, else \`Layer (agent-suggested)\`, ` +
      `else your own path-prefix judgement.`
    parts.push(
      '\n\n## Insights from Upstream Agents\n\n' +
      siblingLead +
      'Each represents a discovery, workaround, or pattern that may warrant a self-improvement ' +
      'proposal via `propose_change`.' +
      curationLead +
      '\n\n' +
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
