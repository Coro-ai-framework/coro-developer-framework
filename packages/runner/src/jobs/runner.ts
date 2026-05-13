import {
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
 * Live developer-input pushable. The runner creates one of these per
 * phase and passes its `iterable` as the SDK `query()` prompt. While
 * the iterable is open, the SDK keeps stdin open and the in-process
 * SDK MCP servers (`mcp__coro__*`) keep working — the closed-stdin
 * bug from the prior one-yield generator approach goes away entirely.
 *
 * The dispatcher gets a reference to this object and calls `push()`
 * to inject a developer message mid-phase (paired with `q.interrupt()`
 * so the agent yields its current turn and reads the new message
 * immediately). The runner calls `close()` once the phase's for-await
 * loop has exited, which lets the SDK's `streamInput` consumer
 * complete and finally call `transport.endInput()` cleanly.
 */
export interface PushableInput {
  iterable: AsyncIterable<SDKUserMessage>
  push(msg: SDKUserMessage): void
  close(): void
}

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
   * Called BEFORE the phase executor is invoked, with a pushable input
   * handle. The dispatcher registers it under the job id so a developer
   * message arriving in the (small) gap between this call and
   * `onQueryStart` can already be queued — the executor will read it on
   * its very first iteration. Under the hood this is a runner-built
   * bridge that translates dispatcher pushes into
   * {@link DeveloperInputChannel} messages the executor consumes.
   */
  onPhasePrepare?: (jobId: string, input: PushableInput) => void
  /**
   * Called when the executor has set up its native session. The runner
   * passes a thin {@link Query}-shaped adapter whose `interrupt()`
   * delegates to the executor's session controller. The dispatcher uses
   * this to store a reference for `q.interrupt()` so a developer message
   * can preempt an in-flight model turn / tool call.
   */
  onQueryStart?: (jobId: string, query: Query) => void
  /**
   * Called when the executor's per-phase invocation has fully terminated
   * (success, error, or abort). The dispatcher uses this to remove the
   * Query and pushable references.
   */
  onQueryEnd?: (jobId: string) => void
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

/**
 * Build a {@link PushableInput} backed by an internal queue. Multiple
 * pushes before a single read are buffered FIFO. Pushing after `close()`
 * is a no-op. The iterable returns once the queue has drained AND
 * `close()` has been called — this matches the AsyncIterator contract
 * the SDK's `streamInput` for-await consumer expects.
 */
export function createPushableInput(): PushableInput {
  const buffer: SDKUserMessage[] = []
  // When a consumer is awaiting `next()` and the buffer is empty, we
  // park a resolver here. The next push() (or close()) calls it.
  let waiting: (() => void) | null = null
  let closed = false

  const wakeup = () => {
    const w = waiting
    waiting = null
    if (w) w()
  }

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          // Drain whatever's buffered first.
          while (true) {
            if (buffer.length > 0) {
              return { value: buffer.shift()!, done: false }
            }
            if (closed) {
              return { value: undefined, done: true }
            }
            await new Promise<void>((resolve) => { waiting = resolve })
          }
        },
        async return(): Promise<IteratorResult<SDKUserMessage>> {
          closed = true
          wakeup()
          return { value: undefined, done: true }
        },
      }
    },
  }

  return {
    iterable,
    push(msg: SDKUserMessage): void {
      if (closed) return
      buffer.push(msg)
      wakeup()
    },
    close(): void {
      if (closed) return
      closed = true
      wakeup()
    },
  }
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

      const model = selectModel(phaseConf, settings)
      const workingDir = path.join(settings.paths.workingDir, liveJob.id)
      /** SDK spawns Claude Code with `cwd: workingDir`. Missing dir causes spawn ENOENT, which the SDK misreports as "cli.js not found". */
      mkdirSync(workingDir, { recursive: true })
      ensureClaudeConfigSymlink(workingDir, jobIntelligenceDir, logger)

      // Build subagent specs from workflow config. Agent prompts are
      // loaded here (with .claude/CLAUDE.md prepended) and handed to the
      // executor via {@link PhaseExecutionRequest.subagents}; the
      // executor decides how to dispatch them (Anthropic's native SDK
      // `agents:` map vs. the runner's `run_subagent` MCP tool fallback
      // for non-native executors).
      const subagentSpecs: ReadonlyArray<ExecutorSubagentSpec> | undefined = phaseConf?.subagents
        ? buildExecutorSubagentSpecs(phaseConf.subagents, jobIntelligenceDir, settings)
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
      //   2. Bridge the dispatcher's pre-existing {@link PushableInput}
      //      contract (raw SDKUserMessage push + Query.interrupt()) onto
      //      the executor's normalized {@link DeveloperInputChannel} +
      //      {@link ExecutorSessionController} surfaces.
      //   3. Translate normalized events into the same log/state side
      //      effects the runner has always produced (appendLog, syncJob,
      //      phaseUsage snapshots, MCP-usage counters).
      const executor: PhaseExecutorRuntime =
        options?.executorImpl ?? ctx.plugins.resolveExecutor({ model })

      // Developer-input channel handed to the executor. It starts as a
      // no-op pair; the executor reassigns `push`/`close` early in
      // `executePhase` (synchronously, before any await) so that
      // dispatcher messages routed through the bridge end up in the
      // executor's live SDK input pushable. The mutation is observed
      // here because the bridge looks up `.push` on every call.
      const developerInput: DeveloperInputChannel = {
        push: () => { /* replaced by executor on session start */ },
        close: () => { /* replaced by executor on session start */ },
      }

      // The dispatcher tracks long-lived pushables under each job id and
      // pushes raw {@link SDKUserMessage}s when a developer steers the
      // agent mid-phase. Under the executor model we accept the same
      // shape (so the dispatcher contract is unchanged) and translate
      // each push into a {@link ConversationMessage} pushed into the
      // executor's developer-input channel. The `meta.sdkUserMessage`
      // round-trip lets Anthropic-flavoured executors short-circuit
      // back to the original SDK message without information loss.
      const dummyIterable: AsyncIterable<SDKUserMessage> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<SDKUserMessage>> {
              return { value: undefined as unknown as SDKUserMessage, done: true }
            },
          }
        },
      }
      const bridgePushable: PushableInput = {
        iterable: dummyIterable,
        push(msg: SDKUserMessage): void {
          const c = msg.message?.content
          const text = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c
                .map(b => (typeof b === 'object' && b && 'text' in b
                  ? String((b as { text?: unknown }).text ?? '')
                  : ''))
                .join('')
              : ''
          developerInput.push({
            role: 'user',
            content: text,
            meta: { sdkUserMessage: msg },
          })
        },
        close(): void {
          developerInput.close()
        },
      }

      // Register BEFORE the executor runs so any developer message that
      // races with phase startup lands in the executor's input on its
      // first iteration. Mirrors the legacy `onPhasePrepare` contract.
      options?.onPhasePrepare?.(liveJob.id, bridgePushable)

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

      const req: PhaseExecutionRequest = {
        systemPrompt,
        userPrompt: promptText,
        model,
        cwd: workingDir,
        intelligenceDir: jobIntelligenceDir,
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: mcpServer },
        pluginMcpServers: mergedPluginMcpServers,
        subagents: subagentSpecs,
        hookPolicy: {
          allowedTools: phaseConf?.tools ?? null,
          writeRoots: [workingDir, jobIntelligenceDir],
        },
        sessionState: { sessionId: resumeSessionId },
        maxTurns: 200,
        signal: abortController.signal,
        phase: liveJob.phase,
        lifecycle: {
          onSessionStart: (controller: ExecutorSessionController) => {
            // Adapt the executor's controller to the SDK Query shape so
            // the dispatcher's existing `onQueryStart` consumer keeps
            // calling `q.interrupt()` unchanged.
            options?.onQueryStart?.(
              liveJob.id,
              { interrupt: () => controller.interrupt() } as unknown as Query,
            )
          },
          onSessionEnd: () => options?.onQueryEnd?.(liveJob.id),
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
        // `options?.onQueryEnd` itself.
        try { developerInput.close() } catch { /* best-effort */ }
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

export function selectModel(
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

export function buildSubagentDefinitions(
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
      ...(sa.tools && sa.tools.length > 0 ? { tools: sa.tools } : {}),
      model: sa.model === 'coding'
        ? (settings.claude.codingModel.includes('opus') ? 'opus' : 'sonnet')
        : (sa.model ?? 'inherit'),
      mcpServers: [subagentMcpRecord],
    }
  }
  return defs
}

/**
 * Build {@link ExecutorSubagentSpec}s from workflow subagent config.
 *
 * Mirrors {@link buildSubagentDefinitions} but emits the executor-facing
 * shape: just `name`, prepared `systemPrompt`, optional `model`, and
 * optional `allowedTools`. MCP server propagation is the executor's
 * responsibility (the runner hands it the full `pluginMcpServers` map
 * and a single `mcpServer`; how those reach subagents is the
 * executor's call — Anthropic-flavoured executors merge both onto
 * every subagent in the SDK `agents:` map).
 *
 * The agent prompt is `.claude/CLAUDE.md` (when present) followed by
 * the per-agent markdown — same precedence as the legacy helper, so
 * subagents continue to receive the foundational behaviour rules and
 * company context the parent agent gets natively via `settingSources`.
 */
export function buildExecutorSubagentSpecs(
  subagents: SubagentConfig[],
  intelligenceDir: string,
  settings: Settings,
): ExecutorSubagentSpec[] {
  let claudeMdContent = ''
  try {
    claudeMdContent = readFileSync(
      path.join(intelligenceDir, '.claude', 'CLAUDE.md'),
      'utf-8',
    )
  } catch { /* .claude/CLAUDE.md not found — subagents will run without it */ }

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

    const resolvedModel = sa.model === 'coding'
      ? (settings.claude.codingModel.includes('opus') ? 'opus' : 'sonnet')
      : sa.model

    out.push({
      name: sa.name,
      systemPrompt: agentPrompt,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(sa.tools && sa.tools.length > 0 ? { allowedTools: [...sa.tools] } : {}),
    })
  }
  return out
}

/**
 * Symlink {coroIntelligenceDir}/.claude into the job working directory so the Agent SDK's
 * native settingSources: ['project'] discovers .claude/CLAUDE.md and skills.
 * Uses a symlink (not copy) so the per-job overlay always reflects the
 * latest layered intelligence (base + tenant + repo) without copies
 * needing to be re-synced.
 */
export function ensureClaudeConfigSymlink(workingDir: string, coroIntelligenceDir: string, logger: Logger): void {
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

export interface BuildHookOpts {
  /** Closure that returns the current phase name — phase can change between calls. */
  liveJobRef: () => { phase: string }
  /** Absolute path to the job's working directory. */
  workingDir: string
  /** Absolute path to the Coro intelligence dir. */
  coroIntelligenceDir: string
  /** Optional exact tool whitelist for this phase. */
  allowedTools?: ReadonlyArray<string>
  logger: Logger
}

export function buildPhaseHooks(opts: BuildHookOpts): Record<string, Array<{ hooks: HookCallback[] }>> {
  const memoryRoot = path.join(opts.coroIntelligenceDir, 'memory')
  const allowedTools = opts.allowedTools && opts.allowedTools.length > 0
    ? new Set(opts.allowedTools)
    : null

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

    if (allowedTools && !allowedTools.has(toolName)) {
      const reason =
        `Blocked ${toolName}: phase ${opts.liveJobRef().phase} only allows ` +
        `${Array.from(allowedTools).join(', ')}. Update the workflow if this phase ` +
        `needs broader tool access.`
      opts.logger.warn({ phase: opts.liveJobRef().phase, toolName }, reason)
      return deny(reason)
    }

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

    if (isClaudeTaskOutputPath(candidate)) {
      return (
        `Blocked Bash: command "${command}" references Claude runtime task output ` +
        `via "${candidate}". Do not poll or read /private/tmp/claude-*/tasks/*.output ` +
        `directly. Rerun the underlying command with output redirected to a file inside ` +
        `${workingDir}/** and read that workspace file instead.`
      )
    }

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

function isClaudeTaskOutputPath(token: string): boolean {
  return token.startsWith('/private/tmp/claude-')
    && token.includes('/tasks/')
    && token.endsWith('.output')
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
