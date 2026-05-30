import type {
  ConversationMessage,
  DeveloperInputChannel,
  ExecutorSessionController,
} from '@coro-ai/plugin-sdk'
import {
  Artifact,
  CampaignChild,
  Insight,
  Job,
  JobInput,
  STATUS_AWAITING_CHILDREN,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CANCELLED,
  STATUS_CODING,
  STATUS_ESCALATED,
  STATUS_FAILED,
  PAUSED_AWAITING_EVENT,
} from '@coro-ai/cloud-protocol'
import { propagableInsights } from '../insights'
import {
  cancelledJobPatch,
  isCancellableStatus,
  isCampaignJob,
  isParkingStatus,
  isResumableStatus,
  isStoppedStatus,
  isTerminalChildStatus,
  isTerminalStatus,
  pausedJobPatch,
} from './helpers'
import {
  jobStatusToChildStatus,
  reconcileReady,
} from '../tools/campaign'
import { runJob, RunnerContext } from './runner'
import { RateLimitScheduler } from './rate-limit-scheduler'
import type { EventTransport } from '../state/transport'
import type { InboundEvent, InboundEventSource } from '@coro-ai/cloud-protocol'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import { resolveJobByExternalRef } from '../plugins/refs'

const CAMPAIGN_COORDINATING_PHASE = 'coordinating'
const CAMPAIGN_AGGREGATION_PHASE = 'aggregation'
const CHILD_WORKFLOW_PATH = 'workflows/job/workflow.md'

/**
 * Maximum number of campaign children dispatched concurrently for a single
 * campaign job. Conservative default — every child still spawns its own
 * Claude session, so even small numbers consume meaningful API budget.
 * Tenants can override via `settings.coordination.maxParallelChildren` once
 * we surface the knob; for the MVP it stays inlined here so the rollout is
 * predictable.
 */
const DEFAULT_MAX_PARALLEL_CHILDREN = 1

// ── Dispatcher ────────────────────────────────────────────────────────────────
//
// Routes job creation requests and incoming webhook events to the runner.
//
// Concurrency model:
//   - activeJobs tracks which jobs are currently running
//   - A job can only run once at a time (webhook events queue if a run is active)
//   - Queued events are replayed in order when the job finishes its current turn

export class Dispatcher {
  private readonly activeJobs = new Set<string>()
  private readonly eventQueue = new Map<string, WebhookEvent[]>()
  private readonly activeSessions = new Map<string, ExecutorSessionController>()
  /**
   * Live developer-input channel per job. Registered by the runner via
   * `onPhasePrepare` BEFORE the executor session starts so a steering
   * message arriving during the (small) startup gap is never lost.
   * Cleared in `onSessionEnd` together with `activeSessions`.
   */
  private readonly activeInputQueues = new Map<string, DeveloperInputChannel>()
  // Jobs that requested a fresh dispatch while a prior run was still
  // draining (between the SDK turn ending and the runner's `finally`
  // block clearing `activeJobs`). The finally block re-fires these so
  // a developer message that resumes a parked job is never silently
  // dropped just because the previous runner promise hasn't fully
  // settled yet.
  private readonly deferredDispatch = new Set<string>()

  /**
   * In-process timer registry that auto-resumes jobs parked in
   * {@link STATUS_AWAITING_RATE_LIMIT}. Exposed as a getter so the
   * runner factory can call {@link RateLimitScheduler.bootstrap} after
   * dispatcher construction; everything else uses it through the
   * dispatcher's own pause/resume/cancel hooks.
   */
  readonly rateLimitScheduler: RateLimitScheduler

  constructor(
    private readonly ctx: RunnerContext,
    transport?: EventTransport,
  ) {
    this.rateLimitScheduler = new RateLimitScheduler(
      {
        isActiveJob: (jobId) => this.activeJobs.has(jobId),
        resumeJob: (jobId) => this.resumeJob(jobId),
      },
      ctx.stateBackend,
      ctx.logger,
    )
    // Register for transport events (used in Phase 3 when events arrive via WebSocket)
    if (transport) {
      transport.onEvent(async (event) => {
        await this.handleInboundEvent(event)
      })
    }
  }

  // ── CLI / API triggers ──────────────────────────────────────────────────────

  async dispatch(input: JobInput) {
    const job = await this.ctx.stateBackend.createJob(input)
    this.ctx.logger.info({ jobId: job.id, type: job.type }, 'Job dispatched')
    this.fireAndForget(job.id)
    return job
  }

  async cancelJob(jobId: string, reason?: string): Promise<Job> {
    const job = await this.requireJob(jobId)
    if (!isCancellableStatus(job.status)) {
      if (job.status === STATUS_CANCELLED) {
        this.eventQueue.delete(jobId)
        if (this.activeJobs.has(jobId)) {
          await this.ctx.stateBackend.appendLog(
            jobId,
            '[control] Cancellation will take effect at the next safe boundary',
          )
        }
        return job
      }
      throw new Error(`Job ${jobId} is already complete`)
    }

    const wasActive = this.activeJobs.has(jobId)
    const updated = await this.ctx.stateBackend.updateJob(jobId, cancelledJobPatch())

    this.eventQueue.delete(jobId)
    // A cancelled job must never auto-resume from a pending rate-limit
    // wake-up — drop the timer before the runner sees the cancel.
    this.rateLimitScheduler.cancel(jobId)

    const reasonSuffix = reason ? `: ${reason}` : ''
    await this.ctx.stateBackend.appendLog(jobId, `[control] Job cancelled${reasonSuffix}`)
    if (wasActive) {
      await this.ctx.stateBackend.appendLog(
        jobId,
        '[control] Cancellation requested during an active run — the current agent turn will stop at the next safe boundary',
      )
    }

    this.ctx.logger.info({ jobId, wasActive, reason }, 'Job cancelled')
    return updated
  }

  // ── Pause ──────────────────────────────────────────────────────────────────

  /**
   * Park a running job at the next safe boundary so the developer can
   * think / steer / send messages. Uses the same lifecycle status as
   * `awaiting-developer-input` so the existing send-message-to-resume
   * pipeline (parked branch in `sendMessage`) works unchanged. The
   * marker `awaitingEvent` differentiates a developer-initiated pause
   * from an agent-initiated `await_event('developer-input: …')` park.
   *
   * Idempotent: pausing an already-paused job returns it unchanged.
   * Rejects: stopped jobs (complete/cancelled/failed/escalated) and
   * jobs already parked on something else (PR merge, plan approval,
   * awaiting-children) — those wait states must not be clobbered.
   */
  async pauseJob(jobId: string, reason?: string): Promise<Job> {
    const job = await this.requireJob(jobId)

    // Already paused → no-op.
    if (
      job.status === STATUS_AWAITING_DEVELOPER_INPUT
      && job.awaitingEvent === PAUSED_AWAITING_EVENT
    ) {
      return job
    }

    if (isStoppedStatus(job.status)) {
      throw new Error(`Job ${jobId} is ${job.status} and cannot be paused`)
    }

    // Refuse to overwrite a real wait-state — those parks have semantics
    // (PR merge, plan approval, awaiting children, agent-initiated input
    // request) the developer should resolve via the normal channels.
    if (isParkingStatus(job.status)) {
      throw new Error(
        `Job ${jobId} is already parked (${job.status}); pause is only valid on running jobs`,
      )
    }

    const wasActive = this.activeJobs.has(jobId)
    const q = this.activeSessions.get(jobId)

    // Persist the parked status FIRST so:
    //   (a) the HTTP response can return immediately even if the SDK
    //       interrupt ack is slow (mid-tool-use can take seconds), and
    //   (b) when the SDK eventually surfaces the aborted-tool error,
    //       the runner's post-park guard sees a parking status and
    //       treats it as a clean park rather than a crash.
    const updated = await this.ctx.stateBackend.updateJob(jobId, pausedJobPatch())

    // A developer-initiated pause supersedes a pending rate-limit
    // wake-up; otherwise the timer would race the developer's resume.
    this.rateLimitScheduler.cancel(jobId)

    // Drop any pending webhook events; the developer is in control now
    // and the events can be re-delivered (or made obsolete) on resume.
    this.eventQueue.delete(jobId)

    // End the live agent turn. Fire-and-forget: stopping the phase can
    // take seconds (or longer) when the agent is mid-tool-use, and we
    // must not block the HTTP response on it — the runner's post-query
    // `refreshJobForBoundary` plus the post-park error handler will both
    // notice the parked status and exit cleanly regardless.
    //
    // Prefer `stop()`: it aborts the phase signal so the executor breaks
    // its event loop and `executePhase` returns, which is what actually
    // halts the agent. A bare `interrupt()` only makes the agent *yield*
    // (the steering primitive) and, in `safe` mode while an MCP tool is
    // in flight, is a no-op — so the agent would keep working through the
    // phase. Only fall back to `interrupt()` for executors that don't
    // implement `stop()`.
    if (q) {
      if (q.stop) {
        void Promise.resolve()
          .then(() => q.stop!())
          .catch(err => {
            this.ctx.logger.debug(
              { jobId, err },
              'stop() during pause failed (agent likely between turns) — abort signal already set',
            )
          })
      } else {
        const inFlightMcp = q.getSteeringState?.()?.inFlightMcpTool
        const mode = inFlightMcp ? 'safe' as const : 'urgent' as const
        void Promise.resolve()
          .then(() => q.interrupt({ mode }))
          .catch(err => {
            this.ctx.logger.debug(
              { jobId, err, mode, inFlightMcp },
              'interrupt() during pause failed (agent likely between turns) — ignored',
            )
          })
      }
    }

    const reasonSuffix = reason ? `: ${reason}` : ''
    await this.ctx.stateBackend.appendLog(jobId, `[control] Job paused by developer${reasonSuffix}`)
    if (wasActive) {
      await this.ctx.stateBackend.appendLog(
        jobId,
        '[control] Pause requested during an active run — the current agent turn will stop at the next safe boundary. Send a message to resume.',
      )
    }

    this.ctx.logger.info({ jobId, wasActive, reason }, 'Job paused')
    return updated
  }

  // ── Manual resume ───────────────────────────────────────────────────────────

  /**
   * Resume an escalated or failed job from its current phase (or a specific phase).
   *
    * The runner persists Claude sessions by default and reuses `sessionId`
    * when it is safe to do so. Manual resume can either continue the prior
    * session or force a fresh one: if `fromPhase` changes the phase (or
    * `clearSession` is true), the agent re-enters with a rebuilt system prompt
    * and no carry-over transcript. Previously completed phases are NOT re-run
    * — the job simply re-runs the current (or selected) phase from scratch.
   *
   * If `fromPhase` differs from the current phase, the job is moved to that
   * phase before firing the runner. `clearSession` is kept for backward
   * compatibility and simply wipes `sessionId` from state when set.
   */
  async resumeJob(jobId: string, fromPhase?: string, clearSession = false): Promise<void> {
    const job = await this.requireJob(jobId)

    if (this.activeJobs.has(jobId)) {
      throw new Error(`Job ${jobId} is already running`)
    }

    if (!isResumableStatus(job.status)) {
      throw new Error(`Job ${jobId} is already ${job.status}`)
    }

    // Any manual resume drops a pending rate-limit timer — the
    // developer is taking over the wake-up decision.
    this.rateLimitScheduler.cancel(jobId)

    const phaseChanged = fromPhase && fromPhase !== job.phase
    const resetSession = clearSession || phaseChanged

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      escalationMessage: undefined,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      ...(phaseChanged ? { phase: fromPhase } : {}),
      ...(resetSession ? { sessionId: undefined } : {}),
    })

    const sessionNote = resetSession ? ' (fresh session)' : job.sessionId ? ' (resuming session)' : ''
    await this.ctx.stateBackend.appendLog(
      jobId,
      phaseChanged
        ? `[manual-resume] Restarting from phase: ${fromPhase}${sessionNote}`
        : `[manual-resume] Continuing phase: ${job.phase}${sessionNote}`,
    )

    this.ctx.logger.info({ jobId, phase: phaseChanged ? fromPhase : job.phase, phaseChanged, resetSession }, 'Manual job resume')
    this.fireAndForget(jobId)
  }

  // ── Live interactive toggle ─────────────────────────────────────────────────

  /**
   * Flip the `interactive` flag on a running (or parked) job. Persists the
   * new value and, when the toggle goes OFF while the job is parked at a
   * runner-enforced interactive checkpoint, releases the park so the job
   * advances autonomously.
   *
   * Detection of "parked at an interactive checkpoint" relies on the exact
   * signal the runner writes when it parks (`runner.ts` ~line 898):
   *   - status === STATUS_AWAITING_DEVELOPER_INPUT
   *   - awaitingEvent matches `developer-input: approval after <phase>`
   *   - awaitingNextPhase is set to the next workflow phase
   *
   * Other parks (PR merge, campaign halted, manual escalations) carry their
   * own awaitingEvent / awaitingNextPhase shape and are intentionally NOT
   * auto-released — flipping the flag should not trigger merges or skip
   * over real wait conditions.
   *
   * Returns the patch that was applied so callers can echo the new state.
   */
  async setJobInteractive(jobId: string, value: boolean): Promise<Job> {
    const job = await this.requireJob(jobId)

    if (isStoppedStatus(job.status)) {
      throw new Error(
        `Cannot toggle interactive on a ${job.status} job — only running or parked jobs accept the live toggle.`,
      )
    }

    if (job.interactive === value) {
      // No-op: state already matches. Returning the unmodified job keeps the
      // PATCH endpoint idempotent.
      return job
    }

    const isCheckpointPark =
      value === false
      && job.status === STATUS_AWAITING_DEVELOPER_INPUT
      && typeof job.awaitingEvent === 'string'
      && /^developer-input:\s*approval after\s/i.test(job.awaitingEvent)
      && typeof job.awaitingNextPhase === 'string'
      && job.awaitingNextPhase.length > 0

    const updated = await this.ctx.stateBackend.updateJob(jobId, { interactive: value })

    await this.ctx.stateBackend.appendLog(
      jobId,
      `[control] Interactive mode ${value ? 'enabled' : 'disabled'}`,
    )

    if (isCheckpointPark) {
      await this.ctx.stateBackend.appendLog(
        jobId,
        `[control] Auto-releasing checkpoint park — advancing to ${updated.awaitingNextPhase}`,
      )
      // resumeJob clears awaitingEvent/awaitingNextPhase, moves the phase
      // forward, and fires the runner. The runner's next phase-boundary
      // check sees interactive=false and will not park again.
      await this.resumeJob(jobId, updated.awaitingNextPhase)
      const refreshed = await this.ctx.stateBackend.getJob(jobId)
      if (refreshed) return refreshed
    }

    return updated
  }

  // ── Per-phase model overrides ──────────────────────────────────────────────
  //
  // The dashboard exposes a "use a different model just for this phase"
  // affordance. The override is purely runtime — persisted on the Job so
  // it survives runner restarts and re-runs, but never written back to the
  // workflow file (that's the separate "save as default" flow). The
  // override is consulted in `runJob` just before `selectModel`.

  /**
   * Set or clear the per-phase model override for a job. Pass
   * `override: null` to remove the entry entirely. Idempotent: passing
   * the same override is a no-op patch.
   *
   * Validation of the phase name against the workflow happens at the
   * HTTP boundary (where the workflow loader is already wired); this
   * method trusts its caller so unit tests don't need a full workflow
   * fixture.
   */
  async setPhaseOverride(
    jobId: string,
    phase: string,
    override: { model: string; provider?: string } | null,
  ): Promise<Job> {
    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) throw new Error(`Unknown job: ${jobId}`)

    const next = { ...(job.phaseModelOverrides ?? {}) }
    if (override === null) {
      delete next[phase]
    } else {
      next[phase] = override.provider
        ? { model: override.model, provider: override.provider }
        : { model: override.model }
    }

    const updated = await this.ctx.stateBackend.updateJob(jobId, {
      phaseModelOverrides: Object.keys(next).length === 0 ? undefined : next,
    })

    const summary = override
      ? `${phase}=${override.provider ? `${override.provider}/` : ''}${override.model}`
      : `cleared ${phase}`
    await this.ctx.stateBackend.appendLog(
      jobId,
      `[control] Phase model override updated: ${summary}`,
    )
    return updated
  }

  /**
   * Soft re-run of a phase: resets the job to the requested phase with a
   * fresh executor session, optionally pinning a different model first.
   * Reuses the existing `resumeJob(jobId, phase, true)` path so behaviour
   * is identical to "resume from earlier phase + clear session".
   *
   * Refuses to act on a currently-running job — the dashboard pauses
   * first (or the developer cancels) so the in-flight phase doesn't race
   * with the new one. Parked, escalated, failed, and completed jobs are
   * all valid starting points.
   */
  async rerunPhase(
    jobId: string,
    phase: string,
    override?: { model: string; provider?: string },
  ): Promise<void> {
    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) throw new Error(`Unknown job: ${jobId}`)

    if (!isParkingStatus(job.status)) {
      throw new Error(
        `Cannot re-run phase on a ${job.status} job — pause it (or wait for it to park) first.`,
      )
    }

    if (override) {
      await this.setPhaseOverride(jobId, phase, override)
    }

    await this.ctx.stateBackend.appendLog(
      jobId,
      `[control] Re-running phase "${phase}"${
        override ? ` with override ${override.provider ? `${override.provider}/` : ''}${override.model}` : ''
      }`,
    )
    await this.resumeJob(jobId, phase, true)
  }

  // ── Webhook events ──────────────────────────────────────────────────────────
  //
  // After P4 the source axis collapsed to two values:
  //
  //   - `'plugin'` — a provider webhook normalised by a plugin's
  //     `normalizeInbound`. Dispatch is fully generic: the
  //     `ExternalRef` carried on the event identifies the parked job
  //     to wake.
  //   - `'cloud'` — control-plane originated commands addressed by
  //     `jobId`. Different protocol; never lookups by ref.
  //
  // The legacy `'bitbucket'`/`'jira'` source values were retired here.
  // Callers (transports, tests) now produce `'plugin'` events with a
  // `pluginId` and `ref`; the per-provider handlers became part of
  // each plugin's `normalizeInbound`.

  /**
   * Entry point used by transports. Accepts a fully-formed
   * {@link InboundEvent}; reads the source, eventKey, payload, and —
   * for plugin events — the {@link ExternalRef}.
   */
  async handleInboundEvent(event: InboundEvent): Promise<void> {
    switch (event.source) {
      case 'plugin':
        await this.handlePluginEvent(event)
        return
      case 'cloud':
        await this.handleCloudEvent(event.eventKey, event.payload)
        return
    }
  }

  /**
   * @deprecated Use {@link handleInboundEvent}. Kept as a thin
   * adapter so callers that don't yet build an `InboundEvent` still
   * dispatch through the same code path.
   */
  async handleWebhookEvent(
    source: InboundEventSource,
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.handleInboundEvent({
      source,
      eventKey,
      payload,
      receivedAt: new Date().toISOString(),
    })
  }

  // ── Cloud-initiated control events ─────────────────────────────────────────
  //
  // These events arrive from the cloud control plane (dashboard / REST) over
  // the WebSocket transport. Unlike provider webhooks, the payload always
  // carries an explicit `jobId` — there is no PR/issue lookup. We delegate
  // to the same `resumeJob` / `sendMessage` paths used by the local HTTP
  // server so behaviour is identical regardless of which surface initiated
  // the action.

  private async handleCloudEvent(
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : null
    if (!jobId) {
      this.ctx.logger.warn({ eventKey, payload }, 'Cloud event missing jobId — skipping')
      return
    }

    switch (eventKey) {
      case 'job:resume': {
        const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'] : undefined
        try {
          // `prompt` arrives as an optional phase override today (mirrors the
          // local POST /jobs/:id/resume contract). Pass it through to
          // `resumeJob` which interprets a string as `fromPhase`.
          await this.resumeJob(jobId, prompt)
        } catch (err) {
          this.ctx.logger.warn({ err, jobId }, 'Cloud resume failed — job state may have changed')
        }
        return
      }
      case 'job:message': {
        const message = typeof payload['message'] === 'string' ? payload['message'] : null
        if (!message) {
          this.ctx.logger.warn({ jobId }, 'Cloud message event missing message text — skipping')
          return
        }
        try {
          await this.sendMessage(jobId, message)
        } catch (err) {
          this.ctx.logger.warn({ err, jobId }, 'Cloud message injection failed')
        }
        return
      }
      case 'job:cancel': {
        const reason = typeof payload['reason'] === 'string' ? payload['reason'] : undefined
        try {
          await this.cancelJob(jobId, reason)
        } catch (err) {
          this.ctx.logger.warn({ err, jobId }, 'Cloud cancel failed — job state may have changed')
        }
        return
      }
      case 'job:pause': {
        const reason = typeof payload['reason'] === 'string' ? payload['reason'] : undefined
        try {
          await this.pauseJob(jobId, reason)
        } catch (err) {
          this.ctx.logger.warn({ err, jobId }, 'Cloud pause failed — job state may have changed')
        }
        return
      }
      // `job:dispatch` and `proposal:apply` are intercepted earlier by
      // `wireCloudJobDispatch` (see `runner/hybrid-dispatcher.ts`). They
      // reach this branch only if hybrid wiring is missing — log loudly.
      case 'job:dispatch':
      case 'proposal:apply':
        this.ctx.logger.warn(
          { eventKey, jobId },
          'Cloud event reached base dispatcher — hybrid wiring may be missing',
        )
        return
      default:
        this.ctx.logger.debug({ eventKey, jobId }, 'Unknown cloud event key — ignoring')
    }
  }

  // ── Plugin webhook event handling ──────────────────────────────────────────
  //
  // Plugin events arrive with everything we need to wake the parked
  // job already attached: the `ref` (an {@link ExternalRef}) tells us
  // exactly which job to look up, regardless of which provider the
  // event came from. The legacy per-provider extractors that used to
  // live in `webhook-payload.ts` now live inside each plugin's
  // `normalizeInbound`.

  private async handlePluginEvent(event: InboundEvent): Promise<void> {
    if (!event.ref) {
      this.ctx.logger.debug(
        { eventKey: event.eventKey, pluginId: event.pluginId },
        'Plugin event has no ExternalRef — skipping',
      )
      return
    }

    const ref: ExternalRef = event.ref
    const job = await resolveJobByExternalRef(this.ctx.stateBackend, ref)
    if (!job) {
      this.ctx.logger.debug(
        { eventKey: event.eventKey, ref },
        'No job found for external ref — skipping',
      )
      return
    }

    if (!isResumableStatus(job.status)) {
      this.ctx.logger.debug(
        { jobId: job.id, status: job.status, eventKey: event.eventKey, ref },
        'Job is terminal — skipping webhook event',
      )
      return
    }

    // Reconcile `prMappings` the moment we observe a merge, regardless of
    // whether the job is active or parked. The agent's own `scm_merge_pr`
    // tool is the usual path that stamps `mergedAt`, but a PR can reach
    // "merged" without it — a human merging in the SCM UI, or a stacked PR
    // the SCM auto-merges/closes when its base merges. Without this stamp
    // the mapping stays "open" forever and the coding-preflight bounces the
    // job between coding and review indefinitely (the agent confirms the
    // merge, routes to coding, preflight sees an "open" PR, routes back).
    await this.reconcileMergedMapping(job, ref, event)

    // If the job is actively running, queue the event immediately — don't wait for it to park.
    // The runner's finally() handler will replay queued events once the phase completes.
    // This prevents the race where a webhook arrives just before await_event is called.
    if (this.activeJobs.has(job.id)) {
      this.queueEvent(
        job.id,
        { eventKey: event.eventKey, payload: event.payload, receivedAt: event.receivedAt },
        { jobId: job.id, eventKey: event.eventKey, ref },
        'Job is active — queueing webhook event for after park',
      )
      return
    }

    if (!isParkingStatus(job.status)) {
      this.ctx.logger.debug(
        { jobId: job.id, status: job.status },
        'Job is not parked — skipping',
      )
      return
    }

    // Any matched event on a parked job wakes the agent — the AI decides
    // what to do. Comments, approvals, merges, updates, ticket transitions
    // — all are relevant context the agent should see and react to.
    // No rigid event matching.
    await this.resumeWithEvent(job.id, event.eventKey, event.payload)
  }

  /**
   * Stamp `mergedAt` on the matching `prMappings` entry when an inbound
   * event reports the PR as merged. Idempotent and soft-failing: a
   * mapping that is missing or already merged is a no-op, and a backend
   * write failure must never block waking the agent (the merge is real
   * either way). See {@link eventIndicatesMerge} for the shapes we treat
   * as "merged" across the poller and each provider's webhook.
   */
  private async reconcileMergedMapping(
    job: Job,
    ref: ExternalRef,
    event: InboundEvent,
  ): Promise<void> {
    if (!eventIndicatesMerge(event.eventKey, event.payload)) return

    const prId = Number(ref.externalId)
    if (!Number.isFinite(prId)) return

    const mapping = job.prMappings.find(pm => pm.prId === prId)
    if (!mapping || mapping.mergedAt) return

    try {
      await this.ctx.stateBackend.markPrMerged(job.id, prId, new Date().toISOString())
      this.ctx.logger.info(
        { jobId: job.id, prId, eventKey: event.eventKey },
        'Stamped mergedAt on prMapping from observed merge event',
      )
    } catch (err) {
      this.ctx.logger.warn(
        { err, jobId: job.id, prId },
        'Failed to reconcile mergedAt from merge event — agent may see a stale open mapping',
      )
    }
  }

  // ── Resume ──────────────────────────────────────────────────────────────────

  private async resumeWithEvent(
    jobId: string,
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: WebhookEvent = { eventKey, payload, receivedAt: new Date().toISOString() }

    if (this.activeJobs.has(jobId)) {
      this.queueEvent(jobId, event, { jobId, eventKey }, 'Job is active — queueing webhook event')
      return
    }

    await this.injectAndResume(jobId, [event])
  }

  private async injectAndResume(jobId: string, events: WebhookEvent[]): Promise<void> {
    if (events.length === 0) return

    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) return
    if (!isParkingStatus(job.status)) {
      this.ctx.logger.debug(
        { jobId, status: job.status, eventKeys: events.map(e => e.eventKey) },
        'Job is no longer parked — dropping queued webhook events',
      )
      return
    }

    const pendingPrompt = buildBatchedWebhookMessage(events)

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      pendingPrompt,
    })

    const keys = events.map(e => e.eventKey).join(', ')
    await this.ctx.stateBackend.appendLog(
      jobId,
      events.length === 1
        ? `[webhook] Received: ${keys}`
        : `[webhook] Received ${events.length} events: ${keys}`,
    )
    this.ctx.logger.info(
      { jobId, count: events.length, eventKeys: events.map(e => e.eventKey) },
      'Resuming parked job',
    )

    this.fireAndForget(jobId)
  }

  // ── Human message injection ─────────────────────────────────────────────────

  /**
   * Send a developer message to an agent.
   *
   * Two paths:
   *   1. Job is actively running — inject via Query.streamInput() so the live
   *      agent sees the message mid-turn (zero session rebuild).
   *   2. Job is parked waiting for developer input or is escalated — build a
   *      framed prompt, clear the parked/escalated fields, and resume the job.
   *
   * Any other status (complete, failed, queued without a live query) throws.
   */
  async sendMessage(jobId: string, message: string): Promise<void> {
    const job = await this.requireJob(jobId)
    if (job.status === STATUS_CANCELLED) {
      throw new Error(`Cannot send message to cancelled job ${jobId}`)
    }

    // If the job has been parked (paused or awaiting external input) the
    // live SDK query is on its way out and any push()/interrupt() call
    // against it will race the abort. Skip the live-injection branch in
    // that case and fall through to the parked-resume path, which builds
    // a framed prompt and re-fires the runner.
    const inputQueue = isParkingStatus(job.status) ? undefined : this.activeInputQueues.get(jobId)
    const q = isParkingStatus(job.status) ? undefined : this.activeSessions.get(jobId)

    if (inputQueue) {
      const framedText =
        `[DEVELOPER MESSAGE]\n` +
        `The developer watching this job has sent you a message:\n\n` +
        `"${message}"\n\n` +
        `Consider this guidance in your current work. If it changes your approach, ` +
        `acknowledge it and adjust accordingly. Continue with your current phase instructions.\n\n` +
        `If this guidance represents a reusable pattern or convention that should apply to future jobs, ` +
        `record it via the \`add_insight\` tool so the Evaluator can review it.`

      const userMsg: ConversationMessage = {
        role: 'user',
        content: framedText,
      }

      // Steering pattern (final, post-redesign — see
      // memory/repo/agent-steering-flow if it exists):
      //
      //   1. Push the user message into the long-lived per-phase
      //      pushable. The SDK reads it on its next streamInput
      //      iteration. The pushable stays open for the entire phase,
      //      so stdin to the Claude Code subprocess is never closed
      //      mid-phase — MCP keeps working, no race, no timeout.
      //   2. If a Query handle is registered, call `q.interrupt()` so
      //      the agent yields and reads the queued message. Use `safe`
      //      mode while an MCP tool is in flight (message queues, no
      //      transport tear-down); otherwise `urgent` (interrupt +
      //      synchronous MCP heal). We `await` with a generous timeout
      //      but never block the HTTP response indefinitely.
      //   3. If no Query is registered yet (push() raced ahead of
      //      query()'s synchronous return), the SDK will read the
      //      message on its very first iteration. No interrupt needed
      //      — nothing is in flight.
      //
      // We deliberately do NOT call `q.streamInput()` from here. That
      // method calls `transport.endInput()` when its iterable returns,
      // which closes the CLI's stdin pipe and silently breaks every
      // subsequent MCP control_request. The pushable approach above
      // avoids that bug entirely.
      inputQueue.push(userMsg)

      if (q) {
        const INTERRUPT_TIMEOUT_MS = 10_000
        const inFlightMcp = q.getSteeringState?.()?.inFlightMcpTool
        const mode = inFlightMcp ? 'safe' as const : 'urgent' as const
        try {
          await Promise.race([
            q.interrupt({ mode }),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error(`interrupt() did not ack within ${INTERRUPT_TIMEOUT_MS}ms`)),
                INTERRUPT_TIMEOUT_MS,
              ),
            ),
          ])
        } catch (err) {
          this.ctx.logger.warn(
            { jobId, err, mode, inFlightMcp },
            'q.interrupt() failed or timed out — message is queued and will be read at next agent turn',
          )
          await this.ctx.stateBackend.appendLog(
            jobId,
            '[control] Steering interrupt timed out — your message is queued; MCP heal may not have finished.',
          )
        }
        if (mode === 'safe') {
          await this.ctx.stateBackend.appendLog(
            jobId,
            '[control] Steering message queued — MCP tool in flight; will apply after the current tool completes.',
          )
        }
      }

      await this.ctx.stateBackend.appendLog(jobId, `[human] ${message}`)
      this.ctx.logger.info(
        { jobId, hadLiveQuery: Boolean(q) },
        'Developer message injected into running agent',
      )
      return
    }

    // No live query / pushable. Two sub-cases:
    //
    //   (a) Job is parked / escalated / failed → resume the runner with
    //       the developer note framed as guidance.
    //   (b) Job is between phases (status=coding but no input queue
    //       registered yet because the previous phase's query just
    //       ended and the next hasn't started) → persist the message
    //       into `pendingPrompt`. The runner reads `pendingPrompt` at
    //       the top of every phase and uses it instead of the kickoff
    //       text. No fireAndForget here; the runner is already running.
    //
    // The previous code threw in (b), which surfaced as
    // "Cannot send message to job with status coding" whenever the
    // developer sent a quick second message after the first resumed a
    // parked job. Persisting instead means the dashboard's POST always
    // returns 200 and the message is never silently lost.
    const escalated = job.status === STATUS_ESCALATED || job.status === STATUS_FAILED
    const parked = isParkingStatus(job.status) && !escalated
    const betweenPhases = !parked && !escalated && !isTerminalStatus(job.status)

    if (!parked && !escalated && !betweenPhases) {
      throw new Error(
        `Cannot send message to job with status "${job.status}" — ` +
        `only running, parked, escalated, or failed jobs accept messages.`,
      )
    }

    // We intentionally do NOT throw if `activeJobs.has(jobId)` here. After
    // a pause the dispatcher persists the parked status immediately but
    // the prior runner promise can take a beat to drain its final SDK
    // result. `fireAndForget` already handles this race via the
    // `deferredDispatch` set: if the slot is busy, the re-dispatch is
    // queued and the finally block re-fires once the slot frees.

    const currentPhaseArtifacts = (job.artifacts ?? []).filter(a => a.phase === job.phase)
    const framedPrompt = escalated
      ? buildEscalationResponseMessage(message, job.phase, job.escalationMessage, currentPhaseArtifacts)
      : buildDeveloperInputMessage(message, job.phase, job.awaitingEvent, currentPhaseArtifacts)

    if (betweenPhases) {
      // Concatenate against any prior pendingPrompt so back-to-back
      // messages while the runner is between phases all reach the agent
      // at the next phase top.
      const merged = job.pendingPrompt
        ? `${job.pendingPrompt}\n\n---\n\n${framedPrompt}`
        : framedPrompt

      await this.ctx.stateBackend.updateJob(jobId, { pendingPrompt: merged })
      await this.ctx.stateBackend.appendLog(jobId, `[human] ${message}`)
      this.ctx.logger.info(
        { jobId, phase: job.phase, fromStatus: job.status },
        'Queued developer message for next phase boundary (no live query / between phases)',
      )
      return
    }

    const mergedPrompt = job.pendingPrompt
      ? `${job.pendingPrompt}\n\n---\n\n${framedPrompt}`
      : framedPrompt

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      escalationMessage: undefined,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      awaitingNextPhase: undefined,
      approvedAdvanceFromPhase: parked && job.awaitingNextPhase ? job.phase : undefined,
      pendingPrompt: mergedPrompt,
    })

    await this.ctx.stateBackend.appendLog(jobId, `[human] ${message}`)
    this.ctx.logger.info(
      { jobId, phase: job.phase, escalated, fromStatus: job.status },
      escalated ? 'Resuming escalated job with developer message' : 'Resuming parked job with developer message',
    )

    this.fireAndForget(jobId)
  }

  // ── Campaign coordination ──────────────────────────────────────────────────
  //
  // Campaign jobs park in the `coordinating` phase. The dispatcher is the
  // only component that spawns child Jobs, persists `campaignChildren[]`
  // status changes, and resumes the parent into `aggregation` once every
  // child has reached a terminal state. Keeping spawn responsibility in one
  // place is the only way the dependency-aware ready-set computation stays
  // race-free.

  /**
   * Run one coordination sweep on a campaign job:
   *   1. If any child failed/escalated and the failure policy is
   *      `halt-on-failure` (today, the only mode), park the parent at
   *      `awaiting-developer-input`.
   *   2. If every child is in a terminal status, resume the parent into
   *      the `aggregation` phase.
   *   3. Otherwise dispatch up to `maxParallelChildren` ready children.
   *
   * Public so HTTP / CLI live-control endpoints (skip / rerun / cancel)
   * can re-trigger a sweep after they mutate `campaignChildren[]`.
   */
  async coordinateCampaign(parentJobId: string): Promise<void> {
    const parent = await this.ctx.stateBackend.getJob(parentJobId)
    if (!parent) return
    if (!isCampaignJob(parent)) {
      this.ctx.logger.warn({ jobId: parentJobId }, 'coordinateCampaign called on non-campaign job — ignoring')
      return
    }

    const children = parent.campaignChildren ?? []
    if (children.length === 0) return

    const halted = children.filter(c => c.status === 'failed' || c.status === 'escalated')
    if (halted.length > 0) {
      // halt-on-failure: park the parent so a human can decide between
      // skip / rerun / cancel. We only park if not already parked, otherwise
      // every subsequent child stop would re-trigger the same status update.
      if (parent.status !== STATUS_AWAITING_DEVELOPER_INPUT) {
        await this.ctx.stateBackend.updateJob(parent.id, {
          status: STATUS_AWAITING_DEVELOPER_INPUT,
          awaitingEvent: 'developer-input: campaign halted by failed child',
          escalationMessage:
            `Campaign halted: child${halted.length === 1 ? '' : 'ren'} ` +
            `[${halted.map(c => c.name).join(', ')}] did not complete cleanly. ` +
            `Use campaign_skip_child / campaign_rerun_child to resolve.`,
        })
        await this.ctx.stateBackend.appendLog(
          parent.id,
          `[campaign] Halted on failure — ${halted.length} child(ren) failed/escalated`,
        )
      }
      return
    }

    // No halted children remain. If the parent was previously parked at
    // awaiting-developer-input (because a child failed), un-park it back to
    // awaiting-children so the dashboard shows "running" while we wait for
    // children to finish. The parent's runner is not currently up; the
    // status field is purely a UI / state marker until either aggregation
    // fires or another halt happens.
    if (parent.status === STATUS_AWAITING_DEVELOPER_INPUT) {
      await this.ctx.stateBackend.updateJob(parent.id, {
        status: STATUS_AWAITING_CHILDREN,
        escalationMessage: undefined,
        awaitingEvent: undefined,
      })
      await this.ctx.stateBackend.appendLog(
        parent.id,
        `[campaign] Un-parked: no halted children remain — waiting on in-flight work`,
      )
    }

    const allTerminal = children.every(c => isTerminalChildStatus(c.status))
    if (allTerminal) {
      if (parent.phase !== CAMPAIGN_AGGREGATION_PHASE) {
        await this.ctx.stateBackend.appendLog(
          parent.id,
          `[campaign] All ${children.length} children terminal — advancing to ${CAMPAIGN_AGGREGATION_PHASE}`,
        )
        // Force a fresh session so the campaign-evaluator starts with a
        // clean prompt: the campaign-planner's transcript is irrelevant
        // (and large) by aggregation time.
        await this.resumeJob(parent.id, CAMPAIGN_AGGREGATION_PHASE, /* clearSession */ true)
      }
      return
    }

    // Otherwise: dispatch up to N ready children, where N = parallelism cap
    // minus already-dispatched children.
    const dispatched = children.filter(c => c.status === 'dispatched').length
    const slots = Math.max(0, this.maxParallelChildren() - dispatched)
    if (slots === 0) return

    const ready = children.filter(c => c.status === 'ready')
    const toDispatch = ready.slice(0, slots)
    for (const spec of toDispatch) {
      await this.dispatchCampaignChild(parent, spec).catch(async err => {
        // Dispatch failures are recorded as a hard child failure so the
        // coordinator doesn't loop on the same spec forever. The agent /
        // human can then call campaign_rerun_child to retry.
        this.ctx.logger.error(
          { err, parentId: parent.id, childName: spec.name },
          'Failed to dispatch campaign child',
        )
        await this.markChildFailed(parent.id, spec.name, `dispatch failed: ${String(err)}`)
      })
    }
  }

  /**
   * React to a campaign child reaching a terminal status. Updates the
   * parent's `campaignChildren[]` entry, promotes any newly-eligible
   * pending children to `ready`, then runs a fresh coordination sweep.
   */
  private async onChildJobStopped(child: Job): Promise<void> {
    if (!child.campaignParentId) return
    const parent = await this.ctx.stateBackend.getJob(child.campaignParentId)
    if (!parent) {
      this.ctx.logger.warn(
        { childId: child.id, parentId: child.campaignParentId },
        'Child stopped but parent campaign job is missing — skipping',
      )
      return
    }

    const children = parent.campaignChildren ?? []
    // Match by jobId first (set by the dispatcher), fallback to params'
    // campaignChildName (defensive against state where jobId isn't yet
    // persisted on the parent's view).
    const childName = (child.params['campaignChildName'] as string | undefined) ?? null
    const idx = children.findIndex(c =>
      c.jobId === child.id || (childName !== null && c.name === childName),
    )
    if (idx === -1) {
      this.ctx.logger.warn(
        { childId: child.id, parentId: parent.id },
        'Stopped child has no matching entry on parent — skipping coordinator',
      )
      return
    }

    const mapped = jobStatusToChildStatus(child.status)
    if (!mapped) return

    const updated = [...children]
    updated[idx] = {
      ...updated[idx],
      jobId: child.id,
      status: mapped,
      completedAt: new Date().toISOString(),
    }

    // In-flight insight carry-over: aggregate the just-finished child's *own*
    // insights onto the parent so siblings dispatched after this point can
    // read them. We deliberately exclude any insight that already carries a
    // `sourceChildName` — those were inherited from earlier siblings via the
    // dispatcher's seeding path, and re-aggregating them would duplicate
    // entries every hop.
    const aggregatedSoFar = parent.campaignAggregatedInsights ?? []
    const ownInsights = propagableInsights(
      (child.insights ?? []).filter(i => !i.sourceChildName),
    )
    const settledChildName = updated[idx].name
    const newAggregated: Insight[] = [
      ...aggregatedSoFar,
      ...ownInsights.map(i => ({ ...i, sourceChildName: settledChildName })),
    ]

    const reconciled = reconcileReady(updated)
    await this.ctx.stateBackend.updateJob(parent.id, {
      campaignChildren: reconciled,
      ...(newAggregated.length !== aggregatedSoFar.length
        ? { campaignAggregatedInsights: newAggregated }
        : {}),
    })
    await this.ctx.stateBackend.appendLog(
      parent.id,
      `[campaign] Child "${settledChildName}" reached ${mapped} (job ${child.id}); ` +
        `${ownInsights.length > 0
          ? `aggregated ${ownInsights.length} insight${ownInsights.length === 1 ? '' : 's'} for siblings; `
          : ''}` +
        `re-running coordinator sweep`,
    )

    await this.coordinateCampaign(parent.id)
  }

  private async dispatchCampaignChild(parent: Job, spec: CampaignChild): Promise<void> {
    // Build the child's `params` bag. Order matters: spec.params wins over
    // the parent's inherited params, but the dispatcher's safety knobs
    // (`epicAllowed: false`, the back-pointer) win over both. We also
    // forward common scoping fields the planner agent expects on every
    // job (repoSlug, reviewers, gitProvider).
    const inherited: Record<string, unknown> = {}
    for (const key of ['repoSlug', 'repo', 'reviewers', 'gitProvider']) {
      if (parent.params[key] !== undefined) inherited[key] = parent.params[key]
    }

    // Seed the new child with everything earlier siblings learned. The
    // prompt builder already renders `job.insights` under "Insights from
    // Upstream Agents", so the agent sees these as part of its turn-1
    // context — no extra wiring needed at the prompt layer. Each carried
    // insight retains its `sourceChildName` so the agent (and the
    // campaign-evaluator at end of campaign) can tell sibling-inherited
    // insights apart from the child's own findings.
    const siblingInsights = propagableInsights(parent.campaignAggregatedInsights)

    const childInput: JobInput = {
      type: 'job',
      workflowPath: CHILD_WORKFLOW_PATH,
      triggerSource: 'internal',
      params: {
        ...inherited,
        ...spec.params,
        description: spec.description,
        epicAllowed: false,
        campaignParentId: parent.id,
        campaignChildName: spec.name,
        ...(spec.trackerRef ? { trackerRef: spec.trackerRef } : {}),
      },
      ...(siblingInsights.length > 0 ? { initialInsights: siblingInsights } : {}),
    }

    const child = await this.ctx.stateBackend.createJob(childInput)

    const refreshed = (await this.ctx.stateBackend.getJob(parent.id)) ?? parent
    const list = refreshed.campaignChildren ?? []
    const idx = list.findIndex(c => c.name === spec.name)
    if (idx !== -1) {
      list[idx] = {
        ...list[idx],
        jobId: child.id,
        status: 'dispatched',
        startedAt: new Date().toISOString(),
      }
      await this.ctx.stateBackend.updateJob(parent.id, { campaignChildren: list })
    }

    await this.ctx.stateBackend.appendLog(
      parent.id,
      `[campaign] Dispatched child "${spec.name}" as job ${child.id}`,
    )
    await this.ctx.stateBackend.appendLog(
      child.id,
      `[campaign-child] Spawned by campaign ${parent.id} as "${spec.name}"`,
    )

    this.fireAndForget(child.id)
  }

  private async markChildFailed(parentId: string, childName: string, reason: string): Promise<void> {
    const refreshed = await this.ctx.stateBackend.getJob(parentId)
    if (!refreshed) return
    const list = refreshed.campaignChildren ?? []
    const idx = list.findIndex(c => c.name === childName)
    if (idx === -1) return
    list[idx] = {
      ...list[idx],
      status: 'failed',
      completedAt: new Date().toISOString(),
    }
    await this.ctx.stateBackend.updateJob(parentId, { campaignChildren: list })
    await this.ctx.stateBackend.appendLog(parentId, `[campaign] Child "${childName}" marked failed: ${reason}`)
  }

  private maxParallelChildren(): number {
    // Read-once from settings; falls back to the conservative default until
    // tenants opt in. Surfaced as a settings knob in a future cut so
    // operators can dial up parallelism once they trust the workflow.
    const overlay = this.ctx.settings as unknown as { coordination?: { maxParallelChildren?: number } }
    const value = overlay.coordination?.maxParallelChildren
    return typeof value === 'number' && value >= 1 ? value : DEFAULT_MAX_PARALLEL_CHILDREN
  }

  // ── Live-control entry points (used by HTTP / CLI) ─────────────────────────
  //
  // The MCP tools mutate state and run `reconcileReady` already, so these
  // methods exist only to (a) re-run the coordinator sweep after a state
  // change and (b) cancel any running child Job whose lifecycle the
  // dispatcher controls. They are intentionally thin so HTTP handlers can
  // forward straight through.

  async campaignSkipChild(parentJobId: string, childName: string, reason?: string): Promise<void> {
    const { campaignSkipChild } = await import('../tools/campaign')
    const ctx = this.makeToolContextForCampaign(parentJobId)
    if (!ctx) throw new Error(`Campaign job not found: ${parentJobId}`)
    await campaignSkipChild({ name: childName, ...(reason ? { reason } : {}) }, ctx)
    await this.coordinateCampaign(parentJobId)
  }

  async campaignRerunChild(parentJobId: string, childName: string, reason?: string): Promise<void> {
    const { campaignRerunChild } = await import('../tools/campaign')
    const ctx = this.makeToolContextForCampaign(parentJobId)
    if (!ctx) throw new Error(`Campaign job not found: ${parentJobId}`)
    await campaignRerunChild({ name: childName, ...(reason ? { reason } : {}) }, ctx)
    await this.coordinateCampaign(parentJobId)
  }

  async campaignCancelChild(parentJobId: string, childName: string, reason?: string): Promise<void> {
    // MVP: cancel is bookkeeping-only. We mark the campaign child failed
    // in the parent's view so the coordinator stops blocking on it; if the
    // underlying child Job is still running, its runner keeps executing
    // and may eventually persist its own terminal status. The dispatcher's
    // `onChildJobStopped` then overwrites the cancel marker with the
    // child's natural outcome — confusing UX but consistent with the
    // current SDK surface, which exposes no in-flight cancellation hook.
    // A follow-up iteration can add real cancellation once the SDK gives
    // us a stop primitive on Query.
    const { campaignCancelChild } = await import('../tools/campaign')
    const ctx = this.makeToolContextForCampaign(parentJobId)
    if (!ctx) throw new Error(`Campaign job not found: ${parentJobId}`)
    await campaignCancelChild({ name: childName, ...(reason ? { reason } : {}) }, ctx)
    await this.coordinateCampaign(parentJobId)
  }

  /**
   * "Abandon" — user-facing single-button replacement for skip + cancel.
   * Idempotent on already-terminated children (returns silently) so a
   * double-click in the dashboard doesn't surface as a 500.
   */
  async campaignAbandonChild(parentJobId: string, childName: string, reason?: string): Promise<void> {
    const { campaignAbandonChild } = await import('../tools/campaign')
    const ctx = this.makeToolContextForCampaign(parentJobId)
    if (!ctx) throw new Error(`Campaign job not found: ${parentJobId}`)
    await campaignAbandonChild({ name: childName, ...(reason ? { reason } : {}) }, ctx)
    await this.coordinateCampaign(parentJobId)
  }

  /**
   * Resume a failed/escalated child IN-PLACE: re-enters the existing child
   * Job at its last phase, preserving transcript and any open PR.
   *
   * `note` is optional. With a note, we route through {@link sendMessage}
   * so the agent receives a framed developer-input message on its next
   * turn. Without a note we use the bare {@link resumeJob} path, which
   * just flips status back to coding and fires the runner.
   *
   * The parent's `campaignChildren[]` entry is mutated back to `dispatched`
   * BEFORE the child Job is fired — otherwise a fast-finishing child could
   * race `onChildJobStopped` against our coordinator sweep.
   */
  async campaignResumeChild(parentJobId: string, childName: string, note?: string): Promise<void> {
    const { campaignResumeChild } = await import('../tools/campaign')
    const ctx = this.makeToolContextForCampaign(parentJobId)
    if (!ctx) throw new Error(`Campaign job not found: ${parentJobId}`)
    const { childJobId } = await campaignResumeChild(
      { name: childName, ...(note ? { reason: note } : {}) },
      ctx,
    )

    // Fire the underlying child Job. sendMessage handles parked/failed
    // statuses with a framed prompt; resumeJob handles them without one.
    if (note && note.trim().length > 0) {
      await this.sendMessage(childJobId, note)
    } else {
      await this.resumeJob(childJobId)
    }

    await this.coordinateCampaign(parentJobId)
  }

  /**
   * Manually dispatch a single `ready` child, bypassing the parallelism
   * cap and any halt-on-failure pause. Used by the dashboard's per-row
   * "Start" button: `ready` already means dependencies are satisfied, so
   * this is always safe with respect to the dependency graph. The cap is
   * an auto-coordinator policy, not a correctness invariant, so honouring
   * an explicit human click over it is the right trade-off.
   *
   * Throws if the child is missing or not in `ready` status — terminal
   * children are immutable, and dispatched/pending children would either
   * race the coordinator or be missing deps.
   */
  async campaignStartChild(parentJobId: string, childName: string): Promise<void> {
    const parent = await this.ctx.stateBackend.getJob(parentJobId)
    if (!parent) throw new Error(`Campaign job not found: ${parentJobId}`)
    if (!isCampaignJob(parent)) throw new Error(`Job ${parentJobId} is not a campaign`)
    const children = parent.campaignChildren ?? []
    const spec = children.find(c => c.name === childName)
    if (!spec) throw new Error(`Child not found: ${childName}`)
    if (spec.status !== 'ready') {
      throw new Error(
        `Cannot start child "${childName}": status is "${spec.status}" (expected "ready"). ` +
          `Only ready children can be manually started.`,
      )
    }
    await this.dispatchCampaignChild(parent, spec)
  }

  /**
   * Build a minimal {@link import('../tools/types').ToolContext} for invoking
   * campaign tools outside an active runJob (HTTP/CLI). The MCP tools only
   * read `job`, `stateBackend`, and `logger`; we leave the heavier client
   * fields populated from the dispatcher's runner context so the type
   * checker is satisfied even though they're unused on this path.
   */
  private makeToolContextForCampaign(jobId: string): import('../tools/types').ToolContext | null {
    return {
      job: { id: jobId } as Job, // The campaign tools refresh from stateBackend; this stub is only used for `id`.
      stateBackend: this.ctx.stateBackend,
      settings: this.ctx.settings,
      tenantContext: this.ctx.tenantContext,
      jobIntelligenceDir: this.ctx.settings.paths.coroIntelligenceDir,
      gitClient: this.ctx.gitClient,
      bbCoder: this.ctx.bbCoder,
      bbReviewer: this.ctx.bbReviewer,
      ghClient: this.ctx.ghClient,
      ghGitClient: this.ctx.ghGitClient,
      lokiClient: this.ctx.lokiClient,
      tempoClient: this.ctx.tempoClient,
      plugins: this.ctx.plugins,
      logger: this.ctx.logger,
    }
  }

  // ── Fire-and-forget runner ──────────────────────────────────────────────────

  private fireAndForget(jobId: string): void {
    if (this.activeJobs.has(jobId)) {
      // The previous runner promise hasn't settled yet (typical right
      // after a pause / interrupt while the SDK is draining its final
      // result). Mark this jobId for re-dispatch — the finally block
      // below will pick it up once the current run releases the slot.
      this.deferredDispatch.add(jobId)
      this.ctx.logger.debug(
        { jobId },
        'Runner already active — deferring re-dispatch until current run drains',
      )
      return
    }

    this.activeJobs.add(jobId)

    this.ctx.stateBackend
      .getJob(jobId)
      .then(job => {
        if (!job) throw new Error(`Job not found: ${jobId}`)
        return runJob(job, this.ctx, {
          onPhasePrepare: (id, channel) => this.activeInputQueues.set(id, channel),
          onSessionStart: (id, controller) => this.activeSessions.set(id, controller),
          onSessionEnd: (id) => {
            this.activeSessions.delete(id)
            this.activeInputQueues.delete(id)
          },
          onRateLimitPark: (id, resumeAt) => this.rateLimitScheduler.schedule(id, resumeAt),
        })
      })
      .catch(err => {
        this.ctx.logger.error({ err, jobId }, 'Runner crashed unexpectedly')
        return this.ctx.stateBackend
          .updateJob(jobId, {
            status: STATUS_FAILED,
            escalationMessage: `Runner crashed: ${String(err)}`,
          })
          .catch(() => {})
      })
      .finally(async () => {
        this.activeJobs.delete(jobId)

        // Campaign coordinator hook. Runs in two situations:
        //   1. The just-stopped job is a campaign CHILD — its terminal
        //      status updates the parent and may trigger the next
        //      dispatch wave or the parent's advance to aggregation.
        //   2. The just-parked job is a campaign PARENT entering the
        //      coordinating phase for the first time — kick off the
        //      initial dispatch sweep (no child stop drove us here).
        try {
          const finishedJob = await this.ctx.stateBackend.getJob(jobId)
          if (finishedJob) {
            if (finishedJob.campaignParentId && isStoppedStatus(finishedJob.status)) {
              await this.onChildJobStopped(finishedJob).catch(err => {
                this.ctx.logger.error({ err, jobId }, 'Campaign child completion handler failed')
              })
            } else if (
              isCampaignJob(finishedJob) &&
              finishedJob.phase === CAMPAIGN_COORDINATING_PHASE &&
              finishedJob.status === STATUS_AWAITING_CHILDREN
            ) {
              await this.coordinateCampaign(finishedJob.id).catch(err => {
                this.ctx.logger.error({ err, jobId }, 'Initial campaign coordinate failed')
              })
            }
          }
        } catch (err) {
          this.ctx.logger.error({ err, jobId }, 'Failed loading job for campaign coordinator')
        }

        // Drain every queued webhook event into one resume so the agent
        // sees the full batch (e.g. comment on PR#1 + approvals on PR#2/3)
        // in a single turn instead of N separate LLM cycles.
        const queued = this.eventQueue.get(jobId)
        if (!queued || queued.length === 0) {
          this.eventQueue.delete(jobId)
          // No queued webhook events — but a developer message may have
          // arrived while we were draining and asked us to re-dispatch.
          if (this.deferredDispatch.delete(jobId)) {
            const job = await this.ctx.stateBackend.getJob(jobId)
            if (job && isResumableStatus(job.status)) {
              this.fireAndForget(jobId)
            }
          }
          return
        }

        const batch = queued.splice(0)
        this.eventQueue.delete(jobId)

        const job = await this.ctx.stateBackend.getJob(jobId)
        if (!job || !isParkingStatus(job.status)) {
          return
        }

        await this.injectAndResume(jobId, batch)
      })
  }

  private async requireJob(jobId: string): Promise<Job> {
    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    return job
  }

  private queueEvent(
    jobId: string,
    event: WebhookEvent,
    context: Record<string, unknown>,
    message: string,
  ): void {
    this.ctx.logger.debug(context, message)
    const queue = this.eventQueue.get(jobId) ?? []
    queue.push(event)
    this.eventQueue.set(jobId, queue)
  }
}

// ── Developer input message builder ───────────────────────────────────────────

/**
 * Build the framed prompt the runner will send to the agent when a developer
 * responds to a paused-for-developer-input park.
 *
 * The runner now enforces workflow interactive checkpoints at phase
 * boundaries. Agents can still call `await_event('developer-input: <reason>')`
 * for additional mid-phase questions (approval, clarification, design choice).
 * This builder relays the developer's reply and reminds the agent to:
 *
 *   1. Apply the guidance and finish the phase as normal (the runner will
 *      auto-advance — or the agent can call `goto_phase` to loop back).
 *   2. Capture reusable guidance via `add_insight` for the evaluator.
 */
export function buildDeveloperInputMessage(
  message: string,
  phase: string,
  awaitingEvent: string | undefined,
  currentPhaseArtifacts: Artifact[],
): string {
  const reason = awaitingEvent?.startsWith('developer-input:')
    ? awaitingEvent.slice('developer-input:'.length).trim()
    : ''

  const lines = [
    '[DEVELOPER RESPONSE]',
    '',
    `You paused during phase: ${phase}.`,
  ]

  if (reason) {
    lines.push(`You were waiting for input on: "${reason}".`)
  }

  if (currentPhaseArtifacts.length > 0) {
    lines.push('', 'Artefacts you posted this phase:')
    for (const a of currentPhaseArtifacts.slice(-10)) {
      lines.push(`  - ${a.kind}: ${a.title}`)
    }
  }

  lines.push(
    '',
    'Developer said:',
    `"${message}"`,
    '',
    'Use the developer\'s answer to continue. Finish the phase normally when done — the ' +
    'runner will auto-advance. If you need to revisit an earlier phase (e.g. rework after ' +
    'a review comment), call `goto_phase`. If this reply contains a reusable pattern or ' +
    'convention, record it via `add_insight` so the evaluator can review it.',
  )

  return lines.join('\n')
}

export function buildEscalationResponseMessage(
  message: string,
  phase: string,
  escalationMessage: string | undefined,
  currentPhaseArtifacts: Artifact[],
): string {
  const lines = [
    '[DEVELOPER RESPONSE]',
    '',
    `You previously escalated during phase: ${phase}.`,
  ]

  if (escalationMessage) {
    lines.push('', 'Your escalation reason was:', `"${escalationMessage}"`)
  }

  if (currentPhaseArtifacts.length > 0) {
    lines.push('', 'Artefacts you posted this phase:')
    for (const a of currentPhaseArtifacts.slice(-10)) {
      lines.push(`  - ${a.kind}: ${a.title}`)
    }
  }

  lines.push(
    '',
    'Developer said:',
    `"${message}"`,
    '',
    'Use the developer\'s reply to continue from the current phase. If the blocker is resolved, or the developer ' +
    'explicitly chose a path that you can execute yourself, continue normally. If the developer is asking you for ' +
    'instructions, research, or any out-of-band action they must perform themselves, answer clearly and then call ' +
    '`await_event({ eventName: "developer-input: <short reason>" })` so the job stays with you instead of ' +
    'auto-advancing to the next phase. If you still cannot proceed after that, explain the remaining blocker and ' +
    'escalate again. If this reply contains a reusable pattern or convention, record it via `add_insight` so the ' +
    'evaluator can review it.',
  )

  return lines.join('\n')
}

// ── Merge detection ───────────────────────────────────────────────────────────

/**
 * Does this inbound PR event mean the PR is now merged? A merge reaches
 * the runner through several shapes and we must recognise all of them so
 * `prMappings` reconciliation never depends on one provider's quirks:
 *
 *   - **Poller** (`PollingTransport`): synthetic eventKey
 *     `pullrequest:fulfilled` with `payload.state === 'MERGED'`.
 *   - **Bitbucket / GitLab webhooks** (normalised): eventKey `pr.merged`.
 *   - **GitHub webhooks** (normalised): eventKey is `pr.declined` because
 *     GitHub reports a merge as `action: 'closed'`; the only reliable
 *     signal is the raw payload's `pull_request.merged === true`.
 *
 * We deliberately read the raw payload state in addition to the eventKey
 * so a provider that merges-by-closing can't masquerade as a plain close.
 */
export function eventIndicatesMerge(
  eventKey: string,
  payload: Record<string, unknown>,
): boolean {
  const key = eventKey.toLowerCase()
  if (key.includes('merged') || key.includes('fulfilled')) return true

  const looksMerged = (value: unknown): boolean =>
    typeof value === 'string' && value.toLowerCase() === 'merged'

  if (looksMerged(payload['state'])) return true

  const pr = payload['pullrequest']
  if (pr && typeof pr === 'object' && looksMerged((pr as Record<string, unknown>)['state'])) {
    return true
  }

  // GitHub raw shape: state is "closed" on a merge, but `merged: true`
  // disambiguates a merge from a plain close.
  const ghPr = payload['pull_request']
  if (ghPr && typeof ghPr === 'object' && (ghPr as Record<string, unknown>)['merged'] === true) {
    return true
  }

  return false
}

// ── Webhook message builder ───────────────────────────────────────────────────

/** Body lines for one webhook payload (PR metadata, comment text, approval hints). */
function formatWebhookEventBody(eventKey: string, payload: Record<string, unknown>): string[] {
  const lines: string[] = []

  const pr = payload['pullrequest'] as Record<string, unknown> | undefined
  if (pr) {
    const id = pr['id']
    const title = pr['title']
    const state = pr['state']
    const author = (pr['author'] as Record<string, unknown> | undefined)?.['display_name']
    const source = ((pr['source'] as Record<string, unknown> | undefined)?.['branch'] as Record<string, unknown> | undefined)?.['name']
    const dest = ((pr['destination'] as Record<string, unknown> | undefined)?.['branch'] as Record<string, unknown> | undefined)?.['name']

    if (id) lines.push(`PR #${id}: ${String(title ?? '')}`)
    if (state) lines.push(`State: ${state}`)
    if (source && dest) lines.push(`Branch: ${source} → ${dest}`)
    if (author) lines.push(`Author: ${author}`)
  }

  const approvalCount = payload['approvalCount']
  if (typeof approvalCount === 'number') {
    lines.push(`Approvals: ${approvalCount}`)
  }

  const comment = payload['comment'] as Record<string, unknown> | undefined
  if (comment) {
    const content = (comment['content'] as Record<string, unknown> | undefined)?.['raw']
    const commenter = (comment['user'] as Record<string, unknown> | undefined)?.['display_name']
    if (commenter) lines.push(`Comment by ${commenter}:`)
    if (content) lines.push(String(content))
  }

  if (lines.length === 0) {
    lines.push(`(no structured payload — event: ${eventKey})`)
  }

  return lines
}

export function buildWebhookMessage(eventKey: string, payload: Record<string, unknown>): string {
  return buildBatchedWebhookMessage([{
    eventKey,
    payload,
    receivedAt: new Date().toISOString(),
  }])
}

export function buildBatchedWebhookMessage(
  events: Array<{ eventKey: string; payload: Record<string, unknown>; receivedAt: string }>,
): string {
  const n = events.length
  const header = n === 1
    ? '[WEBHOOK EVENT: 1 received since you parked]'
    : `[WEBHOOK EVENTS: ${n} received since you parked]`

  const lines: string[] = [header, '']

  events.forEach((event, index) => {
    const label = n === 1
      ? `Event 1 of 1 — ${event.eventKey} at ${event.receivedAt}`
      : `Event ${index + 1} of ${n} — ${event.eventKey} at ${event.receivedAt}`
    lines.push(label)
    lines.push(...formatWebhookEventBody(event.eventKey, event.payload))
    lines.push('')
  })

  lines.push(
    'Decide which to act on first using your workflow intelligence.',
    'Comments may need replies or a coder loop-back (`goto_phase("coding")`).',
    'Approvals enable merges when CI and human sign-off are satisfied.',
    'Refer to your current phase instructions and the "Open PRs on this job" block in your kickoff.',
  )

  return lines.join('\n')
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookEvent {
  eventKey: string
  payload: Record<string, unknown>
  receivedAt: string
}
