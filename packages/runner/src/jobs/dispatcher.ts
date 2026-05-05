import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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
  STATUS_FAILED,
  cancelledJobPatch,
  isCancellableStatus,
  isCampaignJob,
  isParkingStatus,
  isResumableStatus,
  isStoppedStatus,
  isTerminalChildStatus,
} from './types'
import {
  jobStatusToChildStatus,
  reconcileReady,
} from '../tools/campaign'
import { runJob, RunnerContext } from './runner'
import type { EventTransport } from '../state/transport'
import type { InboundEvent, InboundEventSource } from '../state/events'
import type { ExternalRef } from '../plugins/refs'
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
  private readonly activeQueries = new Map<string, Query>()

  constructor(
    private readonly ctx: RunnerContext,
    transport?: EventTransport,
  ) {
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

    await this.injectAndResume(jobId, event)
  }

  private async injectAndResume(jobId: string, event: WebhookEvent): Promise<void> {
    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) return
    if (!isParkingStatus(job.status)) {
      this.ctx.logger.debug(
        { jobId, status: job.status, eventKey: event.eventKey },
        'Job is no longer parked — dropping queued webhook event',
      )
      return
    }

    const pendingPrompt = buildWebhookMessage(event.eventKey, event.payload)

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      pendingPrompt,
    })

    await this.ctx.stateBackend.appendLog(jobId, `[webhook] Received: ${event.eventKey}`)
    this.ctx.logger.info({ jobId, eventKey: event.eventKey }, 'Resuming parked job')

    this.fireAndForget(jobId)
  }

  // ── Human message injection ─────────────────────────────────────────────────

  /**
   * Send a developer message to an agent.
   *
   * Two paths:
   *   1. Job is actively running — inject via Query.streamInput() so the live
   *      agent sees the message mid-turn (zero session rebuild).
  *   2. Job is parked waiting for developer input — build a framed prompt,
  *      clear the awaiting* fields, and resume the job in the existing Claude
  *      session. The runner re-registers the dynamic A5 MCP server before the
  *      next turn so the agent keeps both transcript continuity and MCP tools.
   *
   * Any other status (complete, failed, queued without a live query) throws.
   */
  async sendMessage(jobId: string, message: string): Promise<void> {
    const job = await this.requireJob(jobId)
    if (job.status === STATUS_CANCELLED) {
      throw new Error(`Cannot send message to cancelled job ${jobId}`)
    }

    const q = this.activeQueries.get(jobId)

    if (q) {
      const framedText =
        `[DEVELOPER MESSAGE]\n` +
        `The developer watching this job has sent you a message:\n\n` +
        `"${message}"\n\n` +
        `Consider this guidance in your current work. If it changes your approach, ` +
        `acknowledge it and adjust accordingly. Continue with your current phase instructions.\n\n` +
        `If this guidance represents a reusable pattern or convention that should apply to future jobs, ` +
        `record it via the \`add_insight\` tool so the Evaluator can review it.`

      const userMsg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: framedText }] },
        parent_tool_use_id: null,
      }

      try {
        await q.streamInput((async function* () { yield userMsg })())
      } catch (err) {
        this.ctx.logger.warn({ jobId, err }, 'streamInput failed — query may have ended')
        throw new Error('Failed to inject message — the agent query may have just finished')
      }

      await this.ctx.stateBackend.appendLog(jobId, `[human] ${message}`)
      this.ctx.logger.info({ jobId }, 'Developer message injected into running agent')
      return
    }

    // No live query — check if the job is parked waiting for developer input.
    if (job.status !== STATUS_AWAITING_DEVELOPER_INPUT) {
      throw new Error(
        `Cannot send message to job with status "${job.status}" — ` +
        `only running jobs and jobs awaiting developer input accept messages.`,
      )
    }

    if (this.activeJobs.has(jobId)) {
      throw new Error('Job is transitioning — try again in a moment')
    }

    const pendingPrompt = buildDeveloperInputMessage(
      message,
      job.phase,
      job.awaitingEvent,
      (job.artifacts ?? []).filter(a => a.phase === job.phase),
    )

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      awaitingNextPhase: undefined,
      approvedAdvanceFromPhase: job.awaitingNextPhase ? job.phase : undefined,
      pendingPrompt,
    })

    await this.ctx.stateBackend.appendLog(jobId, `[human] ${message}`)
    this.ctx.logger.info({ jobId, phase: job.phase }, 'Resuming parked job with developer message')

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
    const ownInsights = (child.insights ?? []).filter(i => !i.sourceChildName)
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
    const siblingInsights = parent.campaignAggregatedInsights ?? []

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
      jiraClient: this.ctx.jiraClient,
      trackerClient: this.ctx.trackerClient,
      plugins: this.ctx.plugins,
      logger: this.ctx.logger,
      runningServices: new Map(),
    }
  }

  // ── Fire-and-forget runner ──────────────────────────────────────────────────

  private fireAndForget(jobId: string): void {
    if (this.activeJobs.has(jobId)) {
      this.ctx.logger.warn({ jobId }, 'Runner already active for this job — skipping')
      return
    }

    this.activeJobs.add(jobId)

    this.ctx.stateBackend
      .getJob(jobId)
      .then(job => {
        if (!job) throw new Error(`Job not found: ${jobId}`)
        return runJob(job, this.ctx, {
          onQueryStart: (id, q) => this.activeQueries.set(id, q),
          onQueryEnd: (id) => this.activeQueries.delete(id),
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

        // Process at most ONE queued event. injectAndResume calls fireAndForget
        // which will eventually hit this finally block again for the next event.
        const queued = this.eventQueue.get(jobId)
        if (!queued || queued.length === 0) {
          this.eventQueue.delete(jobId)
          return
        }

        const next = queued.shift()!
        if (queued.length === 0) this.eventQueue.delete(jobId)

        const job = await this.ctx.stateBackend.getJob(jobId)
        if (!job || !isParkingStatus(job.status)) {
          this.eventQueue.delete(jobId)
          return
        }

        await this.injectAndResume(jobId, next)
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

// ── Webhook message builder ───────────────────────────────────────────────────

export function buildWebhookMessage(eventKey: string, payload: Record<string, unknown>): string {
  const lines = [`[WEBHOOK EVENT: ${eventKey}]`, `Received at: ${new Date().toISOString()}`, '']

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

  const comment = payload['comment'] as Record<string, unknown> | undefined
  if (comment) {
    const content = (comment['content'] as Record<string, unknown> | undefined)?.['raw']
    const commenter = (comment['user'] as Record<string, unknown> | undefined)?.['display_name']
    if (commenter) lines.push(`\nComment by ${commenter}:`)
    if (content) lines.push(String(content))
  }

  lines.push('')
  lines.push('Please continue your work based on this event. Refer to your current phase instructions.')

  return lines.join('\n')
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookEvent {
  eventKey: string
  payload: Record<string, unknown>
  receivedAt: string
}
