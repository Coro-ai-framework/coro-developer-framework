import {
  query,
  type HookCallback,
  type HookJSONOutput,
  type McpServerConfig,
  type McpSdkServerConfig,
  type McpSetServersResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'fs'
import { Logger } from 'pino'
import { ChildProcess } from 'child_process'
import path from 'path'
import { BitBucketClient } from '../clients/bitbucket'
import { GitHubClient } from '../clients/github'
import { GitClient } from '../clients/git'
import { JiraClient } from '../clients/jira'
import { LokiClient } from '../clients/loki'
import { TempoClient } from '../clients/tempo'
import type { TrackerClient } from '../clients/tracker'
import { Settings } from '../config/settings'
import {
  defaultLoaderCacheRoot,
  discoverClaudeCodeMcpServers,
  loadLocalConfig,
  type UserMcpServerConfig,
} from '../config/local-config'
import {
  resolveJobIntelligence,
  type ResolvedIntelligence,
} from '../intelligence/resolver'
import type { TenantContext } from '../intelligence/tenant-context'
import type { PluginRegistry } from '../plugins/registry'
import { buildSystemPrompt, computeScmPromptContext, computeTrackerPromptContext } from '../prompt/builder'
import { createCoroMcpServer } from '../mcp-server'
import { ToolContext, PhaseSignals } from '../tools/types'
import {
  loadWorkflowConfigFromRoots,
  getNextPhase as wfGetNextPhase,
  getPhaseConfig,
  SubagentConfig,
  type WorkflowConfig,
} from '../workflow-parser'
import type { StateBackend } from '../state/backend'
import {
  Job,
  STATUS_COMPLETE,
  STATUS_FAILED,
  STATUS_AWAITING_CHILDREN,
  STATUS_AWAITING_PLAN_APPROVAL,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_DEVELOPER_INPUT,
  isCampaignJob,
  isParkingStatus,
  isTerminalStatus,
  TokenUsage,
  PhaseUsage,
  emptyTokenUsage,
} from './types'
import { assertJobPluginRequirements } from './plugin-preflight'
import { ensureClaudeCodeCliExecutable, resolveClaudeCodeCliPath } from '../claude-code-path'

// ── Runner context ────────────────────────────────────────────────────────────

export interface RunnerContext {
  stateBackend: StateBackend
  settings: Settings
  /**
   * Identifies which tenant (solo developer or team) this runner instance
   * is acting on behalf of. The intelligence resolver and the
   * proposal-routing layer use it to scope reads and writes correctly.
   *
   * Synthesized at runner bootstrap (`solo-<host>` for solo deployments,
   * `team-<teamId>` for hybrid). Process-scoped — every job dispatched
   * by this runner shares the same tenant context.
   */
  tenantContext: TenantContext
  gitClient: GitClient
  bbCoder: BitBucketClient
  bbReviewer: BitBucketClient
  ghClient: GitHubClient | null
  ghGitClient: GitClient | null
  lokiClient: LokiClient
  tempoClient: TempoClient
  jiraClient: JiraClient
  /**
   * Active issue-tracker client (Jira today; GitHub Issues / Linear later).
   * Always present — falls back to a stub that reports `available=false`
   * from every method when no provider is configured.
   */
  trackerClient: TrackerClient
  /**
   * Resolved plugin registry. Owns the `scm_*` / `tracker_*` MCP
   * surface and all webhook normalisation. The legacy `bbCoder` /
   * `ghClient` / `jiraClient` / `trackerClient` fields stay populated
   * from the registry's built-in plugins for back-compat — they are
   * scheduled for removal at N+2 (see plan/§6/Phase 9).
   */
  plugins: PluginRegistry
  logger: Logger
}

/** Arguments passed to a test/injected `query` implementation. */
export interface QueryInvocation {
  prompt: string
  options: Record<string, unknown>
  signals: PhaseSignals
  /** Shared with MCP tools — same reference as the runner's live job state. */
  toolCtx: ToolContext
}

/**
 * Optional hooks for tests and future instrumentation.
 * Production code should omit this (defaults apply).
 */
export interface RunJobOptions {
  /**
   * Replace the Claude Agent SDK `query()` stream. Tests use this to simulate
   * model turns and set {@link PhaseSignals} without calling Anthropic.
   */
  queryImpl?: (inv: QueryInvocation) => AsyncIterable<unknown>
  /**
   * When set, skips `loadWorkflowConfig` from disk. Pass `null` for jobs with no workflow file.
   */
  workflowConfigOverride?: WorkflowConfig | null
  /**
   * Called when a real SDK Query is created. The dispatcher uses this to store
   * a reference for human message injection via Query.streamInput().
   */
  onQueryStart?: (jobId: string, query: Query) => void
  /**
   * Called when the SDK Query's for-await loop exits (phase done, signal, or error).
   * The dispatcher uses this to remove the Query reference.
   */
  onQueryEnd?: (jobId: string) => void
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run a job to completion (or until parked/escalated).
 *
 * The outer loop advances through phases. Each phase is a single `query()`
 * call to the Agent SDK — the SDK handles the full tool-use loop internally.
 * After each query completes, the runner checks the shared PhaseSignals to
 * decide whether to advance, park, or terminate.
 */
export async function runJob(job: Job, ctx: RunnerContext, options?: RunJobOptions): Promise<void> {
  const { stateBackend, settings, tenantContext, logger } = ctx

  const runningServices = new Map<string, ChildProcess>()

  // Pull the legacy intelligence checkout BEFORE materialising the per-job
  // overlay. In legacy / single-tenant deployments this is the upstream
  // company intelligence repo; pulling here keeps "company changes" fresh
  // on disk so Phase 4's tenant-overlay loader can pick them up. In Phase
  // 3 the resolver itself only stacks the base layer, so the pull is a
  // forward-compatible no-op for the SDK reads below.
  try {
    await ctx.gitClient.pull(settings.paths.coroIntelligenceDir)
    logger.debug(
      { jobId: job.id, coroIntelligenceDir: settings.paths.coroIntelligenceDir },
      'Pulled latest intelligence repo',
    )
  } catch (err) {
    logger.warn({ err }, 'Could not pull intelligence repo — using cached version on disk')
  }

  // Materialise a per-job intelligence overlay. The resolver stacks
  //   base  →  tenant overlay (per TenantContext)  →  repo overlay (.coro/)
  // and writes the merged result to `<workingDir>/<jobId>/_intelligence/`.
  //
  // From here on, every per-job markdown read inside this function and
  // the MCP tools resolves against `jobIntelligenceDir`, NOT the
  // process-wide `settings.paths.coroIntelligenceDir`.
  //
  // Repo overlay timing: the target repo is cloned during the workflow,
  // typically via `mcp__coro__scm_clone_repo`, so at the very first
  // resolve the repo dir typically does not exist yet. We pass
  // `repoCheckoutDir` based on `job.params.repoSlug`; the resolver
  // gracefully skips the layer when the path is missing. Per-phase
  // re-resolution (below) picks up the overlay as soon as the repo is
  // cloned.
  const repoCheckoutDir = deriveRepoCheckoutDir(job, settings.paths.workingDir)
  const loaderCacheRoot = defaultLoaderCacheRoot()

  const initialResolved: ResolvedIntelligence = await resolveJobIntelligence({
    baseLayerDir: settings.paths.baseLayerDir,
    tenantContext,
    jobId: job.id,
    workingRoot: settings.paths.workingDir,
    repoCheckoutDir,
    loaderCacheRoot,
    plugins: ctx.plugins,
    logger,
  })
  // The materialised path is stable across re-resolves (it's a function
  // of jobId + workingRoot), so `jobIntelligenceDir` can be captured
  // once. Per-phase calls below re-run the resolver to refresh CONTENTS.
  const jobIntelligenceDir = initialResolved.intelligenceDir

  const workflowConfig: WorkflowConfig | null =
    options?.workflowConfigOverride !== undefined
      ? options.workflowConfigOverride
      : job.workflowPath
        ? (await loadWorkflowConfigFromRoots(
            job.workflowPath,
            [jobIntelligenceDir, settings.paths.baseLayerDir],
            logger,
          ))?.config ?? null
        : null

  // A configured workflow that we can't resolve at runtime is a hard
  // failure. We also validate that the job's current phase is one we
  // know how to dispatch — otherwise the runner would burn planning-
  // tier tokens on a phantom phase with no agent role.
  if (job.workflowPath && !workflowConfig) {
    const message =
      `Cannot resolve workflow '${job.workflowPath}' for job ${job.id}. ` +
      `Searched [${jobIntelligenceDir}, ${settings.paths.baseLayerDir}]. ` +
      `Failing the job — fix the intelligence path before re-submitting.`
    logger.error({ jobId: job.id, workflowPath: job.workflowPath }, message)
    await stateBackend.appendLog(job.id, `[error] ${message}`)
    await stateBackend.updateJob(job.id, { status: STATUS_FAILED, escalationMessage: message })
    return
  }

  if (workflowConfig && !workflowConfig.phases.some(p => p.name === job.phase)) {
    const message =
      `Job ${job.id} is in phase '${job.phase}', which is not declared in ` +
      `workflow '${job.workflowPath}' (declared phases: ` +
      `${workflowConfig.phases.map(p => p.name).join(', ')}). ` +
      `This indicates a stale or corrupt job record. Failing fast.`
    logger.error({ jobId: job.id, phase: job.phase }, message)
    await stateBackend.appendLog(job.id, `[error] ${message}`)
    await stateBackend.updateJob(job.id, { status: STATUS_FAILED, escalationMessage: message })
    return
  }

  let liveJob: Job = { ...job }

  // Shared mutable context — the MCP server's tool handlers close over these
  const toolCtx: ToolContext = {
    job: liveJob,
    stateBackend,
    settings,
    tenantContext,
    jobIntelligenceDir,
    gitClient: ctx.gitClient,
    bbCoder: ctx.bbCoder,
    bbReviewer: ctx.bbReviewer,
    ghClient: ctx.ghClient,
    ghGitClient: ctx.ghGitClient,
    lokiClient: ctx.lokiClient,
    tempoClient: ctx.tempoClient,
    jiraClient: ctx.jiraClient,
    trackerClient: ctx.trackerClient,
    plugins: ctx.plugins,
    logger,
    runningServices,
  }

  const signals: PhaseSignals = {}

  logger.info(
    {
      jobId: liveJob.id,
      type: liveJob.type,
      phase: liveJob.phase,
      tenantId: tenantContext.tenantId,
      tenantMode: tenantContext.mode,
      jobIntelligenceDir,
    },
    'Job runner started',
  )

  try {
    assertJobPluginRequirements(liveJob, ctx.plugins)
  } catch (err) {
    const message = (err as Error).message
    logger.error({ jobId: liveJob.id, phase: liveJob.phase }, message)
    await stateBackend.appendLog(liveJob.id, `[error] ${message}`)
    await stateBackend.updateJob(liveJob.id, { status: STATUS_FAILED, escalationMessage: message })
    return
  }

  /** Bundled Claude Code entrypoint; npm ships it as non-executable — we chmod if needed. */
  const claudeCodeCliPath = resolveClaudeCodeCliPath()
  ensureClaudeCodeCliExecutable(claudeCodeCliPath, logger)

  try {
    await stateBackend.appendLog(liveJob.id, `Runner started — phase: ${liveJob.phase}`)

    while (!isTerminalStatus(liveJob.status)) {
      // Reset signals and create a fresh MCP server for each phase.
      // Reusing the MCP server across phases can leave the transport in a
      // broken state if the previous Claude Code subprocess exited uncleanly.
      resetSignals(signals)
      const mcpServer = createCoroMcpServer(toolCtx, signals)

      // Re-resolve intelligence at every phase boundary. This is
      // idempotent (same materialised path) and cheap (file copies +
      // tenant overlay refresh). Crucially it picks up the repo
      // overlay (`<repoCheckout>/.coro/`) once the agent has cloned the
      // target repo in an earlier phase.
      try {
        await resolveJobIntelligence({
          baseLayerDir: settings.paths.baseLayerDir,
          tenantContext,
          jobId: liveJob.id,
          workingRoot: settings.paths.workingDir,
          repoCheckoutDir,
          loaderCacheRoot,
          plugins: ctx.plugins,
          logger,
        })
      } catch (err) {
        // A re-resolve failure must NOT crash the phase. Fall back to the
        // last good materialisation already on disk.
        logger.warn(
          { err, jobId: liveJob.id, phase: liveJob.phase },
          'Per-phase intelligence re-resolve failed — using previous overlay',
        )
      }

      // Recompute every phase: the tracker client itself is constructed once
      // at runner bootstrap, but `isAvailable()` reads its captured settings
      // and we want the prompt to reflect any tenant-overlay config refresh
      // between phases.
      const trackerInfo = computeTrackerPromptContext(settings, ctx.trackerClient)
      const scmInfo = computeScmPromptContext(liveJob, ctx.plugins)
      const systemPrompt = await buildSystemPrompt(liveJob, jobIntelligenceDir, logger, trackerInfo, scmInfo)
      const promptSizeKb = (Buffer.byteLength(systemPrompt, 'utf-8') / 1024).toFixed(1)
      logger.info(
        { jobId: liveJob.id, phase: liveJob.phase, promptSizeKb: Number(promptSizeKb) },
        `System prompt assembled: ${promptSizeKb} KB`,
      )
      await stateBackend.appendLog(liveJob.id, `System prompt: ${promptSizeKb} KB`)
      const phaseConf = workflowConfig ? getPhaseConfig(workflowConfig, liveJob.phase) : null

      // Defence in depth — the start-of-runJob guard already rejects
      // jobs with an unknown initial phase, but `goto_phase` could
      // still land us on something the workflow doesn't declare. Fail
      // loudly rather than silently picking the planning-tier model
      // for a phase with no agent role.
      if (workflowConfig && !phaseConf) {
        const message =
          `Job ${liveJob.id} advanced to phase '${liveJob.phase}', which is ` +
          `not declared in workflow '${liveJob.workflowPath}'. Failing the job.`
        logger.error({ jobId: liveJob.id, phase: liveJob.phase }, message)
        await stateBackend.appendLog(liveJob.id, `[error] ${message}`)
        liveJob = await syncJob(stateBackend, liveJob, {
          status: STATUS_FAILED,
          escalationMessage: message,
        })
        toolCtx.job = liveJob
        break
      }

      // Minimal per-phase prompt. The system prompt already carries the
      // workflow, agent role, and job state; we just need a short nudge to
      // kick the agent into action for this phase. When the dispatcher
      // injected a pendingPrompt (webhook event or developer message), use
      // that verbatim instead — it carries the event payload the agent
      // needs to react to.
      const promptText = liveJob.pendingPrompt ?? buildPhaseKickoffMessage(liveJob)

      // Wrap the prompt as a one-message async iterable (NOT a plain string).
      //
      // Why: the Agent SDK's `query()` inspects `typeof prompt === "string"`
      // and, if true, flags the Query as `isSingleUserTurn`. In single-turn
      // mode the SDK:
      //   - closes stdin after the first result message,
      //   - skips the bidirectional IPC channel, and crucially
      //   - never delivers the `initialize` control request that registers
      //     in-process SDK MCP servers (`createSdkMcpServer`).
      //
      // Passing an `AsyncIterable<SDKUserMessage>` flips the SDK to
      // bidirectional mode, so `mcp__coro__*` tools actually register.
      const prompt = (async function* (): AsyncIterable<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: promptText }] },
          parent_tool_use_id: null,
        }
      })()

      // Clear pendingPrompt immediately so it isn't replayed on the next turn.
      if (liveJob.pendingPrompt) {
        liveJob = await syncJob(stateBackend, liveJob, { pendingPrompt: undefined })
        toolCtx.job = liveJob
      }

      const model = selectModel(phaseConf, settings)
      const workingDir = path.join(settings.paths.workingDir, liveJob.id)
      /** SDK spawns Claude Code with `cwd: workingDir`. Missing dir causes spawn ENOENT, which the SDK misreports as "cli.js not found". */
      mkdirSync(workingDir, { recursive: true })
      ensureClaudeConfigSymlink(workingDir, jobIntelligenceDir, logger)

      // Build subagent definitions from workflow config. Plugin-provided
      // MCP servers (S1) and BYO MCP servers (S8) propagate to
      // subagents too — otherwise a code reviewer subagent would be
      // blind to `mcp__github__*` / `mcp__slack__*` etc. tools the
      // parent agent can see.
      const subagentPluginMcpServers = collectPluginMcpServers({
        plugins: ctx.plugins,
        logger,
      })
      const subagentUserMcpServers = collectUserMcpServers({ logger })
      const subagentMcpServers = {
        ...subagentPluginMcpServers,
        ...subagentUserMcpServers,
      }
      const agents = phaseConf?.subagents
        ? buildSubagentDefinitions(
            phaseConf.subagents,
            jobIntelligenceDir,
            settings,
            mcpServer as McpSdkServerConfig,
            subagentMcpServers,
          )
        : undefined

      // Update job status for the current phase
      const phaseStatus = phaseConf?.status ?? liveJob.phase
      liveJob = await syncJob(stateBackend, liveJob, { status: phaseStatus })
      toolCtx.job = liveJob

      // Agent-less parking phase short-circuit. When a workflow phase has
      // no agent AND its mapped status is a parking state, there is
      // nothing for an LLM to do — running query() would just burn
      // planning-tier tokens against a prompt with no role section. The
      // canonical examples are:
      //   - self-update workflow's `tracking` phase
      //     (status: awaiting-pr-merge — webhook resumes it)
      //   - campaign workflow's `coordinating` phase
      //     (status: awaiting-children — dispatcher resumes it)
      //
      // We park immediately and break the runner loop. The dispatcher's
      // coordinator hook (for campaigns) or webhook handler (for
      // self-update) takes responsibility for the next resume.
      if (!phaseConf?.agent && phaseConf && isParkingStatus(phaseConf.status)) {
        const isCampaign = isCampaignJob(liveJob) && phaseConf.status === STATUS_AWAITING_CHILDREN
        const awaiting = isCampaign
          ? 'campaign-children-complete'
          : `phase-${liveJob.phase}-event`

        liveJob = await syncJob(stateBackend, liveJob, {
          awaitingEvent: awaiting,
        })
        toolCtx.job = liveJob

        logger.info(
          { jobId: liveJob.id, phase: liveJob.phase, status: phaseStatus, isCampaign },
          'Agent-less parking phase — runner stopping until external resume',
        )
        await stateBackend.appendLog(
          liveJob.id,
          `Phase ${liveJob.phase} has no agent — parked at ${phaseStatus}. ` +
            `${isCampaign
              ? 'Dispatcher coordinator will dispatch ready children and resume the parent on completion.'
              : 'External event resumes the job.'}`,
        )
        break
      }

      logger.info(
        { jobId: liveJob.id, phase: liveJob.phase, model },
        'Starting Agent SDK query for phase',
      )

      // SDK hooks enforce filesystem safety guard rails that were previously
      // described only in prose inside agent markdown.
      // The hook
      // returns `permissionDecision: 'deny'` — the SDK then rejects the tool
      // use with the reason visible to the model, which course-corrects.
      const hooks = buildPhaseHooks({
        liveJobRef: () => liveJob,
        workingDir,
        coroIntelligenceDir: jobIntelligenceDir,
        logger,
      })

      // `resume: sessionId` carries the previous transcript forward. This is
      // cheap (no rebuilt context) and usually desirable. It is opt-out via
      // `CORO_DISABLE_SESSION_RESUME=1` for cases where a completely fresh
      // session is still preferable.
      //
      // The SDK has historically been flaky about in-process MCP servers on
      // resumed sessions. We still resume, but immediately re-register the
      // dynamic Coro MCP server on the live Query before consuming model output.
      // Note: even with resume, the system prompt is re-sent every call — so
      // phase transitions still update the agent's role correctly.
      const resumeDisabled = process.env.CORO_DISABLE_SESSION_RESUME === '1'
        || process.env.CORO_DISABLE_SESSION_RESUME === 'true'
      const resumeSessionId = !resumeDisabled && liveJob.sessionId ? liveJob.sessionId : undefined
      // Registration key MUST equal the desired tool prefix. The SDK exposes
      // tools as `mcp__<key>__<tool>`, derived from this object key (not from
      // the server.name passed to createSdkMcpServer). Keeping them aligned
      // (both `coro`) avoids the historical confusion where the key drifted
      // and tools silently disappeared.
      //
      // Plugin-provided MCP servers (S1 of the MCP-first pivot) are merged
      // alongside `coro` so the model sees `mcp__github__*`, `mcp__jira__*`
      // etc. directly. The reserved id `coro` cannot be shadowed — see
      // `collectPluginMcpServers`.
      const pluginMcpServers = collectPluginMcpServers({
        plugins: ctx.plugins,
        logger,
      })
      // Bring-your-own MCP servers (S8 of the MCP-first pivot) are
      // attached after plugin servers; collisions with plugin ids
      // are resolved by giving the BYO config the win — operators
      // explicitly opted into the user-level entry. `coro` is still
      // reserved.
      const userMcpServers = collectUserMcpServers({ logger })
      const dynamicMcpServers = {
        coro: mcpServer,
        ...pluginMcpServers,
        ...userMcpServers,
      } satisfies Record<string, McpServerConfig>

      if (Object.keys(pluginMcpServers).length > 0) {
        logger.info(
          {
            jobId: liveJob.id,
            phase: liveJob.phase,
            pluginMcpServers: Object.keys(pluginMcpServers),
          },
          'Attached plugin-provided MCP servers to query session',
        )
      }

      const queryOptions: Record<string, unknown> = {
        pathToClaudeCodeExecutable: claudeCodeCliPath,
        systemPrompt,
        model,
        cwd: workingDir,
        settingSources: ['project'],
        mcpServers: dynamicMcpServers,
        hooks,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 200,
        thinking: { type: 'adaptive' },
        systemPromptCacheControl: 'ephemeral',
        persistSession: true,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        // Must inherit process.env (PATH, HOME, …). A bare object replaces the SDK default and breaks spawn('node', …).
        env: {
          ...process.env,
          // Anthropic auth: pick exactly one of ANTHROPIC_API_KEY or
          // CLAUDE_CODE_OAUTH_TOKEN. If both are present the Claude Code CLI
          // silently prefers ANTHROPIC_API_KEY, which would override the
          // user's chosen OAuth flow — so we explicitly wipe the one we
          // aren't using (including any stale value inherited from process.env).
          ...buildAnthropicAuthEnv(settings.claude.auth),
          BB_WORKSPACE: settings.bitbucket.workspace,
          BB_CODER_APP_PASSWORD: settings.bitbucket.coderAccount.appPassword,
          BB_BASE_URL: 'https://bitbucket.org',
          BB_GIT_USERNAME: settings.bitbucket.coderAccount.appPassword.startsWith('ATATT')
            ? 'x-token-auth'
            : encodeURIComponent(settings.bitbucket.coderAccount.username),
          GH_OWNER: settings.github?.owner ?? '',
          GH_TOKEN: settings.github?.token ?? '',
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000',
          // Explicitly enable ToolSearch / deferred tool loading.
          ENABLE_TOOL_SEARCH: 'true',
          DEBUG_CLAUDE_AGENT_SDK: '1',
        },
        // Capture the SDK and CLI subprocess stderr.
        stderr: (chunk: string) => {
          const text = String(chunk).trim()
          if (!text) return
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            logger.debug({ jobId: liveJob.id, phase: liveJob.phase }, `[sdk-stderr] ${trimmed}`)
            if (/mcp|Transport|sdkMcp|control_request/i.test(trimmed)) {
              stateBackend.appendLog(liveJob.id, `[sdk-stderr] ${trimmed.slice(0, 500)}`)
                .catch(() => { /* logging is best-effort */ })
            }
          }
        },
      }

      if (agents) {
        queryOptions.agents = agents
      }

      // Run the Agent SDK query — this handles the entire tool-use loop
      let sessionId: string | undefined
      const phaseTokens: TokenUsage = emptyTokenUsage()
      const prePhaseUsage: TokenUsage = { ...(liveJob.tokenUsage ?? emptyTokenUsage()) }
      let phaseTurns = 0
      let lastUsageSyncTurn = 0
      const phaseStartMs = Date.now()
      let phaseSnapshotRecorded = false
      // Track MCP usage for observability. A phase with built-in tool calls
      // and zero mcp__coro__* calls can indicate MCP registration trouble,
      // but it is no longer treated as a hard failure.
      let builtinToolUseCount = 0
      let mcpToolUseCount = 0

      // Tests inject `queryImpl` and still receive the plain string prompt
      // (backwards-compatible with the QueryInvocation contract). The real
      // SDK query is given the async-iterable form so bidirectional mode
      // (and thus SDK MCP registration) is preserved.
      const queryStream = options?.queryImpl
        ? options.queryImpl({ prompt: promptText, options: queryOptions, signals, toolCtx })
        : query({
            prompt,
            options: queryOptions as Parameters<typeof query>[0]['options'],
          })

      const isRealQuery = !options?.queryImpl && typeof (queryStream as Query).streamInput === 'function'
      if (isRealQuery) {
        const liveQuery = queryStream as Query
        options?.onQueryStart?.(liveJob.id, liveQuery)

        if (resumeSessionId) {
          try {
            const mcpRefresh = await reattachDynamicMcpServers(liveQuery, dynamicMcpServers, 'a5')
            logger.debug(
              {
                jobId: liveJob.id,
                phase: liveJob.phase,
                resumedFrom: resumeSessionId,
                added: mcpRefresh.setResult.added,
                removed: mcpRefresh.setResult.removed,
                errors: mcpRefresh.setResult.errors,
                initialStatus: mcpRefresh.initialStatus,
                finalStatus: mcpRefresh.finalStatus,
                reconnected: mcpRefresh.reconnected,
              },
              'Refreshed dynamic A5 MCP server on resumed query',
            )

            if (mcpRefresh.setResult.errors['a5'] || mcpRefresh.finalStatus === 'failed') {
              await stateBackend.appendLog(
                liveJob.id,
                `[warning] A5 MCP refresh reported issues on resumed session. ` +
                `errors=${JSON.stringify(mcpRefresh.setResult.errors)} status=${mcpRefresh.finalStatus ?? 'unknown'}`,
              )
            }
          } catch (err) {
            logger.warn(
              { err, jobId: liveJob.id, phase: liveJob.phase, resumedFrom: resumeSessionId },
              'Failed to refresh dynamic A5 MCP server on resumed query',
            )
            await stateBackend.appendLog(
              liveJob.id,
              '[warning] Failed to refresh A5 MCP server on resumed session; MCP tools may be unavailable.',
            )
          }
        }
      }

      try {
      for await (const raw of queryStream) {
        const message = raw as Record<string, unknown>
        const eventType = String(message['type'] ?? '')

        if (eventType === 'system') {
          const sid = message['session_id']
          if (typeof sid === 'string') sessionId = sid

          if (message['subtype'] === 'init') {
            const mcpServers = Array.isArray(message['mcp_servers'])
              ? (message['mcp_servers'] as Array<{ name?: unknown; status?: unknown }>)
              : []
            const tools = Array.isArray(message['tools']) ? (message['tools'] as string[]) : []
            const mcpToolCount = tools.filter(t => typeof t === 'string' && t.startsWith('mcp__coro__')).length
            const a5Tools = tools.filter(t => typeof t === 'string' && t.startsWith('mcp__coro__'))

            logger.info(
              {
                jobId: liveJob.id,
                phase: liveJob.phase,
                mcpServersAtInit: mcpServers.map(s => ({ name: s.name, status: s.status })),
                mcpToolCountAtInit: mcpToolCount,
                totalToolsAtInit: tools.length,
                allToolsAtInit: tools,
                a5ToolsAtInit: a5Tools,
                resumedFrom: resumeSessionId ?? null,
              },
              'Claude Code session init',
            )

            await stateBackend.appendLog(
              liveJob.id,
              `[init] session started — ${tools.length} tools at boot, ${mcpToolCount} mcp__coro__* tools` +
              (resumeSessionId ? ` (resumed from ${resumeSessionId})` : ''),
            )
          }
        }

        if (eventType === 'assistant') {
          const betaMsg = message['message'] as Record<string, unknown> | undefined
          const content = betaMsg?.['content']
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              const bt = String(block['type'] ?? '')
              if (bt === 'text' && typeof block['text'] === 'string' && (block['text'] as string).trim()) {
                await stateBackend.appendLog(liveJob.id, block['text'] as string)
              } else if (bt === 'thinking' && typeof block['thinking'] === 'string') {
                await stateBackend.appendLog(liveJob.id, `[thinking] ${(block['thinking'] as string).slice(0, 300)}`)
              } else if (bt === 'tool_use' || bt === 'mcp_tool_use') {
                const toolName = String(block['name'] ?? 'unknown')
                const input = block['input']
                const inputStr = input ? ` ${JSON.stringify(input).slice(0, 300)}` : ''
                await stateBackend.appendLog(liveJob.id, `→ ${toolName}${inputStr}`)
                if (toolName.startsWith('mcp__coro__')) mcpToolUseCount++
                else builtinToolUseCount++
              }
            }
          }

          const turnUsage = betaMsg?.['usage'] as Record<string, unknown> | undefined
          if (turnUsage) {
            phaseTokens.inputTokens += Number(turnUsage['input_tokens'] ?? 0)
            phaseTokens.outputTokens += Number(turnUsage['output_tokens'] ?? 0)
            phaseTokens.cacheReadInputTokens += Number(turnUsage['cache_read_input_tokens'] ?? 0)
            phaseTokens.cacheCreationInputTokens += Number(turnUsage['cache_creation_input_tokens'] ?? 0)
            phaseTurns++

            if (phaseTurns - lastUsageSyncTurn >= 5) {
              lastUsageSyncTurn = phaseTurns
              const merged = mergeTokenUsage(prePhaseUsage, phaseTokens)
              liveJob = await syncJob(stateBackend, liveJob, { tokenUsage: merged })
              toolCtx.job = liveJob
            }
          }
        }

        if (eventType === 'tool_use_summary') {
          const summary = message['summary']
          if (typeof summary === 'string' && summary.trim()) {
            await stateBackend.appendLog(liveJob.id, `[tool_summary] ${summary.slice(0, 500)}`)
          }
        }

        if (eventType === 'tool_progress') {
          const toolName = message['tool_name']
          const elapsed = message['elapsed_time_seconds']
          if (typeof toolName === 'string' && typeof elapsed === 'number' && elapsed >= 10) {
            await stateBackend.appendLog(liveJob.id, `⏳ ${toolName} running (${Math.round(elapsed)}s)`)
          }
        }

        if (eventType === 'result') {
          const isError = message['is_error']
          if (isError) {
            const errors = message['errors']
            const errStr = Array.isArray(errors) ? (errors as string[]).join('; ') : 'unknown error'
            await stateBackend.appendLog(liveJob.id, `[error] ${errStr.slice(0, 500)}`)
          } else {
            const result = message['result']
            if (typeof result === 'string' && result.trim()) {
              await stateBackend.appendLog(liveJob.id, `[result] ${result}`)
            }
          }

          phaseSnapshotRecorded = true

          const resultUsage = message['usage'] as Record<string, number> | undefined
          const resultModelUsage = message['modelUsage'] as Record<string, Record<string, unknown>> | undefined

          if (resultUsage) {
            phaseTokens.inputTokens = Number(resultUsage['input_tokens'] ?? phaseTokens.inputTokens)
            phaseTokens.outputTokens = Number(resultUsage['output_tokens'] ?? phaseTokens.outputTokens)
            phaseTokens.cacheReadInputTokens = Number(resultUsage['cache_read_input_tokens'] ?? phaseTokens.cacheReadInputTokens)
            phaseTokens.cacheCreationInputTokens = Number(resultUsage['cache_creation_input_tokens'] ?? phaseTokens.cacheCreationInputTokens)
          }

          const phaseCostUsd = typeof message['total_cost_usd'] === 'number' ? message['total_cost_usd'] as number : 0
          phaseTokens.totalCostUsd = phaseCostUsd

          const phaseSnapshot: PhaseUsage = {
            phase: liveJob.phase,
            inputTokens: phaseTokens.inputTokens,
            outputTokens: phaseTokens.outputTokens,
            cacheReadInputTokens: phaseTokens.cacheReadInputTokens,
            cacheCreationInputTokens: phaseTokens.cacheCreationInputTokens,
            costUsd: phaseCostUsd,
            durationMs: typeof message['duration_ms'] === 'number' ? message['duration_ms'] as number : (Date.now() - phaseStartMs),
            durationApiMs: typeof message['duration_api_ms'] === 'number' ? message['duration_api_ms'] as number : 0,
            numTurns: typeof message['num_turns'] === 'number' ? message['num_turns'] as number : phaseTurns,
            model,
            modelUsage: resultModelUsage
              ? Object.fromEntries(
                  Object.entries(resultModelUsage).map(([m, u]) => [m, {
                    inputTokens: Number(u['inputTokens'] ?? 0),
                    outputTokens: Number(u['outputTokens'] ?? 0),
                    costUSD: Number(u['costUSD'] ?? 0),
                  }])
                )
              : undefined,
          }

          const existingPhaseUsage = liveJob.phaseUsage ?? []
          const jobTotals = mergeTokenUsage(prePhaseUsage, phaseTokens)

          liveJob = await syncJob(stateBackend, liveJob, {
            tokenUsage: jobTotals,
            phaseUsage: [...existingPhaseUsage, phaseSnapshot],
          })
          toolCtx.job = liveJob

          await stateBackend.appendLog(
            liveJob.id,
            `[usage] Phase ${liveJob.phase}: ${phaseTokens.inputTokens.toLocaleString()} in / ${phaseTokens.outputTokens.toLocaleString()} out`,
          )
        }

        const handledTypes = new Set([
          'system', 'assistant', 'tool_use_summary', 'tool_progress', 'result',
          'user', 'stream_event', 'auth_status',
        ])
        if (!handledTypes.has(eventType)) {
          await stateBackend.appendLog(liveJob.id, `[event:${eventType}] ${JSON.stringify(message).slice(0, 500)}`)
        }

        // Early break on exception signals so we don't keep pulling events
        // after the agent has asked us to park, escalate, or re-route. The
        // absence of any signal simply lets the stream drain naturally and
        // then auto-advances.
        if (signals.nextPhase || signals.awaitingEvent || signals.escalated) {
          break
        }
      }
      } finally {
        if (isRealQuery) {
          options?.onQueryEnd?.(liveJob.id)
        }
      }

      // MCP usage diagnostics. Zero mcp calls while built-ins fired can
      // indicate SDK MCP registration issues and is logged for operators.
      logger.info(
        {
          jobId: liveJob.id,
          phase: liveJob.phase,
          mcpToolUseCount,
          builtinToolUseCount,
        },
        'Phase tool-use summary',
      )
      await stateBackend.appendLog(
        liveJob.id,
        `[phase-end] tool_use counts — mcp__coro__*: ${mcpToolUseCount}, built-in: ${builtinToolUseCount}`,
      )
      if (mcpToolUseCount === 0 && builtinToolUseCount > 0) {
        logger.warn(
          {
            jobId: liveJob.id,
            phase: liveJob.phase,
            builtinToolUseCount,
          },
          'A5 MCP tools were not invoked while built-in tools were. This may indicate SDK MCP registration trouble; check stderr for [Query.connectSdkMcpServer] messages.',
        )
        await stateBackend.appendLog(
          liveJob.id,
          `[warning] Agent used ${builtinToolUseCount} built-in tool_use blocks but ZERO mcp__coro__* calls. ` +
          `SDK MCP registration may have issues. ` +
          `See runner stderr for "[Query.connectSdkMcpServer]" or "Transport write failed" lines.`,
        )
      }
      // Ensure every phase gets a PhaseUsage snapshot, even when a signal
      // (goto_phase, await_event, escalate) broke the stream before the
      // SDK's result event was consumed.
      if (!phaseSnapshotRecorded) {
        const phaseSnapshot: PhaseUsage = {
          phase: liveJob.phase,
          inputTokens: phaseTokens.inputTokens,
          outputTokens: phaseTokens.outputTokens,
          cacheReadInputTokens: phaseTokens.cacheReadInputTokens,
          cacheCreationInputTokens: phaseTokens.cacheCreationInputTokens,
          costUsd: 0,
          durationMs: Date.now() - phaseStartMs,
          durationApiMs: 0,
          numTurns: phaseTurns,
          model,
        }

        const existingPhaseUsage = liveJob.phaseUsage ?? []
        const jobTotals = mergeTokenUsage(prePhaseUsage, phaseTokens)

        liveJob = await syncJob(stateBackend, liveJob, {
          tokenUsage: jobTotals,
          phaseUsage: [...existingPhaseUsage, phaseSnapshot],
        })
        toolCtx.job = liveJob

        await stateBackend.appendLog(
          liveJob.id,
          `[usage] Phase ${liveJob.phase}: ${phaseTokens.inputTokens.toLocaleString()} in / ${phaseTokens.outputTokens.toLocaleString()} out`,
        )
      } else if (phaseTurns > lastUsageSyncTurn) {
        const merged = mergeTokenUsage(prePhaseUsage, phaseTokens)
        liveJob = await syncJob(stateBackend, liveJob, { tokenUsage: merged })
        toolCtx.job = liveJob
      }

      if (sessionId) {
        liveJob = await syncJob(stateBackend, liveJob, { sessionId })
        toolCtx.job = liveJob
      }

      // ── Post-query signal processing ───────────────────────────────────────
      //
      // Priority order:
      //   1. Terminal status (already completed by another mechanism) → stop
      //   2. Escalated (agent explicitly asked for human help) → stop
      //   3. Awaiting event (agent needs to wait for external input) → park
      //   4. goto_phase or default: advance to the next workflow phase
      //
      // Interactive checkpoints are enforced here for interactive jobs.
      // Phases marked with `interactiveCheckpoint` park before advancing,
      // unless the dispatcher has already recorded a one-time approval for
      // the current phase via `approvedAdvanceFromPhase`.

      if (isTerminalStatus(liveJob.status)) break

      if (signals.escalated) {
        break
      }

      if (signals.awaitingEvent) {
        const evt = signals.awaitingEvent
        const awaitStatus = evt.startsWith('developer-input')
          ? STATUS_AWAITING_DEVELOPER_INPUT
          : evt.includes('plan')
            ? STATUS_AWAITING_PLAN_APPROVAL
            : STATUS_AWAITING_PR_MERGE
        const approvalCheckpointNextPhase =
          evt.startsWith('developer-input')
          && liveJob.interactive
          && phaseConf?.interactiveCheckpoint
          && isDeveloperApprovalRequest(evt)
            ? (workflowConfig ? wfGetNextPhase(workflowConfig, liveJob.phase) : null)
            : null

        liveJob = await syncJob(stateBackend, liveJob, {
          status: awaitStatus,
          awaitingEvent: evt,
          awaitingPrId: signals.awaitingPrId,
          awaitingNextPhase: approvalCheckpointNextPhase ?? undefined,
        })

        if (signals.awaitingPrId) {
          await stateBackend.mapPrToJob(signals.awaitingPrId, liveJob.id)
        }

        logger.info(
          { jobId: liveJob.id, awaiting: evt, prId: signals.awaitingPrId, status: awaitStatus },
          'Job parked — awaiting external event',
        )
        await stateBackend.appendLog(liveJob.id, `Job parked — waiting for: ${evt}`)
        break
      }

      // Default: auto-advance to the next phase. goto_phase overrides the
      // workflow-defined order (e.g. evaluator loops back to coding).
      const nextPhase = signals.nextPhase
        ?? (workflowConfig ? wfGetNextPhase(workflowConfig, liveJob.phase) : null)

      if (!nextPhase) {
        liveJob = await syncJob(stateBackend, liveJob, { status: STATUS_COMPLETE })
        await stateBackend.appendLog(liveJob.id, 'All phases complete — job finished successfully')
        logger.info({ jobId: liveJob.id }, 'Job completed')
        break
      }

      // Re-read `interactive` from state right before the boundary check so
      // a dashboard / API toggle that lands mid-phase is honoured on this
      // transition, not the next one. We only refresh this one field
      // (cheap, O(1) read) — full job state already trickles back via the
      // syncJob calls earlier in the loop.
      try {
        const fresh = await stateBackend.getJob(liveJob.id)
        if (fresh && fresh.interactive !== liveJob.interactive) {
          logger.info(
            { jobId: liveJob.id, was: liveJob.interactive, now: fresh.interactive },
            'Interactive flag changed mid-phase — honouring new value at checkpoint',
          )
          liveJob = { ...liveJob, interactive: fresh.interactive }
          toolCtx.job = liveJob
        }
      } catch (refreshErr) {
        // Soft-fail: if the state read fails we fall back to the in-memory
        // value so the runner keeps making progress.
        logger.warn(
          { err: refreshErr, jobId: liveJob.id },
          'Failed to refresh interactive flag at boundary — using in-memory value',
        )
      }

      const checkpointApproved = liveJob.approvedAdvanceFromPhase === liveJob.phase
      if (liveJob.interactive && phaseConf?.interactiveCheckpoint && !checkpointApproved) {
        const waitingFor = `developer-input: approval after ${liveJob.phase}`

        liveJob = await syncJob(stateBackend, liveJob, {
          status: STATUS_AWAITING_DEVELOPER_INPUT,
          awaitingEvent: waitingFor,
          awaitingNextPhase: nextPhase,
          approvedAdvanceFromPhase: undefined,
        })
        toolCtx.job = liveJob

        logger.info(
          { jobId: liveJob.id, phase: liveJob.phase, nextPhase },
          'Interactive checkpoint reached — awaiting developer approval',
        )
        await stateBackend.appendLog(
          liveJob.id,
          `Interactive checkpoint reached — waiting for developer approval before ${nextPhase}`,
        )
        break
      }

      liveJob = await syncJob(stateBackend, liveJob, {
        phase: nextPhase,
        awaitingNextPhase: undefined,
        approvedAdvanceFromPhase: checkpointApproved ? undefined : liveJob.approvedAdvanceFromPhase,
      })
      toolCtx.job = liveJob

      logger.info({ jobId: liveJob.id, phase: nextPhase }, 'Phase advanced')
      await stateBackend.appendLog(liveJob.id, `Phase advanced → ${nextPhase}`)
      continue
    }
  } catch (err) {
    logger.error({ err, jobId: liveJob.id }, 'Runner crashed — marking job failed')
    await stateBackend.appendLog(liveJob.id, `Runner crashed: ${String(err)}`)
    try {
      const current = await stateBackend.getJob(liveJob.id)
      if (!current || !isTerminalStatus(current.status)) {
        // Clear sessionId so the next resume starts a fresh Claude Code subprocess.
        // A crash (529 overload, network error, SDK bug) leaves the MCP transport in
        // a broken state — resuming the old session would give the agent working
        // built-in tools but broken mcp__coro__* tools.
        await stateBackend.updateJob(liveJob.id, {
          status: STATUS_FAILED,
          escalationMessage: String(err),
          sessionId: undefined,
        })
      }
    } catch {
      // Best-effort
    }
  } finally {
    for (const [label, proc] of runningServices) {
      proc.kill('SIGTERM')
      logger.debug({ label }, 'Cleaned up running service')
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Best-effort guess at where the agent will clone the target repo.
 *
 * Convention: the repo is cloned into `<repoSlug>` inside the SDK's
 * `cwd: workingDir`, typically via `mcp__coro__scm_clone_repo`, which
 * lands the checkout at
 * `<workingDir>/<repoSlug>`. The resolver uses this path to discover a
 * repo `.coro/` overlay; if the path doesn't exist (typical at first
 * resolve), the resolver skips the layer.
 *
 * Returns `undefined` when no `repoSlug` is set on the job (e.g.
 * self-update jobs that don't target a specific repo).
 */
function deriveRepoCheckoutDir(job: Job, workingRoot: string): string | undefined {
  const slug = (job.params as Record<string, unknown> | undefined)?.['repoSlug']
  if (typeof slug !== 'string' || slug.length === 0) return undefined
  return path.join(workingRoot, job.id, slug)
}

async function syncJob(
  stateBackend: StateBackend,
  job: Job,
  patch: Partial<Job>,
): Promise<Job> {
  return stateBackend.updateJob(job.id, patch)
}

function resetSignals(s: PhaseSignals): void {
  s.nextPhase = undefined
  s.awaitingEvent = undefined
  s.awaitingPrId = undefined
  s.escalated = undefined
  s.escalationReason = undefined
}

function isDeveloperApprovalRequest(eventName: string): boolean {
  return /\bapprov(?:e|ed|al)\b/i.test(eventName)
}

/**
 * Merge phase-level token accumulations into the job-level totals.
 * The phaseTokens represent a *delta* from the current phase only;
 * the base is the job total *before* this phase started.
 */
function mergeTokenUsage(base: TokenUsage, phase: TokenUsage): TokenUsage {
  return {
    inputTokens: base.inputTokens + phase.inputTokens,
    outputTokens: base.outputTokens + phase.outputTokens,
    cacheReadInputTokens: base.cacheReadInputTokens + phase.cacheReadInputTokens,
    cacheCreationInputTokens: base.cacheCreationInputTokens + phase.cacheCreationInputTokens,
    totalCostUsd: base.totalCostUsd + phase.totalCostUsd,
  }
}

function selectModel(
  phaseConf: { model?: string } | null | undefined,
  settings: Settings,
): string {
  const model = phaseConf?.model ?? 'planning'
  return model === 'coding' ? settings.claude.codingModel : settings.claude.planningModel
}

/**
 * Build the subset of env vars Claude Code uses for authentication. Returns
 * both keys, with the unused one set to `undefined` so it is stripped from the
 * final env map (Node spawn treats `undefined` as "don't pass this key").
 * The `claudeLogin` mode deliberately passes neither variable so the CLI can
 * use its own persisted session and refresh flow.
 */
export function buildAnthropicAuthEnv(auth: Settings['claude']['auth']): Record<string, string | undefined> {
  if (auth.method === 'claudeLogin') {
    return {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    }
  }
  if (auth.method === 'oauth') {
    return {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: auth.oauthToken ?? '',
    }
  }
  return {
    ANTHROPIC_API_KEY: auth.apiKey ?? '',
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  }
}

/**
 * Collects every active plugin's `mcpServer()` descriptor and returns a
 * `Record<pluginId, McpServerConfig>` ready to merge into the SDK's
 * `mcpServers` option. Plugins without an `mcpServer()` (e.g. BitBucket
 * pre-MCP) are silently skipped — the hybrid `scm_*`/`tracker_*` proxy
 * is responsible for falling back to the plugin's native methods.
 *
 * Collisions with reserved keys (`coro`) are rejected with a warning;
 * we never let a plugin shadow Coro's in-process MCP server. Per-plugin
 * tool policies (`capabilities.allowedMcpTools` / `disallowedMcpTools`)
 * are translated into the SDK's `tools` array so the model only sees
 * what we want it to see.
 */
export function collectPluginMcpServers(args: {
  plugins: PluginRegistry
  logger: Logger
}): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {}
  const reservedIds = new Set<string>(['coro', 'a5'])

  for (const runtime of args.plugins.all()) {
    const id = runtime.manifest.id
    if (typeof runtime.mcpServer !== 'function') continue
    let descriptor
    try {
      descriptor = runtime.mcpServer()
    } catch (err) {
      args.logger.warn(
        { err, pluginId: id },
        'Plugin mcpServer() threw — skipping attachment for this job',
      )
      continue
    }
    if (!descriptor) continue

    if (reservedIds.has(id)) {
      args.logger.warn(
        { pluginId: id },
        'Plugin id collides with a reserved MCP server key — skipping; rename the plugin',
      )
      continue
    }

    const allowed: ReadonlyArray<string> | null =
      runtime.manifest.allowedMcpTools ??
      (runtime.manifest.capabilities?.allowedMcpTools as unknown as ReadonlyArray<string> | undefined) ??
      null
    const disallowed: ReadonlyArray<string> | null =
      runtime.manifest.disallowedMcpTools ??
      (runtime.manifest.capabilities?.disallowedMcpTools as unknown as ReadonlyArray<string> | undefined) ??
      null

    // Per-server tool policies are SDK-native. We forward them through
    // the descriptor's `tools` field where the SDK accepts a list of
    // `{ name, behavior }` objects. Falling through with no policy
    // surfaces every upstream tool — fine for early integration but
    // expensive at steady state (curate via the manifest).
    const toolsPolicy = buildPluginMcpToolPolicy(allowed, disallowed)

    if (descriptor.type === 'http' || descriptor.type === 'sse') {
      result[id] = toolsPolicy
        ? { ...descriptor, tools: toolsPolicy }
        : descriptor
    } else {
      // stdio descriptors don't accept `tools` directly in the SDK
      // typing; the SDK's `setMcpServers` ignores the field for stdio,
      // and the curated tool list is applied via `disallowedTools` /
      // `allowedTools` in the SDK's permission system. We pass it
      // through unchanged here and rely on the per-plugin manifest's
      // capability flags to drive the prompt-side curation in S2.
      result[id] = descriptor
    }
  }

  return result
}

/**
 * Collects bring-your-own MCP servers from the local config
 * (`~/.coro/config.json` → `mcpServers`). Returns a `Record<id,
 * McpServerConfig>` ready to merge into the SDK's `mcpServers`
 * option, exactly mirroring the shape `collectPluginMcpServers` emits.
 *
 * Servers with `enabled: false` are skipped. The reserved id `coro`
 * is rejected with a warning. `allowedTools` / `disallowedTools` are
 * translated into per-server `tools` policies so operators can curate
 * the prompt-side surface without forking the upstream MCP server.
 *
 * Errors loading the config (missing file, unparsable JSON) are
 * downgraded to a warn — running jobs must not fail because the
 * developer mis-edited the config. The SDK reports unreachable MCP
 * servers in its `init` message anyway.
 */
export function collectUserMcpServers(args: { logger: Logger }): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {}
  let config: ReturnType<typeof loadLocalConfig>
  try {
    config = loadLocalConfig()
  } catch (err) {
    args.logger.warn(
      { err },
      'collectUserMcpServers: failed to load local config — skipping BYO MCP servers',
    )
    return result
  }

  // Build the merged source map: explicit BYO entries from
  // ~/.coro/config.json land last so they always win over inherited
  // Claude Code entries with the same id (operators can mask noisy
  // inherited servers without editing ~/.claude.json).
  const merged: Record<string, UserMcpServerConfig> = {}
  if (config?.inheritClaudeCodeMcps === true) {
    try {
      const discovered = discoverClaudeCodeMcpServers()
      Object.assign(merged, discovered.servers)
      if (discovered.sources.length > 0) {
        args.logger.info(
          { sources: discovered.sources, inheritedCount: Object.keys(discovered.servers).length },
          'Inheriting MCP servers from Claude Code user-level config',
        )
      }
    } catch (err) {
      args.logger.warn(
        { err },
        'collectUserMcpServers: Claude Code MCP discovery failed — skipping',
      )
    }
  }
  if (config?.mcpServers) {
    Object.assign(merged, config.mcpServers)
  }

  const userServers: Record<string, UserMcpServerConfig> = merged
  const reservedIds = new Set<string>(['coro', 'a5'])

  for (const [id, raw] of Object.entries(userServers)) {
    if (raw.enabled === false) continue
    if (reservedIds.has(id)) {
      args.logger.warn(
        { mcpServerId: id },
        'BYO MCP server id collides with a reserved key — skipping; rename the entry',
      )
      continue
    }

    const allowed = raw.allowedTools ?? null
    const disallowed = raw.disallowedTools ?? null
    const toolsPolicy = buildPluginMcpToolPolicy(allowed, disallowed)

    if (raw.type === 'http' || raw.type === 'sse') {
      const desc = {
        type: raw.type,
        url: raw.url,
        ...(raw.headers ? { headers: raw.headers } : {}),
      }
      result[id] = (toolsPolicy ? { ...desc, tools: toolsPolicy } : desc) as McpServerConfig
    } else if (raw.type === 'stdio') {
      const desc = {
        type: 'stdio' as const,
        command: raw.command,
        ...(raw.args ? { args: raw.args } : {}),
        ...(raw.env ? { env: raw.env } : {}),
      }
      result[id] = desc as McpServerConfig
    }
  }

  return result
}

function buildPluginMcpToolPolicy(
  allowed: ReadonlyArray<string> | null,
  disallowed: ReadonlyArray<string> | null,
): Array<{ name: string; permission_policy: 'always_allow' | 'always_deny' }> | undefined {
  if (!allowed && !disallowed) return undefined
  const policy: Array<{ name: string; permission_policy: 'always_allow' | 'always_deny' }> = []
  if (allowed) {
    for (const name of allowed) policy.push({ name, permission_policy: 'always_allow' })
  }
  if (disallowed) {
    for (const name of disallowed) policy.push({ name, permission_policy: 'always_deny' })
  }
  return policy.length > 0 ? policy : undefined
}

type DynamicMcpQuery = Pick<Query, 'setMcpServers' | 'mcpServerStatus' | 'reconnectMcpServer'>

export async function reattachDynamicMcpServers(
  liveQuery: DynamicMcpQuery,
  dynamicMcpServers: Record<string, McpServerConfig>,
  serverName: string,
): Promise<{
  setResult: McpSetServersResult
  initialStatus: string | null
  finalStatus: string | null
  reconnected: boolean
}> {
  const setResult = await liveQuery.setMcpServers(dynamicMcpServers)
  const readStatus = async () => {
    const statuses = await liveQuery.mcpServerStatus()
    return statuses.find(status => status.name === serverName)?.status ?? null
  }

  const initialStatus = await readStatus()
  let finalStatus = initialStatus
  let reconnected = false

  if (finalStatus && finalStatus !== 'connected' && !setResult.errors[serverName]) {
    await liveQuery.reconnectMcpServer(serverName)
    reconnected = true
    finalStatus = await readStatus()
  }

  return {
    setResult,
    initialStatus,
    finalStatus,
    reconnected,
  }
}

function buildSubagentDefinitions(
  subagents: SubagentConfig[],
  intelligenceDir: string,
  settings: Settings,
  mcpServer: McpSdkServerConfig,
  pluginMcpServers: Record<string, McpServerConfig> = {},
) {
  // Load .claude/CLAUDE.md once — subagents need behavior rules, company context,
  // git conventions, and infrastructure context that the main agent receives
  // natively via settingSources. Subagents get their own prompt (not the parent's
  // system prompt), so we prepend this to ensure they have the foundational context.
  let claudeMdContent = ''
  try {
    claudeMdContent = readFileSync(
      path.join(intelligenceDir, '.claude', 'CLAUDE.md'),
      'utf-8',
    )
  } catch { /* .claude/CLAUDE.md not found — subagents will run without it */ }

  const defs: Record<string, unknown> = {}
  for (const sa of subagents) {
    let agentPrompt = `You are a helper subagent named ${sa.name}.`
    if (sa.agent) {
      try {
        const agentMd = readFileSync(
          path.join(intelligenceDir, sa.agent),
          'utf-8',
        )
        agentPrompt = agentMd
      } catch {
        agentPrompt = `You are the ${sa.name} subagent. Follow your instructions carefully.`
      }
    }

    if (claudeMdContent) {
      agentPrompt = claudeMdContent + '\n\n---\n\n' + agentPrompt
    }

    // The SDK accepts subagent `mcpServers` as an array of either named
    // strings or full records. We pass one record carrying both the
    // Coro in-process server and every plugin-provided MCP server so
    // subagents see `mcp__coro__*` AND `mcp__<pluginId>__*` tools.
    //
    // The cast is needed because `mcpServer` is a `McpSdkServerConfig`
    // (without `instance`) which the SDK's runtime accepts but its
    // typing only matches `McpSdkServerConfigWithInstance`. Mirrors the
    // existing `[mcpServer]` form this function already used.
    const subagentMcpRecord = {
      coro: mcpServer,
      ...pluginMcpServers,
    } as unknown as Record<string, McpServerConfig>
    defs[sa.name] = {
      description: `Subagent: ${sa.name}`,
      prompt: agentPrompt,
      model: sa.model === 'coding'
        ? (settings.claude.codingModel.includes('opus') ? 'opus' : 'sonnet')
        : (sa.model ?? 'inherit'),
      mcpServers: [subagentMcpRecord],
    }
  }
  return defs
}

/**
 * Symlink {coroIntelligenceDir}/.claude into the job working directory so the Agent SDK's
 * native settingSources: ['project'] discovers .claude/CLAUDE.md and skills.
 * Uses a symlink (not copy) so the per-job overlay always reflects the
 * latest layered intelligence (base + tenant + repo) without copies
 * needing to be re-synced.
 */
function ensureClaudeConfigSymlink(workingDir: string, coroIntelligenceDir: string, logger: Logger): void {
  const target = path.join(coroIntelligenceDir, '.claude')
  const link = path.join(workingDir, '.claude')
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) return
    rmSync(link, { recursive: true })
  } catch { /* doesn't exist yet — expected */ }
  try {
    symlinkSync(target, link, 'dir')
  } catch (err) {
    logger.warn({ err, target, link }, 'Could not create .claude symlink')
  }
}

/**
 * Very short per-phase kickoff message. The system prompt already carries
 * the workflow, agent role, and job state — this message just nudges the
 * agent to start (or continue) work in the current phase.
 */
function buildPhaseKickoffMessage(job: Job): string {
  if (job.sessionId) {
    return (
      `You are now in phase **${job.phase}**. Your role for this phase is in the ` +
      `system prompt under "Your Role This Phase". Continue the job — do what the phase ` +
      `instructs, then let your turn end (the runner auto-advances).`
    )
  }
  return (
    `Begin phase **${job.phase}** of this ${job.type} job. Your role and the full ` +
    `workflow are in the system prompt. Follow your phase instructions and use the ` +
    `\`log\` tool to report progress.`
  )
}

// ── SDK hooks ─────────────────────────────────────────────────────────────────
//
// PreToolUse hooks fire before every tool call the model makes (builtins AND
// mcp__coro__*). Returning a `permissionDecision: 'deny'` rejects the call and
// surfaces `permissionDecisionReason` back to the model so it can course-
// correct. We use this to encode a filesystem safety guard rail that used to
// live as prose in agent MDs:
//
//   `Write` / `Edit` operations must stay inside the job's working directory
//   or `coroIntelligenceDir/memory/` — this prevents a runaway agent from clobbering
//   files elsewhere on the dev machine.
//
// Both checks are cheap and deterministic, so moving them from prose to
// code trades a few kB of tokens for actual enforcement.

interface BuildHookOpts {
  /** Closure that returns the current live job — phase can change between calls. */
  liveJobRef: () => Job
  /** Absolute path to the job's working directory. */
  workingDir: string
  /** Absolute path to the Coro intelligence dir. */
  coroIntelligenceDir: string
  logger: Logger
}

function buildPhaseHooks(opts: BuildHookOpts): Record<string, Array<{ hooks: HookCallback[] }>> {
  const memoryRoot = path.join(opts.coroIntelligenceDir, 'memory')

  const deny = (reason: string): HookJSONOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const toolName = input.tool_name
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    // Guard rail: Write/Edit must stay inside working dir or memory/.
    // Bash commands with obvious write intent (e.g. `rm -rf /`) are harder
    // to validate generically, so we do the simple path check and rely on
    // the model's prose instructions for shell safety.
    if (toolName === 'Write' || toolName === 'Edit') {
      const rawPath = (toolInput['file_path'] ?? toolInput['path']) as unknown
      if (typeof rawPath === 'string' && rawPath.length > 0) {
        const abs = path.resolve(opts.workingDir, rawPath)
        const insideWorking = isInside(abs, opts.workingDir)
        const insideMemory = isInside(abs, memoryRoot)
        if (!insideWorking && !insideMemory) {
          const reason =
            `Blocked ${toolName}: "${rawPath}" resolves to ${abs}, which is outside the ` +
            `allowed write roots. Permitted: ${opts.workingDir}/** and ${memoryRoot}/**. ` +
            `Use \`propose_change\` for changes to the intelligence repo.`
          opts.logger.warn({ phase: opts.liveJobRef().phase, path: abs }, reason)
          return deny(reason)
        }
      }
    }

    if (toolName === 'Bash') {
      const command = toolInput['command']
      if (typeof command === 'string' && command.trim().length > 0) {
        const denialReason = getBashPathDenialReason(command, opts.workingDir, memoryRoot)
        if (denialReason) {
          opts.logger.warn({ phase: opts.liveJobRef().phase, command }, denialReason)
          return deny(denialReason)
        }
      }
    }

    return {}
  }

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
  }
}

/** Path containment check, defends against '..' escapes. */
function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function getBashPathDenialReason(command: string, workingDir: string, memoryRoot: string): string | null {
  for (const rawToken of tokenizeShellCommand(command)) {
    const candidate = extractPathCandidate(rawToken)
    if (!candidate) continue

    if (candidate === '~' || candidate.startsWith('~/')) {
      return bashPathReason(command, candidate, 'home-relative path', workingDir, memoryRoot)
    }

    if (
      candidate.includes('$HOME') || candidate.includes('${HOME}') ||
      candidate.includes('$OLDPWD') || candidate.includes('${OLDPWD}')
    ) {
      return bashPathReason(command, candidate, 'home-directory environment reference', workingDir, memoryRoot)
    }

    const pwdExpanded = expandPwdPath(candidate, workingDir)
    if (pwdExpanded) {
      if (!isInside(pwdExpanded, workingDir) && !isInside(pwdExpanded, memoryRoot)) {
        return bashPathReason(command, candidate, `path ${pwdExpanded}`, workingDir, memoryRoot)
      }
      continue
    }

    if (hasParentTraversal(candidate)) {
      return bashPathReason(command, candidate, 'parent-directory traversal', workingDir, memoryRoot)
    }

    if (candidate.startsWith('/')) {
      const abs = path.resolve(candidate)
      if (!isInside(abs, workingDir) && !isInside(abs, memoryRoot)) {
        return bashPathReason(command, candidate, `path ${abs}`, workingDir, memoryRoot)
      }
    }
  }

  return null
}

function tokenizeShellCommand(command: string): string[] {
  return command.match(/'[^']*'|"[^"]*"|`[^`]*`|\S+/g) ?? []
}

function extractPathCandidate(token: string): string | null {
  const unquoted = stripShellQuotes(token)
  const value = extractAssignmentValue(unquoted)
  if (!looksLikePathReference(value)) return null
  return value
}

function stripShellQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' || first === '\'' || first === '`') && first === last) {
      return token.slice(1, -1)
    }
  }
  return token
}

function extractAssignmentValue(token: string): string {
  const envMatch = token.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/)
  if (envMatch) return envMatch[1]

  const flagMatch = token.match(/^--[^=]+=(.+)$/)
  if (flagMatch) return flagMatch[1]

  return token
}

function looksLikePathReference(token: string): boolean {
  return token === '~' || token === '..' || token === '-' ||
    token.startsWith('~/') || token.startsWith('../') || token.startsWith('./') ||
    token.startsWith('/') || token.startsWith('$HOME') || token.startsWith('${HOME}') ||
    token.startsWith('$OLDPWD') || token.startsWith('${OLDPWD}') ||
    token.startsWith('$PWD/') || token.startsWith('${PWD}/') ||
    token.includes('/..') || token.includes('../')
}

function hasParentTraversal(token: string): boolean {
  return /(^|\/)(\.\.)(\/|$)/.test(token)
}

function expandPwdPath(token: string, workingDir: string): string | null {
  if (token === '$PWD' || token === '${PWD}') return workingDir
  if (token.startsWith('$PWD/')) return path.resolve(workingDir, token.slice('$PWD/'.length))
  if (token.startsWith('${PWD}/')) return path.resolve(workingDir, token.slice('${PWD}/'.length))
  return null
}

function bashPathReason(
  command: string,
  matched: string,
  kind: string,
  workingDir: string,
  memoryRoot: string,
): string {
  return (
    `Blocked Bash: command "${command}" references ${kind} via "${matched}". ` +
    `Shell access must stay inside ${workingDir}/** or ${memoryRoot}/**.`
  )
}
