// ── Polling Transport ─────────────────────────────────────────────────────────
//
// EventTransport implementation for fully local mode (Phase 5). Instead of
// receiving webhook events in real-time, polls the SCM provider's API at a
// fixed interval to detect PR state changes (comments, approvals, merges).
//
// Latency: ~60 seconds (acceptable for jobs that take hours).
// Used when: `coro init --local` → no cloud, no webhook endpoint.
//
// Plugin-aware design (P1): the transport itself does not know how to
// poll any specific provider. Every parked job's PR is owned by an SCM
// plugin (resolved through the plugin registry); the transport calls
// `pollPr(ref)` on that plugin and translates the returned snapshot
// into synthetic InboundEvents.
//
// Resolution rules for the SCM plugin per parked job:
//   1. The PR mapping's `pluginId` field, when present (preferred —
//      future P5 will store this on `external_ref_mappings`).
//   2. `params.scm` set on the job (agent-supplied via `set_job_params`).
//   3. The registry's default SCM plugin (only one installed, or
//      `defaults.scm` set in PluginsConfig).
//
// When resolution fails for a particular job we log a warning and skip
// it — no global default is forced because forcing one silently picks
// the wrong provider for cross-platform tenants.

import type { EventTransport } from './transport'
import type { InboundEvent, OutboundEvent } from '@coro-ai/cloud-protocol'
import type { StateBackend } from './backend'
import type { Logger } from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import type { ScmPluginRuntime, ScmPollSnapshot } from '../plugins/types'
import { STATUS_ESCALATED, STATUS_FAILED, type Job, type PrMapping } from '@coro-ai/cloud-protocol'
import { isParkingStatus } from '../jobs/helpers'
import { buildPrExternalRef } from '../plugins/refs'

/**
 * The job already stopped and carries a reason a human needs to read.
 *
 * `isParkingStatus` deliberately treats these as pollable (a webhook may
 * still carry the context needed to continue), but for our purposes they
 * mean "waiting on a human" — so we neither overwrite their existing
 * escalation nor keep hammering a PR we already gave up on.
 */
function isStoppedWithReason(status: string): boolean {
  return status === STATUS_ESCALATED || status === STATUS_FAILED
}

export interface PollingTransportOptions {
  stateBackend: StateBackend
  /** Plugin registry — used to resolve which SCM plugin owns each parked PR. */
  plugins: PluginRegistry
  /** Poll interval in milliseconds. Default: 60000 (60s). */
  intervalMs?: number
  logger: Logger
}

/** Snapshot of a PR's last-known state for change detection. */
interface PrSnapshot {
  state: ScmPollSnapshot['state']
  approvalCount: number
  commentCount: number
}

export class PollingTransport implements EventTransport {
  private handler?: (event: InboundEvent) => Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private connected = false
  private polling = false

  private readonly intervalMs: number
  private readonly stateBackend: StateBackend
  private readonly plugins: PluginRegistry
  private readonly logger: Logger

  /** Cache of last-seen PR state to detect changes. Keyed by `${pluginId}:${repoKey}:${externalId}`. */
  private readonly snapshots = new Map<string, PrSnapshot>()

  /**
   * Consecutive poll-failure counter per ref. Reset on every successful poll.
   * Used to escalate a parked job once the upstream PR / repo has been
   * unreachable for too long (deleted, renamed, permissions revoked).
   */
  private readonly pollFailures = new Map<string, number>()

  /**
   * Refs we have given up on and escalated. Polling one of these again
   * would just re-escalate on the next five cycles forever, so we skip
   * them until a human moves the job out of `escalated`.
   */
  private readonly unreachableRefs = new Set<string>()

  /** Threshold of consecutive failures before we escalate the job. */
  private static readonly FAILURE_THRESHOLD = 5

  constructor(opts: PollingTransportOptions) {
    this.stateBackend = opts.stateBackend
    this.plugins = opts.plugins
    this.intervalMs = opts.intervalMs ?? 60_000
    this.logger = opts.logger
  }

  async connect(): Promise<void> {
    if (this.connected) return
    this.connected = true

    // Start polling loop
    this.timer = setInterval(() => {
      void this.poll()
    }, this.intervalMs)

    this.logger.info({ intervalMs: this.intervalMs }, 'Polling transport started')

    // Run an immediate poll so any already-merged PRs are detected on startup
    void this.poll()
  }

  async disconnect(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.connected = false
    this.snapshots.clear()
    this.pollFailures.clear()
    this.unreachableRefs.clear()
    this.logger.info('Polling transport stopped')
  }

  isConnected(): boolean {
    return this.connected
  }

  onEvent(handler: (event: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }

  async emit(_event: OutboundEvent): Promise<void> {
    // No-op for local mode — no cloud to emit to.
    // Log lines go directly to SQLite via StateBackend.
  }

  // ── Polling loop ──────────────────────────────────────────────────────────

  /**
   * Manually trigger a poll cycle (useful for tests or on-demand checks).
   */
  async poll(): Promise<void> {
    if (this.polling) return  // Skip if previous poll is still running
    this.polling = true

    try {
      const jobs = await this.stateBackend.listJobs()
      const parkedJobs = jobs.filter(j =>
        isParkingStatus(j.status) && hasPollablePrs(j),
      )

      this.logger.info({ parkedCount: parkedJobs.length }, 'Poll cycle running')

      if (parkedJobs.length === 0) return

      for (const job of parkedJobs) {
        const prIds = prIdsToPoll(job)
        for (const prId of prIds) {
          const ref = this.resolveRef(job, prId)
          if (!ref) {
            this.logger.warn(
              { jobId: job.id, prId },
              'Cannot poll PR — no repoKey/repoSlug found on job',
            )
            continue
          }

          const scm = this.resolveScm(job, ref)
          if (!scm) {
            this.logger.warn(
              { jobId: job.id, prId, pluginId: ref.pluginId },
              'Cannot poll PR — no matching SCM plugin installed',
            )
            continue
          }

          // A ref we already escalated stays skipped while the job sits in
          // `escalated`. Once a human resumes it (which moves the job back
          // to a real parking state) we retry — the underlying cause is
          // usually a config fix, not something we can detect from here.
          const refKey = snapshotKey(ref)
          if (this.unreachableRefs.has(refKey)) {
            if (isStoppedWithReason(job.status)) continue
            this.unreachableRefs.delete(refKey)
          }

          try {
            await this.checkPr(job.id, scm, ref)
          } catch (err) {
            await this.handlePollError(job, ref, err)
          }
        }
      }
    } finally {
      this.polling = false
    }
  }

  // ── PR change detection ────────────────────────────────────────────────────

  /**
   * Read the parked job's `awaitingEvent` label so the cold-start branch
   * of `checkPr` can suppress synthetic events the agent is not actually
   * waiting on. Returns `undefined` on any read failure (we'd rather
   * over-deliver than crash the poll loop).
   */
  private async getJobAwaitingEvent(jobId: string): Promise<string | undefined> {
    try {
      const job = await this.stateBackend.getJob(jobId)
      return job?.awaitingEvent ?? undefined
    } catch {
      return undefined
    }
  }

  private async checkPr(jobId: string, scm: ScmPluginRuntime, ref: ExternalRef): Promise<void> {
    const snap = await scm.pollPr(ref)
    // Successful poll — clear any prior failure streak for this ref.
    this.pollFailures.delete(snapshotKey(ref))

    const current: PrSnapshot = {
      state: snap.state,
      approvalCount: snap.approvalCount,
      commentCount: snap.commentCount,
    }

    const key = snapshotKey(ref)
    const previous = this.snapshots.get(key)
    this.snapshots.set(key, current)

    // First poll — fire an event ONLY when the current PR state matches
    // what the parked job is actually awaiting. This covers the legit
    // cold-start case (runner restarts after a PR was merged/approved
    // during downtime) without re-firing stale events the agent already
    // saw and reacted to in a prior session.
    //
    // Concrete bug this prevents: a job parks awaiting `pr:approved`
    // after the agent already handled an earlier `pr:rejected`. The
    // runner is restarted. Without this filter the in-memory snapshot
    // map is empty, the PR is still `declined`, and we'd synthetically
    // re-deliver `pullrequest:rejected` even though no human acted on
    // the PR — confusing the agent and wasting tokens.
    if (!previous) {
      this.logger.debug({ jobId, ref, state: current.state }, 'Initial PR snapshot cached')

      const awaiting = await this.getJobAwaitingEvent(jobId)
      const matchesAwaited = (eventKey: string) =>
        awaiting != null && eventKeyMatchesAwaited(eventKey, awaiting)

      if (current.state === 'merged' && matchesAwaited('pullrequest:fulfilled')) {
        await this.deliver(jobId, ref, 'pullrequest:fulfilled', { state: 'MERGED' })
      } else if (current.state === 'declined' && matchesAwaited('pullrequest:rejected')) {
        await this.deliver(jobId, ref, 'pullrequest:rejected', { state: 'DECLINED' })
      } else if (current.approvalCount > 0 && matchesAwaited('pullrequest:approved')) {
        await this.deliver(jobId, ref, 'pullrequest:approved', { approvalCount: current.approvalCount })
      } else {
        this.logger.info(
          { jobId, ref, state: current.state, awaiting },
          'Cold-start PR poll: state does not match parked job\'s awaitingEvent — suppressing synthetic event',
        )
      }
      return
    }

    // Detect state changes and deliver synthetic events
    if (current.state !== previous.state) {
      if (current.state === 'merged') {
        await this.deliver(jobId, ref, 'pullrequest:fulfilled', { state: 'MERGED' })
      } else if (current.state === 'declined') {
        await this.deliver(jobId, ref, 'pullrequest:rejected', { state: 'DECLINED' })
      } else {
        await this.deliver(jobId, ref, 'pullrequest:updated', { state: current.state })
      }
    }

    if (current.approvalCount > previous.approvalCount) {
      await this.deliver(jobId, ref, 'pullrequest:approved', {
        approvalCount: current.approvalCount,
      })
    }

    if (current.commentCount > previous.commentCount) {
      // Slice the new comments off the snapshot. Plugins return the full
      // comment list ordered by createdAt ASC so this slice is the
      // delta between successive polls.
      const newComments = snap.comments.slice(previous.commentCount)
      for (const comment of newComments) {
        await this.deliver(jobId, ref, 'pullrequest:comment_created', {
          comment: {
            id: comment.id,
            content: { raw: comment.body },
            created_on: comment.createdAt,
          },
        })
      }
    }
  }

  private async deliver(
    jobId: string,
    ref: ExternalRef,
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.handler) return

    this.logger.info({ jobId, ref, eventKey }, 'Polling detected PR change — delivering event')

    // Plugin-shaped event. The dispatcher uses `ref` to look up the
    // parked job; we keep the legacy `pullrequest.id` field on the
    // payload so the prompt builder (`buildWebhookMessage`) can still
    // render the change summary without any per-provider knowledge.
    const event: InboundEvent = {
      source: 'plugin',
      pluginId: ref.pluginId,
      ref,
      eventKey,
      payload: {
        ...payload,
        prId: Number(ref.externalId),
        pullrequest: {
          id: Number(ref.externalId),
          state: payload['state'],
        },
      },
      receivedAt: new Date().toISOString(),
    }

    await this.handler(event)
  }

  /**
   * Handle a poll cycle error. Increments the per-ref consecutive failure
   * counter; once it crosses the threshold we escalate the job to a human
   * and stop polling that ref.
   *
   * Escalation — not a synthetic `pullrequest:rejected`. An unreachable PR
   * and a rejected PR are different facts, and conflating them was actively
   * harmful in two ways. It told the agent a human had declined the PR when
   * nobody had, and when the job happened to be awaiting something else
   * (`pr:approved`, say) the event matched nothing, the job stayed parked,
   * and the reset failure counter started the same five-cycle march again —
   * forever, with no escalation and no way out.
   *
   * The failure causes we actually see here are infrastructural: a deleted
   * PR, a token that lost access, or a repo key stored in a shape the
   * provider client does not address correctly. None of them are decisions
   * an agent can act on, and all of them need a human. So we record the
   * diagnosis on the job and stop.
   *
   * We deliberately apply the **same threshold to 404s and other errors**:
   * a single-cycle 404 can be transient, and requiring N consecutive
   * failures removes that false-positive class.
   */
  private async handlePollError(job: Job, ref: ExternalRef, err: unknown): Promise<void> {
    const jobId = job.id
    const key = snapshotKey(ref)
    const prevFailures = this.pollFailures.get(key) ?? 0
    const failures = prevFailures + 1
    this.pollFailures.set(key, failures)

    const statusCode = extractStatusCode(err)
    const reachedThreshold = failures >= PollingTransport.FAILURE_THRESHOLD

    if (reachedThreshold) {
      this.logger.warn(
        { jobId, ref, prId: Number(ref.externalId), statusCode, failures, err },
        'PR poll failed too many times in a row — escalating job and giving up on this PR.',
      )
      this.snapshots.delete(key)
      this.pollFailures.delete(key)
      this.unreachableRefs.add(key)
      await this.escalateUnreachablePr(job, ref, failures, statusCode)
      return
    }

    // Transient failure — log once at warn, subsequent ones at debug to
    // keep the runner log readable.
    if (failures === 1) {
      this.logger.warn({ jobId, ref, prId: Number(ref.externalId), statusCode, err }, 'PR poll failed — will retry next cycle')
    } else {
      this.logger.debug({ jobId, ref, prId: Number(ref.externalId), statusCode, failures, err }, 'PR poll still failing — will retry')
    }
  }

  /**
   * Record an unreachable PR on the job and stop it, so the developer sees
   * one actionable escalation instead of a silent retry loop.
   *
   * Leaves an already-stopped job alone: whatever escalation is on it now
   * is at least as informative as ours, and overwriting it would bury the
   * original reason the job stopped.
   */
  private async escalateUnreachablePr(
    job: Job,
    ref: ExternalRef,
    failures: number,
    statusCode?: number,
  ): Promise<void> {
    if (isStoppedWithReason(job.status)) return

    const prId = Number(ref.externalId)
    const where = ref.repoKey ? `${ref.repoKey} #${prId}` : `PR #${prId}`
    const message =
      `Cannot reach pull request ${where} — ${failures} consecutive poll failures` +
      `${statusCode ? ` (last response: HTTP ${statusCode})` : ''}. ` +
      `Coro has stopped polling it. Common causes: the PR or repository was deleted, ` +
      `the configured ${ref.pluginId} token lost access, or the repository is recorded in a ` +
      `form the ${ref.pluginId} client does not address correctly. ` +
      `Fix the cause, then send this job a message to resume it.`

    try {
      await this.stateBackend.appendLog(job.id, `[poll] ${message}`)
      await this.stateBackend.updateJob(job.id, {
        status: STATUS_ESCALATED,
        escalationMessage: message,
      })
    } catch (err) {
      // The job stays parked and the ref stays skipped; a runner restart
      // retries from scratch.
      this.logger.error({ err, jobId: job.id, ref }, 'Could not escalate job for unreachable PR')
    }
  }

  // ── Resolution helpers ─────────────────────────────────────────────────────

  /**
   * Shared with the park path (`registerParkedPrRef`) so the ref we
   * deliver events with is identical to the one registered for lookup.
   * If these two drifted, the exact `external_ref_mappings` match would
   * miss and resolution would fall back to an ambiguous by-number search.
   */
  private resolveRef(job: Job, prId: number): ExternalRef | null {
    return buildPrExternalRef(job, prId, this.plugins)
  }

  private resolveScm(job: Job, ref: ExternalRef): ScmPluginRuntime | undefined {
    // Prefer the plugin id baked into the ref. Falls back to the
    // job's `params.scm`, then the registry default.
    const byRefId = this.plugins.byId(ref.pluginId)
    if (byRefId && byRefId.manifest.kind === 'scm') return byRefId as ScmPluginRuntime

    const requested = typeof job.params['scm'] === 'string' ? (job.params['scm'] as string) : undefined
    try {
      return this.plugins.resolveScm(requested ? { scm: requested } : {})
    } catch {
      return undefined
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function snapshotKey(ref: ExternalRef): string {
  return `${ref.pluginId}:${ref.repoKey ?? ''}:${ref.externalId}`
}

/**
 * Best-effort extraction of an HTTP status code from a thrown error.
 * Plugin clients (GitHubError, BitbucketError, …) all expose `statusCode`;
 * fetch-style errors may expose `status`. Anything else falls through to
 * `undefined`.
 */
function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as { statusCode?: unknown; status?: unknown }
  if (typeof e.statusCode === 'number') return e.statusCode
  if (typeof e.status === 'number') return e.status
  return undefined
}

/** Unmerged PR mappings on a job — the set we poll while parked. */
function openPrMappings(job: { prMappings: PrMapping[] }): PrMapping[] {
  return job.prMappings.filter(pm => !pm.mergedAt)
}

function hasPollablePrs(job: { awaitingPrId?: number; prMappings: PrMapping[] }): boolean {
  if (openPrMappings(job).length > 0) return true
  return job.awaitingPrId != null
}

/** PR ids to poll: every open mapping, or legacy scalar awaitingPrId when no mappings. */
function prIdsToPoll(job: { awaitingPrId?: number; prMappings: PrMapping[] }): number[] {
  const open = openPrMappings(job)
  if (open.length > 0) return open.map(pm => pm.prId)
  if (job.awaitingPrId != null) return [job.awaitingPrId]
  return []
}

/**
 * Loose match between the synthetic event the poller wants to fire and
 * the freeform `awaitingEvent` label the agent set via `await_event`.
 *
 * The agent typically sets short labels like `pr:approved`,
 * `pr:rejected`, `pr:merged`, `pr:fulfilled`, sometimes prefixed
 * (`pullrequest:approved`). We accept any awaiting-label that contains
 * the trailing event verb of the synthetic event.
 */
function eventKeyMatchesAwaited(eventKey: string, awaiting: string): boolean {
  const verb = eventKey.includes(':') ? eventKey.split(':').pop()! : eventKey
  const awaitingLower = awaiting.toLowerCase()
  if (awaitingLower.includes(verb.toLowerCase())) return true
  // `merged` ↔ `fulfilled` are Bitbucket vs generic synonyms — allow
  // either to satisfy the other.
  if (verb === 'fulfilled' && awaitingLower.includes('merged')) return true
  if (verb === 'merged' && awaitingLower.includes('fulfilled')) return true
  return false
}
