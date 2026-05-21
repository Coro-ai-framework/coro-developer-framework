import { mkdirSync, readFileSync } from 'fs'
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
import type {
  DeveloperInputChannel,
  ExecutorSessionController,
  ExecutorSubagentSpec,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorRuntime,
  PluginMcpServerConfig,
} from '../plugins/types'
import { buildSystemPrompt, computeScmPromptContext, computeTrackerPromptContext } from '../prompt/builder'
import { isRecoverableSteeringAbort } from '@coro/llm-anthropic'
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
  STATUS_CANCELLED,
  STATUS_COMPLETE,
  STATUS_FAILED,
  STATUS_AWAITING_CHILDREN,
  STATUS_AWAITING_PLAN_APPROVAL,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_AWAITING_RATE_LIMIT,
  TokenUsage,
  PhaseUsage,
} from '@coro/cloud-protocol'
import {
  isCampaignJob,
  isParkingStatus,
  isTerminalStatus,
  emptyTokenUsage,
} from './helpers'
import {
  buildJobCompletionBlockPrompt,
  buildJobCompletionFailureMessage,
  COMPLETION_GATE_MAX_RETRIES,
  evaluateCompletionGate,
} from './completion-gate'
import { assertJobPluginRequirements } from './plugin-preflight'
import {
  RateLimitExceededError,
  nextBackoffMs,
} from '@coro/plugin-sdk'
import { createGuardrailEngine, createGuardrailScmDeps } from '../guardrails'

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

/**
 * ─── Test injection seam: phase executor ───────────────────────────────────
 *
 * The runner accepts `RunJobOptions.executorImpl` so tests can replace the
 * resolved {@link PhaseExecutorRuntime} with a deterministic stub that
 * yields normalized {@link PhaseExecutorEvent}s and sets {@link PhaseSignals}.
 * This is the ONLY supported way to exercise runner.ts without an Anthropic
 * key. Production callers omit this — the runner resolves the executor
 * from `ctx.plugins` per phase based on the chosen model.
 *
 * Lockdown coverage: see `tests/runner/runner.test.ts` (uses the seam end-to-end)
 * and `tests/unit/runner-internals.test.ts` (locks pure helpers).
 */


/**
 * Optional hooks for tests and future instrumentation.
 * Production code should omit this (defaults apply).
 */
export interface RunJobOptions {
  /**
   * Replace the resolved {@link PhaseExecutorRuntime}. Tests use this to
   * simulate phase execution and set {@link PhaseSignals} without calling
   * a real model. Production code omits this; the runner resolves the
   * executor from `ctx.plugins` per phase.
   */
  executorImpl?: PhaseExecutorRuntime
  /**
   * When set, skips `loadWorkflowConfig` from disk. Pass `null` for jobs with no workflow file.
   */
  workflowConfigOverride?: WorkflowConfig | null
  /**
   * Called BEFORE the phase executor is invoked, with the
   * {@link DeveloperInputChannel} the executor will consume. The
   * dispatcher registers it under the job id so a developer message
   * arriving in the (small) gap between this call and
   * `onSessionStart` is queued and read by the executor on its very
   * first iteration.
   */
  onPhasePrepare?: (jobId: string, input: DeveloperInputChannel) => void
  /**
   * Called when the executor has set up its native session and exposes
   * an {@link ExecutorSessionController}. The dispatcher uses this to
   * store a reference so a developer message can preempt an in-flight
   * model turn / tool call via `controller.interrupt()`.
   */
  onSessionStart?: (jobId: string, controller: ExecutorSessionController) => void
  /**
   * Called when the executor's per-phase invocation has fully terminated
   * (success, error, or abort). The dispatcher uses this to drop the
   * controller and developer-input references.
   */
  onSessionEnd?: (jobId: string) => void
  /**
   * Called when the runner parks a job into
   * {@link STATUS_AWAITING_RATE_LIMIT}. The dispatcher uses this to
   * arm an in-process timer that re-resumes the job at `resumeAt`
   * (epoch ms). Production code wires this to
   * `Dispatcher.rateLimitScheduler.schedule`; tests can stub it.
   */
  onRateLimitPark?: (jobId: string, resumeAt: number) => void
  /**
   * **Test-only.** Invoked synchronously immediately before each phase
   * executor is called, with the live {@link PhaseSignals} and
   * {@link ToolContext}. Test stub executors capture these via this
   * hook so their event generator can mutate signals (`nextPhase`,
   * `awaitingEvent`, `escalated`) the way a real MCP tool call would.
   * Production code never sets this.
   */
  onPhaseExecutorBoot?: (jobId: string, ctx: { signals: PhaseSignals; toolCtx: ToolContext }) => void
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

  let workflowConfig: WorkflowConfig | null =
    options?.workflowConfigOverride !== undefined
      ? options.workflowConfigOverride
      : job.workflowPath
        ? (await loadWorkflowConfigFromRoots(
            job.workflowPath,
            [jobIntelligenceDir, settings.paths.baseLayerDir],
            logger,
          ))?.config ?? null
        : null
  let workflowConfigPath: string | null = job.workflowPath || null

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

  // Backfill `workflowPhases` for jobs created before the field existed,
  // or whose persisted snapshot fell out of sync with the workflow file.
  // This keeps the dashboard's full-pipeline strip (with not-yet-started
  // "ghost" phases) accurate without requiring developers to recreate jobs.
  if (workflowConfig) {
    const expected = workflowConfig.phases.map(p => ({
      name: p.name,
      status: p.status,
      agent: p.agent ?? null,
      ...(p.interactiveCheckpoint ? { interactiveCheckpoint: true } : {}),
    }))
    const current = job.workflowPhases ?? []
    const sameLength = current.length === expected.length
    const sameOrder = sameLength && current.every((p, i) => p.name === expected[i]?.name)
    // Also re-emit when any new per-phase field (e.g. `agent`) is
    // missing on the persisted entries — older jobs predate those
    // fields and would otherwise never be backfilled.
    const missingAgent = current.some(p => !('agent' in p))
    if (!sameOrder || missingAgent) {
      await stateBackend.updateJob(job.id, { workflowPhases: expected })
      job = { ...job, workflowPhases: expected }
    }
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

  // ── Completion-gate state ───────────────────────────────────────────────
  // Tracks consecutive runs where the agent finished the workflow's last
  // phase while work items were still unfinished. We re-run the same phase
  // with an injected pendingPrompt so the agent can self-correct via
  // `goto_phase` / `update_work_item`. After
  // `COMPLETION_GATE_MAX_RETRIES` blocks in a row, the job is failed to
  // avoid an infinite loop. The counter is reset to 0 every time the gate
  // passes or the runner makes any other phase transition.
  let completionGateAttempts = 0

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

  try {
    await stateBackend.appendLog(liveJob.id, `Runner started — phase: ${liveJob.phase}`)

    let shouldStopLoop = false
    while (!isTerminalStatus(liveJob.status)) {
      ({ job: liveJob, shouldStop: shouldStopLoop } = await refreshJobForBoundary(
        stateBackend,
        liveJob,
        logger,
        'phase-start',
      ))
      toolCtx.job = liveJob
      if (shouldStopLoop) break

      // Reset signals at the start of each phase. The MCP server is
      // (re-)created below, after the executor is resolved, so we can
      // gate file-tool registration on `executor.capabilities`.
      // Reusing the MCP server across phases can leave the transport in a
      // broken state if the previous Claude Code subprocess exited uncleanly.
      resetSignals(signals)

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
      // System prompt build is deferred until after the executor is
      // resolved — we need its `capabilities.supportsClaudeMdNativeWalkUp`
      // to decide whether to inject `.claude/CLAUDE.md` ourselves
      // (Anthropic SDK walks it natively; everyone else needs us to
      // prepend it).

      // Mid-job workflow switches (`switch_workflow`, `convert_to_campaign`)
      // mutate `liveJob.workflowPath` while the cached `workflowConfig`
      // still points at the previous lane. Detect drift and reload the
      // config from the resolved overlay so the rest of the loop dispatches
      // against the right phase set.
      if (liveJob.workflowPath && liveJob.workflowPath !== workflowConfigPath) {
        const reloaded = await loadWorkflowConfigFromRoots(
          liveJob.workflowPath,
          [jobIntelligenceDir, settings.paths.baseLayerDir],
          logger,
        )
        if (reloaded) {
          workflowConfig = reloaded.config
          workflowConfigPath = liveJob.workflowPath
          logger.info(
            {
              jobId: liveJob.id,
              workflowPath: liveJob.workflowPath,
              resolvedFrom: reloaded.resolvedFrom,
              phases: reloaded.config.phases.map(p => p.name),
            },
            'Reloaded workflow config after mid-job switch',
          )
          await stateBackend.appendLog(
            liveJob.id,
            `[workflow-reload] now running ${liveJob.workflowPath} ` +
              `(phases: ${reloaded.config.phases.map(p => p.name).join(', ')})`,
          )
        } else {
          // Workflow disappeared between switch_workflow's path-existence
          // check and now (e.g. a tenant overlay refresh removed it). Fail
          // fast — the old config no longer matches the active path.
          const message =
            `Cannot resolve workflow '${liveJob.workflowPath}' for job ${liveJob.id} ` +
            `after mid-job switch. Failing the job — fix the intelligence path.`
          logger.error({ jobId: liveJob.id, workflowPath: liveJob.workflowPath }, message)
          await stateBackend.appendLog(liveJob.id, `[error] ${message}`)
          liveJob = await syncJob(stateBackend, liveJob, {
            status: STATUS_FAILED,
            escalationMessage: message,
          })
          toolCtx.job = liveJob
          break
        }
      }

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

      // Clear pendingPrompt immediately so it isn't replayed on the next turn.
      if (liveJob.pendingPrompt) {
        liveJob = await syncJob(stateBackend, liveJob, { pendingPrompt: undefined })
        toolCtx.job = liveJob
      }

      // Per-phase developer override (set via dashboard) wins over the
      // workflow's declared model/tier — the developer made an explicit,
      // immediate choice. We synthesise a phaseConf-shaped object so the
      // existing `selectModel` alias/tier resolution still applies (e.g.
      // override `model: "tier:coding"` resolves through aliases like any
      // other reference). The optional `provider` is forwarded to
      // `resolveExecutor` so the override can target any installed plugin.
      const override = liveJob.phaseModelOverrides?.[liveJob.phase]
      const effectivePhaseConf = override
        ? { ...phaseConf, model: override.model, provider: override.provider ?? phaseConf?.provider }
        : phaseConf

      const model = selectModel(effectivePhaseConf, settings)
      const workingDir = path.join(settings.paths.workingDir, liveJob.id)
      /** SDK spawns Claude Code with `cwd: workingDir`. Missing dir causes spawn ENOENT, which the SDK misreports as "cli.js not found". */
      mkdirSync(workingDir, { recursive: true })

      // Resolve the executor early so its `capabilities` can drive
      // prompt/subagent assembly (CLAUDE.md injection, etc.). Test
      // injection still wins via `options.executorImpl`.
      const executor: PhaseExecutorRuntime =
        options?.executorImpl ?? ctx.plugins.resolveExecutor({
          model,
          provider: effectivePhaseConf?.provider,
        })

      // Surface the resolved provider/model in the activity log so
      // developers can see, per phase, which executor + model is
      // actually running. With per-phase model overrides this is no
      // longer obvious from the workflow file alone (alias indirection,
      // tenant defaults, sole-installed fallback).
      {
        const aliasKey =
          effectivePhaseConf?.model && settings.llm?.aliases?.[effectivePhaseConf.model]
            ? effectivePhaseConf.model
            : undefined
        const aliasEntry = aliasKey ? settings.llm?.aliases?.[aliasKey] : undefined
        const parts = [`provider=${executor.manifest.id}`, `model=${model || '<default>'}`]
        if (aliasKey) parts.push(`alias=${aliasKey}`)
        if (aliasEntry?.reasoningEffort) parts.push(`effort=${aliasEntry.reasoningEffort}`)
        if (override) parts.push('override=developer')
        await stateBackend.appendLog(liveJob.id, `Model: ${parts.join(' ')}`)
      }

      // Fresh MCP server per phase. File/skill tools are registered only
      // for executors that don't bring native equivalents — Claude SDK
      // ships its own Read/Write/Edit/Glob/Grep + Skill, so we skip them
      // there to avoid a doubled tool surface. The `run_subagent` tool
      // is the inverse: only registered when the executor lacks a
      // native subagent dispatcher (Anthropic's SDK has one; OpenAI
      // and friends fall back to this MCP tool). Cross-provider
      // subagents pinned via `subagents: [{ provider: ... }]` also
      // need the MCP fallback — Anthropic's native `agents:` map
      // can only host Claude models — so we enable the tool when any
      // declared subagent targets a different provider.
      const hasCrossProviderSubagent = (phaseConf?.subagents ?? []).some(
        sa => sa.provider && sa.provider !== executor.manifest.id,
      )
      const mcpServerOpts = {
        registerFileTools: !executor.capabilities.supportsNativeFileTools,
        registerRunSubagent:
          !executor.capabilities.supportsNativeSubagents || hasCrossProviderSubagent,
      }
      let phaseMcpServer = createCoroMcpServer(toolCtx, signals, mcpServerOpts)

      const systemPrompt = await buildSystemPrompt(
        liveJob,
        jobIntelligenceDir,
        logger,
        trackerInfo,
        scmInfo,
        executor.capabilities,
      )
      const promptSizeKb = (Buffer.byteLength(systemPrompt, 'utf-8') / 1024).toFixed(1)
      logger.info(
        { jobId: liveJob.id, phase: liveJob.phase, promptSizeKb: Number(promptSizeKb) },
        `System prompt assembled: ${promptSizeKb} KB`,
      )
      await stateBackend.appendLog(liveJob.id, `System prompt: ${promptSizeKb} KB`)

      // Build subagent specs from workflow config. Agent prompts are
      // loaded here and handed to the executor via
      // {@link PhaseExecutionRequest.subagents}; the executor decides
      // how to dispatch them (Anthropic's native SDK `agents:` map vs.
      // the runner's `run_subagent` MCP tool fallback for non-native
      // executors). `.claude/CLAUDE.md` is prepended only when the
      // executor lacks native walk-up — mirrors the system-prompt
      // injection above.
      const subagentSpecs: ReadonlyArray<ExecutorSubagentSpec> | undefined = phaseConf?.subagents
        ? buildExecutorSubagentSpecs(
            phaseConf.subagents,
            jobIntelligenceDir,
            settings,
            { prependClaudeMd: !executor.capabilities.supportsClaudeMdNativeWalkUp },
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
        ({ job: liveJob, shouldStop: shouldStopLoop } = await refreshJobForBoundary(
          stateBackend,
          liveJob,
          logger,
          'agentless-park',
        ))
        toolCtx.job = liveJob
        if (shouldStopLoop) break

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
        'Starting phase executor',
      )

      // ── Phase executor invocation ────────────────────────────────────────
      //
      // The runner resolves a {@link PhaseExecutorRuntime} per phase and
      // delegates the entire model + tool loop to it. The executor owns
      // SDK setup (hooks, MCP wiring, queryOptions, session resume,
      // agents map), yields normalized {@link PhaseExecutorEvent}s, and
      // emits exactly one `done` event with the next session state.
      //
      // The runner's job here is:
      //   1. Build the {@link PhaseExecutionRequest} from the resolved
      //      phase config + intelligence layer + plugin registry.
      //   2. Hand the dispatcher the executor's neutral
      //      {@link DeveloperInputChannel} (so steering messages reach
      //      the live tool loop) and {@link ExecutorSessionController}
      //      (so cancel/preempt is provider-agnostic).
      //   3. Translate normalized events into the same log/state side
      //      effects the runner has always produced (appendLog, syncJob,
      //      phaseUsage snapshots, MCP-usage counters).
      //
      // (`executor` is resolved earlier in the loop so its capabilities
      // can drive system-prompt + subagent assembly.)

      // Developer-input channel handed to the executor. It starts as a
      // no-op pair; the executor reassigns `push`/`close` early in
      // `executePhase` (synchronously, before any await) so that
      // dispatcher messages routed via this channel end up in the
      // executor's live SDK input pushable. The mutation is observed
      // by every subsequent `.push` because the dispatcher captured the
      // same object reference via `onPhasePrepare` below.
      const developerInput: DeveloperInputChannel = {
        push: () => { /* replaced by executor on session start */ },
        close: () => { /* replaced by executor on session start */ },
      }

      // Register BEFORE the executor runs so any developer message that
      // races with phase startup lands in the executor's input on its
      // first iteration. Mirrors the legacy `onPhasePrepare` contract.
      options?.onPhasePrepare?.(liveJob.id, developerInput)

      const pluginMcpServers = collectPluginMcpServers({ plugins: ctx.plugins, logger })
      const userMcpServers = collectUserMcpServers({ logger })
      const mergedPluginMcpServers = {
        ...pluginMcpServers,
        ...userMcpServers,
      } as unknown as Record<string, PluginMcpServerConfig>

      if (Object.keys(pluginMcpServers).length > 0) {
        logger.info(
          {
            jobId: liveJob.id,
            phase: liveJob.phase,
            pluginMcpServers: Object.keys(pluginMcpServers),
          },
          'Attached plugin-provided MCP servers to phase executor',
        )
      }

      // `resume: sessionId` carries the previous transcript forward.
      // Cheap and usually desirable; opt-out via `CORO_DISABLE_SESSION_RESUME`.
      const resumeDisabled = process.env.CORO_DISABLE_SESSION_RESUME === '1'
        || process.env.CORO_DISABLE_SESSION_RESUME === 'true'
      const resumeSessionId = !resumeDisabled && liveJob.sessionId ? liveJob.sessionId : undefined

      const abortController = new AbortController()

      const guardrailEngine = createGuardrailEngine(loadLocalConfig(), {
        scm: createGuardrailScmDeps(toolCtx),
        activityLog: line => stateBackend.appendLog(toolCtx.job.id, line),
      })
      const guardrailPreToolUse = (toolName: string, input: unknown) => {
        const toolInput = (input && typeof input === 'object')
          ? input as Record<string, unknown>
          : {}
        const decision = guardrailEngine.evaluateToolBefore({
          toolName,
          toolInput,
          job: liveJob,
          workingDir,
        })
        return decision.then(d => ({
          allow: d.allow,
          ...(d.reason ? { reason: d.reason } : {}),
        }))
      }

      const req: PhaseExecutionRequest = {
        systemPrompt,
        userPrompt: promptText,
        model,
        cwd: workingDir,
        intelligenceDir: jobIntelligenceDir,
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: phaseMcpServer },
        mcpRebuild: () => {
          phaseMcpServer = createCoroMcpServer(toolCtx, signals, mcpServerOpts)
          return { kind: 'sdk-instance' as const, id: 'coro', instance: phaseMcpServer }
        },
        pluginMcpServers: mergedPluginMcpServers,
        subagents: subagentSpecs,
        hookPolicy: {
          allowedTools: phaseConf?.tools ?? null,
          writeRoots: [workingDir, jobIntelligenceDir],
          onPreToolUse: (toolName, input) => guardrailPreToolUse(toolName, input),
        },
        sessionState: { sessionId: resumeSessionId },
        maxTurns: 200,
        signal: abortController.signal,
        phase: liveJob.phase,
        lifecycle: {
          onSessionStart: (controller: ExecutorSessionController) => {
            options?.onSessionStart?.(liveJob.id, controller)
          },
          onSessionEnd: () => options?.onSessionEnd?.(liveJob.id),
        },
        developerInput,
      }

      // Phase-local accumulators. The executor reports tokens via
      // cumulative `usage` events (the final one carries authoritative
      // totals plus provider-reported cost). The runner derives the
      // per-phase cost via `derivePhaseCostUsd` so resumed-session
      // double-counting stays handled identically to the legacy path.
      let sessionId: string | undefined = resumeSessionId
      const phaseTokens: TokenUsage = emptyTokenUsage()
      const prePhaseUsage: TokenUsage = { ...(liveJob.tokenUsage ?? emptyTokenUsage()) }
      let phaseTurns = 0
      let lastUsageSyncTurn = 0
      const phaseStartMs = Date.now()
      let phaseSnapshotRecorded = false
      let builtinToolUseCount = 0
      let mcpToolUseCount = 0
      let lastReportedCostUsd: number | undefined
      let lastReportedModelUsage: Record<string, {
        inputTokens: number
        outputTokens: number
        cacheReadInputTokens: number
        cacheCreationInputTokens: number
        totalCostUsd?: number
      }> | undefined
      let doneMetrics: { durationMs?: number; durationApiMs?: number; numTurns?: number } | undefined

      // Test-only: hand the live signals + toolCtx to a stub executor.
      options?.onPhaseExecutorBoot?.(liveJob.id, { signals, toolCtx })

      // Snapshot the per-phase context onto toolCtx so MCP tool
      // handlers (notably `run_subagent`) can look up the active
      // executor, hook policy, and MCP-server descriptors when an
      // agent invokes them mid-phase. Re-assigned wholesale every
      // iteration; cleared in the `finally` below.
      toolCtx.currentPhase = phaseConf
        ? {
            phaseConf,
            executor,
            workingDir,
            jobIntelligenceDir,
            hookPolicy: req.hookPolicy,
            mcpServer: req.mcpServer,
            pluginMcpServers: req.pluginMcpServers,
          }
        : undefined

      try {
        for await (const ev of executor.executePhase(req) as AsyncIterable<PhaseExecutorEvent>) {
          switch (ev.type) {
            case 'session_start': {
              if (ev.sessionId) sessionId = ev.sessionId
              break
            }
            case 'text': {
              if (ev.content.trim()) {
                await stateBackend.appendLog(liveJob.id, ev.content)
              }
              break
            }
            case 'thinking': {
              await appendChunkedLog(stateBackend, liveJob.id, '[thinking] ', ev.content)
              break
            }
            case 'tool_call': {
              if (ev.input !== undefined && ev.input !== null) {
                await appendChunkedLog(
                  stateBackend,
                  liveJob.id,
                  `→ ${ev.toolName} `,
                  JSON.stringify(ev.input),
                )
              } else {
                await stateBackend.appendLog(liveJob.id, `→ ${ev.toolName}`)
              }
              if (ev.toolName.startsWith('mcp__coro__')) mcpToolUseCount++
              else builtinToolUseCount++
              break
            }
            case 'tool_result': {
              // Tool-result surfacing happens via the executor's own log
              // events (mirrors legacy `tool_use_summary`/`tool_progress`).
              break
            }
            case 'usage': {
              // Cumulative snapshot — replace running counts. The
              // executor emits a final `usage` right before `done` with
              // authoritative totals (and `totalCostUsd` when the
              // provider reports it).
              phaseTokens.inputTokens = ev.tokens.inputTokens
              phaseTokens.outputTokens = ev.tokens.outputTokens
              phaseTokens.cacheReadInputTokens = ev.tokens.cacheReadInputTokens
              phaseTokens.cacheCreationInputTokens = ev.tokens.cacheCreationInputTokens
              if (ev.tokens.totalCostUsd !== undefined) {
                lastReportedCostUsd = ev.tokens.totalCostUsd
              }
              if (ev.modelUsage) {
                lastReportedModelUsage = ev.modelUsage as typeof lastReportedModelUsage
              }
              phaseTurns++
              if (phaseTurns - lastUsageSyncTurn >= 5) {
                lastUsageSyncTurn = phaseTurns
                const merged = mergeTokenUsage(prePhaseUsage, phaseTokens)
                liveJob = await syncJob(stateBackend, liveJob, { tokenUsage: merged })
                toolCtx.job = liveJob
              }
              break
            }
            case 'log': {
              const meta = { jobId: liveJob.id, phase: liveJob.phase, ...(ev.meta ?? {}) }
              if (ev.level === 'error') logger.error(meta, ev.message)
              else if (ev.level === 'warn') logger.warn(meta, ev.message)
              else logger.info(meta, ev.message)
              // Mirror executor `log` events into the per-job log so
              // dashboards keep showing them. The executor owns the
              // human-readable prefix (`[tool_summary]`, `[result]`,
              // `[error]`, `⏳`, `[sdk-stderr]`, `[event:X]`, …); the
              // runner just chunks long lines.
              if (typeof ev.message === 'string' && ev.message.trim()) {
                await appendChunkedLog(stateBackend, liveJob.id, '', ev.message)
              }
              break
            }
            case 'done': {
              if (ev.sessionState?.sessionId) sessionId = ev.sessionState.sessionId
              doneMetrics = ev.metrics
              phaseSnapshotRecorded = true

              const phaseCostUsd = derivePhaseCostUsd({
                reportedTotalCostUsd: lastReportedCostUsd,
                phaseTokens,
                prePhaseCostUsd: prePhaseUsage.totalCostUsd,
                resumedSessionId: resumeSessionId,
              })
              phaseTokens.totalCostUsd = phaseCostUsd

              const phaseSnapshot: PhaseUsage = {
                phase: liveJob.phase,
                // Stamp the active work item (if any) so the dashboard can
                // group repeats per item without needing workflow-level
                // loop metadata. Phases that ran before the planner posted
                // any items (spec-writing, planning) leave this undefined.
                ...(liveJob.currentWorkItem ? { workItem: liveJob.currentWorkItem } : {}),
                inputTokens: phaseTokens.inputTokens,
                outputTokens: phaseTokens.outputTokens,
                cacheReadInputTokens: phaseTokens.cacheReadInputTokens,
                cacheCreationInputTokens: phaseTokens.cacheCreationInputTokens,
                costUsd: phaseCostUsd,
                durationMs: doneMetrics?.durationMs ?? (Date.now() - phaseStartMs),
                durationApiMs: doneMetrics?.durationApiMs ?? 0,
                numTurns: doneMetrics?.numTurns ?? phaseTurns,
                model,
                modelUsage: lastReportedModelUsage
                  ? Object.fromEntries(
                      Object.entries(lastReportedModelUsage).map(([m, u]) => [m, {
                        inputTokens: u.inputTokens,
                        outputTokens: u.outputTokens,
                        costUSD: u.totalCostUsd ?? 0,
                      }]),
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
              break
            }
          }

          // Early break on exception signals so we don't keep pulling
          // events after the agent has asked us to park, escalate, or
          // re-route. The absence of any signal simply lets the stream
          // drain naturally and then auto-advances.
          if (signals.nextPhase || signals.awaitingEvent || signals.escalated) {
            break
          }
        }
      } finally {
        // Close the developer-input channel so the executor's internal
        // SDK iterable can finish cleanly. The executor's
        // `lifecycle.onSessionEnd` is responsible for calling
        // `options?.onSessionEnd` itself.
        try { developerInput.close() } catch { /* best-effort */ }
        // Drop the per-phase context — any in-flight `run_subagent`
        // calls have either resolved or aborted with the parent.
        toolCtx.currentPhase = undefined
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

      ({ job: liveJob, shouldStop: shouldStopLoop } = await refreshJobForBoundary(
        stateBackend,
        liveJob,
        logger,
        'post-query',
      ))
      toolCtx.job = liveJob
      if (shouldStopLoop) break

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
        ({ job: liveJob, shouldStop: shouldStopLoop } = await refreshJobForBoundary(
          stateBackend,
          liveJob,
          logger,
          'before-awaiting-event-park',
        ))
        toolCtx.job = liveJob
        if (shouldStopLoop) break

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
        ({ job: liveJob, shouldStop: shouldStopLoop } = await refreshJobForBoundary(
          stateBackend,
          liveJob,
          logger,
          'before-complete',
        ))
        toolCtx.job = liveJob
        if (shouldStopLoop) break

        // ── Completion gate ────────────────────────────────────────────
        // Workflow-agnostic: block STATUS_COMPLETE when registered work
        // items are still pending or in-progress. Re-run the current
        // phase with a corrective pendingPrompt so the agent uses its
        // workflow MD to decide where to route work next.
        const gate = evaluateCompletionGate(liveJob)
        if (!gate.ready) {
          completionGateAttempts += 1
          if (completionGateAttempts > COMPLETION_GATE_MAX_RETRIES) {
            const failure = buildJobCompletionFailureMessage(gate)
            logger.warn(
              { jobId: liveJob.id, attempts: completionGateAttempts },
              'Completion gate exhausted retries — failing job',
            )
            await stateBackend.appendLog(liveJob.id, `[completion-gate] ${failure}`)
            liveJob = await syncJob(stateBackend, liveJob, {
              status: STATUS_FAILED,
              escalationMessage: failure,
            })
            toolCtx.job = liveJob
            break
          }

          const blockedNames = gate.blockingWorkItems.map(w => w.name).join(', ')
          logger.info(
            {
              jobId: liveJob.id,
              phase: liveJob.phase,
              attempt: completionGateAttempts,
              blocking: blockedNames,
            },
            'Completion gate blocked — re-running current phase with corrective prompt',
          )
          await stateBackend.appendLog(
            liveJob.id,
            `[completion-gate] Blocking job completion (${gate.blockingWorkItems.length} unfinished ` +
              `work item(s): ${blockedNames}). Re-running phase '${liveJob.phase}' ` +
              `(attempt ${completionGateAttempts}/${COMPLETION_GATE_MAX_RETRIES}).`,
          )
          liveJob = await syncJob(stateBackend, liveJob, {
            pendingPrompt: buildJobCompletionBlockPrompt(
              liveJob,
              gate,
              completionGateAttempts,
            ),
          })
          toolCtx.job = liveJob
          continue
        }

        completionGateAttempts = 0
        liveJob = await syncJob(stateBackend, liveJob, { status: STATUS_COMPLETE })
        await stateBackend.appendLog(liveJob.id, 'All phases complete — job finished successfully')
        logger.info({ jobId: liveJob.id }, 'Job completed')
        break
      }

      // Any non-completion advance resets the gate counter — only
      // consecutive end-of-workflow blocks count toward the cap.
      completionGateAttempts = 0

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
        ({ job: liveJob, shouldStop: shouldStopLoop } = await refreshJobForBoundary(
          stateBackend,
          liveJob,
          logger,
          'before-interactive-park',
        ))
        toolCtx.job = liveJob
        if (shouldStopLoop) break

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

      ({ job: liveJob, shouldStop: shouldStopLoop } = await refreshJobForBoundary(
        stateBackend,
        liveJob,
        logger,
        'before-phase-advance',
      ))
      toolCtx.job = liveJob
      if (shouldStopLoop) break

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
    // ── Rate-limit / overload park ─────────────────────────────────────────
    // Provider executors (Anthropic, OpenAI, …) wrap 429/529-class errors
    // in `RateLimitExceededError`. We park the job into
    // `STATUS_AWAITING_RATE_LIMIT`, persist provider/kind/resumeAt so the
    // dashboard can render a countdown, and ask the dispatcher to schedule
    // an auto-resume. Crucially we DO NOT clear `sessionId` — Anthropic
    // sessions resume cleanly; OpenAI's executor returns
    // `supportsSessionResume: false` so the next run starts fresh by
    // design.
    if (err instanceof RateLimitExceededError) {
      try {
        const fresh = await stateBackend.getJob(liveJob.id)
        // If something else already moved the job to a terminal/parked
        // state (cancel raced the throw), don't clobber it.
        if (fresh && !isTerminalStatus(fresh.status) && fresh.status !== STATUS_AWAITING_RATE_LIMIT) {
          const previousAttempt = fresh.rateLimitInfo?.retryAttempt ?? 0
          const attempt = previousAttempt + 1
          // When the hint came from an authoritative server-provided
          // deadline (Retry-After / RateLimit-Reset header, or the
          // Claude Code subprocess `rate_limit_event.resetsAt`), honor
          // it verbatim — these can legitimately be hours out (5-hour
          // session budgets, weekly caps) and the default 30-minute
          // cap would cause repeated wake-and-fail cycles.
          const honorHintExactly = err.info.source === 'reset-header' || err.info.source === 'retry-after'
          const resumeAt = Date.now() + nextBackoffMs(attempt, err.info.retryAfterMs, { honorHintExactly })
          await stateBackend.updateJob(liveJob.id, {
            status: STATUS_AWAITING_RATE_LIMIT,
            rateLimitInfo: {
              provider: err.provider,
              kind: err.info.kind,
              resumeAt,
              retryAttempt: attempt,
              source: err.info.source,
              lastErrorMessage: err.message,
            },
          })
          const waitSec = Math.round((resumeAt - Date.now()) / 1000)
          await stateBackend.appendLog(
            liveJob.id,
            `[rate-limit] ${err.provider} ${err.info.kind} — parking job (attempt ${attempt}); auto-resume in ~${waitSec}s`,
          )
          logger.warn(
            { jobId: liveJob.id, provider: err.provider, kind: err.info.kind, attempt, resumeAt },
            'Job parked on provider rate-limit',
          )
          options?.onRateLimitPark?.(liveJob.id, resumeAt)
        } else {
          logger.info(
            { jobId: liveJob.id, status: fresh?.status },
            'Rate-limit thrown but job already parked/terminal — skipping re-park',
          )
        }
      } catch (parkErr) {
        // If we cannot persist the park (state backend down) we have no
        // safe option but to mark failed so the developer notices.
        logger.error({ err: parkErr, jobId: liveJob.id }, 'Failed to persist rate-limit park')
        try {
          await stateBackend.updateJob(liveJob.id, {
            status: STATUS_FAILED,
            escalationMessage: `Rate-limit park failed: ${String(parkErr)}`,
          })
        } catch {
          // best-effort
        }
      }
      return
    }

    // If the job was just transitioned into a parking status by an
    // out-of-band controller (most commonly the dispatcher's `pauseJob`
    // calling `q.interrupt()`), the SDK reports the interrupted tool
    // call as a synthetic `is_error: true` result with payload like
    // `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`,
    // and re-throws it from `readMessages()`. That's not a crash — the
    // park already happened — so we must not flip the job to FAILED and
    // overwrite the `awaiting-developer-input` patch the pause path
    // just persisted. Treat the throw as the expected end of the run.
    let postPark: { status: string } | undefined
    try {
      const current = await stateBackend.getJob(liveJob.id)
      if (current) postPark = { status: current.status }
    } catch {
      // Ignore — fall through and treat as a real crash.
    }

    if (postPark && isParkingStatus(postPark.status)) {
      logger.info(
        { jobId: liveJob.id, status: postPark.status, err: String(err) },
        'Agent stream ended after job entered a parking status — treating as a clean park, not a crash',
      )
      await stateBackend.appendLog(
        liveJob.id,
        `[control] Agent stream stopped after pause/park — current turn ended at the safe boundary.`,
      )
    } else if (isRecoverableSteeringAbort(err)) {
      logger.info(
        { jobId: liveJob.id, err: String(err) },
        'Agent stream ended after recoverable steering interrupt — not marking job failed',
      )
      await stateBackend.appendLog(
        liveJob.id,
        `[control] Agent turn ended after developer steering interrupt — job continues.`,
      )
    } else {
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

const MAX_ACTIVITY_LOG_ENTRY_CHARS = 1600

function splitLogTextIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars)
    if (splitAt <= maxChars / 2) splitAt = remaining.lastIndexOf(' ', maxChars)
    if (splitAt <= maxChars / 2) splitAt = maxChars

    const chunk = remaining.slice(0, splitAt)
    if (chunk) chunks.push(chunk)

    remaining = remaining.slice(splitAt)
    if (remaining.startsWith('\n')) remaining = remaining.slice(1)
    while (remaining.startsWith(' ')) remaining = remaining.slice(1)
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

export async function appendChunkedLog(
  stateBackend: StateBackend,
  jobId: string,
  prefix: string,
  text: string,
): Promise<void> {
  const payload = text.replace(/\r\n/g, '\n')
  if (!payload) {
    await stateBackend.appendLog(jobId, prefix.trimEnd())
    return
  }

  const chunkBudget = Math.max(256, MAX_ACTIVITY_LOG_ENTRY_CHARS - prefix.length)
  const chunks = splitLogTextIntoChunks(payload, chunkBudget)

  for (const chunk of chunks) {
    await stateBackend.appendLog(jobId, `${prefix}${chunk}`)
  }
}

async function syncJob(
  stateBackend: StateBackend,
  job: Job,
  patch: Partial<Job>,
): Promise<Job> {
  return stateBackend.updateJob(job.id, patch)
}

async function refreshJobForBoundary(
  stateBackend: StateBackend,
  job: Job,
  logger: Logger,
  boundary: string,
): Promise<{ job: Job; shouldStop: boolean }> {
  const fresh = await stateBackend.getJob(job.id)
  if (!fresh) {
    return { job, shouldStop: false }
  }

  // Stop on terminal status (already handled before the parking-status
  // expansion below). Terminal == complete | cancelled.
  if (isTerminalStatus(fresh.status)) {
    if (fresh.status === STATUS_CANCELLED && job.status !== STATUS_CANCELLED) {
      logger.info(
        { jobId: fresh.id, phase: fresh.phase, boundary },
        'Job cancelled externally — stopping runner at safe boundary',
      )
    }
    return { job: fresh, shouldStop: true }
  }

  // ALSO stop when the persisted status flipped to a parking status
  // *externally* (e.g. dispatcher.pauseJob set awaiting-developer-input).
  // The runner-internal park path sets the same status and then `break`s
  // the loop itself, so detecting the divergence between previous
  // in-memory `job.status` and the freshly-loaded `fresh.status` tells
  // us the change came from outside the loop.
  if (isParkingStatus(fresh.status) && fresh.status !== job.status) {
    logger.info(
      { jobId: fresh.id, phase: fresh.phase, boundary, awaitingEvent: fresh.awaitingEvent },
      'Job parked externally — stopping runner at safe boundary',
    )
    return { job: fresh, shouldStop: true }
  }

  return { job, shouldStop: false }
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

/**
 * Claude Code reports `total_cost_usd` on the result frame, but on resumed
 * sessions that value is cumulative for the whole session, not a phase-local
 * delta. We store per-phase costs, so resumed sessions must subtract the job's
 * pre-phase cost baseline. We also never book non-zero cost for phases with no
 * billable token usage.
 */
export function derivePhaseCostUsd(args: {
  reportedTotalCostUsd: unknown
  phaseTokens: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>
  prePhaseCostUsd: number
  resumedSessionId?: string
}): number {
  const rawCostUsd = typeof args.reportedTotalCostUsd === 'number' && Number.isFinite(args.reportedTotalCostUsd)
    ? Math.max(args.reportedTotalCostUsd, 0)
    : 0

  const hasBillableTokens = args.phaseTokens.inputTokens > 0
    || args.phaseTokens.outputTokens > 0
    || args.phaseTokens.cacheReadInputTokens > 0
    || args.phaseTokens.cacheCreationInputTokens > 0

  if (!hasBillableTokens) return 0
  if (!args.resumedSessionId) return rawCostUsd

  const deltaCostUsd = rawCostUsd - args.prePhaseCostUsd
  if (deltaCostUsd >= 0) return deltaCostUsd

  return rawCostUsd
}

/**
 * Resolve the concrete model id a phase (or subagent) should run on.
 *
 * Resolution order (executor-agnostic):
 *   1. `phaseConf.model` is treated as an alias key — if present in
 *      `settings.llm.aliases`, return the alias's `model` field.
 *   2. Otherwise treat `phaseConf.model` as a literal model id and
 *      return it verbatim. This is how workflows pin a specific model
 *      (e.g. `gpt-5-codex`, `claude-sonnet-4-7`).
 *   3. When no `model` is set, fall back to `tier:<phaseConf.tier>`
 *      (the tier alias each LLM plugin publishes via
 *      {@link PhaseExecutorRuntime.defaultAliases}).
 *   4. Final fallback: `tier:planning` → `planning` legacy alias.
 *
 * `settings.llm.aliases` is seeded from each executor plugin's
 * {@link PhaseExecutorRuntime.defaultAliases} at bootstrap, so the
 * built-in plugins keep `tier:*` (and the legacy `planning`/`coding`
 * shorthands) working without any tenant-side config.
 */
export function selectModel(
  phaseConf: { model?: string; tier?: string } | null | undefined,
  settings: Settings,
): string {
  const aliases = settings.llm?.aliases ?? {}
  // 1. Explicit model wins (alias key OR literal model id pass-through).
  if (phaseConf?.model) {
    const alias = aliases[phaseConf.model]
    return alias ? alias.model : phaseConf.model
  }
  // 2. Tier fallback — declarative "this phase needs <tier>".
  const tier = phaseConf?.tier || 'planning'
  const tierAlias = aliases[`tier:${tier}`]
  if (tierAlias) return tierAlias.model
  // 3. Last-resort: legacy `planning`/`coding` shorthand for tenants
  //    that pre-date `tier:*` defaults. When even that misses, return
  //    the bare tier name as a literal model id — the registry's
  //    executor lookup will surface a clear "unknown model" error.
  const legacy = aliases[tier]
  if (legacy) return legacy.model
  return tier
}

/**
 * Collects every active plugin's `mcpServer()` descriptor and returns a
 * `Record<pluginId, PluginMcpServerConfig>` ready to merge into the
 * executor's `pluginMcpServers` request field.
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
}): Record<string, PluginMcpServerConfig> {
  const result: Record<string, PluginMcpServerConfig> = {}
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
      result[id] = (toolsPolicy
        ? { ...descriptor, tools: toolsPolicy }
        : descriptor) as unknown as PluginMcpServerConfig
    } else {
      // stdio descriptors don't accept `tools` directly in the SDK
      // typing; the SDK's `setMcpServers` ignores the field for stdio,
      // and the curated tool list is applied via `disallowedTools` /
      // `allowedTools` in the SDK's permission system. We pass it
      // through unchanged here and rely on the per-plugin manifest's
      // capability flags to drive the prompt-side curation in S2.
      result[id] = descriptor as unknown as PluginMcpServerConfig
    }
  }

  return result
}

/**
 * Collects bring-your-own MCP servers from the local config
 * (`~/.coro/config.json` → `mcpServers`). Returns a `Record<id,
 * PluginMcpServerConfig>` ready to merge into the executor's
 * `pluginMcpServers` request field, exactly mirroring the shape
 * `collectPluginMcpServers` emits.
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
export function collectUserMcpServers(args: { logger: Logger }): Record<string, PluginMcpServerConfig> {
  const result: Record<string, PluginMcpServerConfig> = {}
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
      result[id] = (toolsPolicy ? { ...desc, tools: toolsPolicy } : desc) as unknown as PluginMcpServerConfig
    } else if (raw.type === 'stdio') {
      const desc = {
        type: 'stdio' as const,
        command: raw.command,
        ...(raw.args ? { args: raw.args } : {}),
        ...(raw.env ? { env: raw.env } : {}),
      }
      result[id] = desc as unknown as PluginMcpServerConfig
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

/**
 * Build {@link ExecutorSubagentSpec}s from workflow subagent config.
 *
 * Emits the executor-facing shape: just `name`, prepared `systemPrompt`,
 * optional `model`, and optional `allowedTools`. MCP server propagation
 * is the executor's responsibility (the runner hands it the full
 * `pluginMcpServers` map and a single `mcpServer`; how those reach
 * subagents is the executor's call — Anthropic-flavoured executors
 * merge both onto every subagent in the SDK `agents:` map).
 *
 * Provider neutrality: subagent `model` is resolved through
 * {@link selectModel} (alias-first, literal-passthrough). Any
 * provider-specific model coercion (e.g. Anthropic's `'opus' | 'sonnet'`
 * tier shorthand) is the executor's responsibility, not the runner's.
 *
 * `.claude/CLAUDE.md` is prepended only when the resolved executor
 * lacks native walk-up (`!capabilities.supportsClaudeMdNativeWalkUp`).
 * Anthropic's SDK loads CLAUDE.md natively via `settingSources:
 * ['project']`, so prepending would duplicate it; non-Claude executors
 * need the file injected manually for parity.
 */
export function buildExecutorSubagentSpecs(
  subagents: SubagentConfig[],
  intelligenceDir: string,
  settings: Settings,
  options: { prependClaudeMd: boolean } = { prependClaudeMd: true },
): ExecutorSubagentSpec[] {
  let claudeMdContent = ''
  if (options.prependClaudeMd) {
    try {
      claudeMdContent = readFileSync(
        path.join(intelligenceDir, '.claude', 'CLAUDE.md'),
        'utf-8',
      )
    } catch { /* .claude/CLAUDE.md not found — subagents will run without it */ }
  }

  const out: ExecutorSubagentSpec[] = []
  for (const sa of subagents) {
    let agentPrompt = `You are a helper subagent named ${sa.name}.`
    if (sa.agent) {
      try {
        agentPrompt = readFileSync(
          path.join(intelligenceDir, sa.agent),
          'utf-8',
        )
      } catch {
        agentPrompt = `You are the ${sa.name} subagent. Follow your instructions carefully.`
      }
    }
    if (claudeMdContent) {
      agentPrompt = claudeMdContent + '\n\n---\n\n' + agentPrompt
    }

    // Resolve the model alias-first, literal-passthrough. The executor
    // applies any provider-specific coercion (Anthropic's SDK accepts a
    // tier shorthand like `'opus'/'sonnet'`; OpenAI / others want a
    // literal model id).
    const resolvedModel = sa.model || sa.tier
      ? selectModel({ model: sa.model, tier: sa.tier }, settings)
      : undefined

    out.push({
      name: sa.name,
      systemPrompt: agentPrompt,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(sa.provider ? { provider: sa.provider } : {}),
      ...(sa.tools && sa.tools.length > 0 ? { allowedTools: [...sa.tools] } : {}),
    })
  }
  return out
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

