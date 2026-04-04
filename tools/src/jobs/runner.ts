import Anthropic from '@anthropic-ai/sdk'
import { Logger } from 'pino'
import { ChildProcess } from 'child_process'
import { BitBucketClient } from '../clients/bitbucket'
import { GitClient } from '../clients/git'
import { JiraClient } from '../clients/jira'
import { LokiClient } from '../clients/loki'
import { TempoClient } from '../clients/tempo'
import { Settings } from '../config/settings'
import { buildSystemPrompt } from '../prompt/builder'
import { TOOL_DEFINITIONS } from '../prompt/tools'
import { executeTool, ToolContext } from '../tools/index'
import { JobRegistry } from './registry'
import { Job, JobPhase, JobStatus, JobType, isTerminalStatus } from './types'

// ── Runner context ────────────────────────────────────────────────────────────

export interface RunnerContext {
  registry: JobRegistry
  settings: Settings
  gitClient: GitClient
  bbCoder: BitBucketClient
  bbReviewer: BitBucketClient
  lokiClient: LokiClient
  tempoClient: TempoClient
  jiraClient: JiraClient
  anthropic: Anthropic
  logger: Logger
}

// ── Phase sequences ───────────────────────────────────────────────────────────
//
// Defines the ordered phases for each workflow type.
// The runner advances through this list when mark_phase_complete is called.
// The agent controls when to advance — calling mark_phase_complete signals
// readiness. Parking (await_event) happens within a phase, not between them.

const MIGRATION_PHASES: JobPhase[] = [
  JobPhase.Init,
  JobPhase.Analysis,
  JobPhase.Planning,
  JobPhase.RepoSetup,
  JobPhase.Coding,
  JobPhase.Review,
  JobPhase.Testing,
  JobPhase.Evaluation,
  JobPhase.Reporting,
]

const FEATURE_PHASES: JobPhase[] = [
  JobPhase.Planning,
  JobPhase.Coding,
  JobPhase.Review,
  JobPhase.Testing,
  JobPhase.Evaluation,
]

const JIRA_FEATURE_PHASES: JobPhase[] = [
  JobPhase.SpecWriting,
  ...FEATURE_PHASES,
]

function getPhaseSequence(job: Job): JobPhase[] {
  if (job.type === JobType.Migration) return MIGRATION_PHASES
  if (job.type === JobType.Feature && job.triggerSource === 'jira') return JIRA_FEATURE_PHASES
  if (job.type === JobType.Feature) return FEATURE_PHASES
  return []
}

function getNextPhase(job: Job): JobPhase | null {
  const sequence = getPhaseSequence(job)
  const idx = sequence.indexOf(job.phase)
  if (idx === -1 || idx === sequence.length - 1) return null
  return sequence[idx + 1]
}

// ── Phase → status mapping ────────────────────────────────────────────────────

const PHASE_STATUS: Partial<Record<JobPhase, JobStatus>> = {
  [JobPhase.Init]:        JobStatus.Initializing,
  [JobPhase.SpecWriting]: JobStatus.SpecWriting,
  [JobPhase.Analysis]:    JobStatus.Analyzing,
  [JobPhase.Planning]:    JobStatus.Planning,
  [JobPhase.RepoSetup]:   JobStatus.RepoSetup,
  [JobPhase.Coding]:      JobStatus.Coding,
  [JobPhase.Review]:      JobStatus.Coding,
  [JobPhase.Testing]:     JobStatus.Testing,
  [JobPhase.Evaluation]:  JobStatus.Evaluating,
  [JobPhase.Reporting]:   JobStatus.Reporting,
}

// ── Model selection ───────────────────────────────────────────────────────────

const PLANNING_PHASES = new Set<JobPhase>([
  JobPhase.SpecWriting,
  JobPhase.Analysis,
  JobPhase.Planning,
  JobPhase.Evaluation,
  JobPhase.Reporting,
])

function selectModel(phase: JobPhase, settings: Settings): string {
  return PLANNING_PHASES.has(phase)
    ? settings.claude.planningModel
    : settings.claude.codingModel
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run a job to completion (or until parked/escalated).
 *
 * The outer loop advances through phases. The inner loop handles tool calls
 * within a single Claude turn. Both loops terminate when the job reaches a
 * terminal or parked state.
 *
 * Signal flow:
 *   - Tools set flags on ctx.job._signals (in-memory only, never persisted)
 *   - After each Claude turn (stop_reason === 'end_turn'), the runner reads
 *     those signals and decides what to do next
 *   - _signals are reset after each turn
 */
export async function runJob(job: Job, ctx: RunnerContext): Promise<void> {
  const { registry, settings, logger } = ctx

  // Per-run state — not shared across concurrent jobs
  const runningServices = new Map<string, ChildProcess>()

  // `liveJob` is the authoritative in-memory state for this run.
  // We persist to Redis regularly but preserve _signals across updateJob calls
  // (registry strips _signals on every write, by design).
  let liveJob: Job = { ...job, _signals: {} }

  // toolCtx is mutated in-place — we reassign toolCtx.job after each registry
  // update so tool implementations always see the latest job state.
  const toolCtx: ToolContext = {
    job: liveJob,
    registry,
    settings,
    gitClient: ctx.gitClient,
    bbCoder: ctx.bbCoder,
    bbReviewer: ctx.bbReviewer,
    lokiClient: ctx.lokiClient,
    tempoClient: ctx.tempoClient,
    jiraClient: ctx.jiraClient,
    logger,
    runningServices,
  }

  logger.info({ jobId: liveJob.id, type: liveJob.type, phase: liveJob.phase }, 'Job runner started')

  try {
    await registry.appendLog(liveJob.id, `Runner started — phase: ${liveJob.phase}`)

    // Outer loop: one iteration per phase
    while (!isTerminalStatus(liveJob.status)) {

      // Build the system prompt for the current phase
      const systemPrompt = await buildSystemPrompt(liveJob, settings, ctx.gitClient, logger)

      // If this is the first turn ever, add an initial user message to kick things off
      if (liveJob.conversationHistory.length === 0) {
        const initMsg = buildInitialMessage(liveJob)
        liveJob = await syncJob(registry, liveJob, {
          status: PHASE_STATUS[liveJob.phase] ?? JobStatus.Initializing,
          conversationHistory: [{ role: 'user', content: initMsg }],
        })
        toolCtx.job = liveJob
      }

      // Inner loop: tool calls within a single Claude turn
      let turnComplete = false
      while (!turnComplete) {
        const response = await callClaude(
          {
            model: selectModel(liveJob.phase, settings),
            max_tokens: 8192,
            system: systemPrompt,
            messages: liveJob.conversationHistory as Anthropic.MessageParam[],
            tools: TOOL_DEFINITIONS,
          },
          ctx.anthropic,
          logger,
        )

        logger.debug(
          { jobId: liveJob.id, stopReason: response.stop_reason, tokens: response.usage },
          'Claude response received',
        )

        // Always append the assistant message before doing anything else
        const assistantHistory = [
          ...liveJob.conversationHistory,
          { role: 'assistant' as const, content: response.content },
        ]

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
          // Save the final history for this turn and exit the inner loop
          const savedSignals = liveJob._signals ?? {}
          liveJob = await syncJob(registry, liveJob, { conversationHistory: assistantHistory })
          liveJob._signals = savedSignals
          toolCtx.job = liveJob
          turnComplete = true
          break
        }

        if (response.stop_reason === 'tool_use') {
          // Execute every tool_use block in the response
          const toolResultBlocks: Anthropic.ToolResultBlockParam[] = []

          for (const block of response.content) {
            if (block.type !== 'tool_use') continue

            logger.debug({ jobId: liveJob.id, tool: block.name }, 'Executing tool')
            await registry.appendLog(liveJob.id, `→ ${block.name}(${summariseInput(block.input)})`)

            const result = await executeTool(block.name, block.input, toolCtx)

            await registry.appendLog(
              liveJob.id,
              `← ${block.name}: ${result.success ? 'ok' : `error: ${result.error}`}`,
            )

            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            })
          }

          // Append assistant message + tool results, preserving _signals
          const newHistory = [
            ...assistantHistory,
            { role: 'user' as const, content: toolResultBlocks },
          ]

          const savedSignals = liveJob._signals ?? {}
          liveJob = await syncJob(registry, liveJob, { conversationHistory: newHistory })
          liveJob._signals = savedSignals
          toolCtx.job = liveJob

          // Check if the job was escalated mid-turn (escalate tool sets status directly)
          if (isTerminalStatus(liveJob.status)) {
            turnComplete = true
          }

          continue
        }

        // Unexpected stop reason — escalate
        logger.error({ stopReason: response.stop_reason, jobId: liveJob.id }, 'Unexpected stop reason')
        liveJob = await syncJob(registry, liveJob, {
          status: JobStatus.Escalated,
          escalationMessage: `Unexpected Claude stop_reason: ${response.stop_reason}`,
        })
        toolCtx.job = liveJob
        turnComplete = true
      }

      // ── Post-turn signal processing ──────────────────────────────────────

      if (isTerminalStatus(liveJob.status)) break

      const signals = liveJob._signals ?? {}
      liveJob._signals = {}

      if (signals.awaitingEvent) {
        // Park the job until the expected external event arrives
        const awaitStatus = signals.awaitingEvent.includes('plan')
          ? JobStatus.AwaitingPlanApproval
          : JobStatus.AwaitingPrMerge

        liveJob = await syncJob(registry, liveJob, {
          status: awaitStatus,
          awaitingEvent: signals.awaitingEvent,
          awaitingPrId: signals.awaitingPrId,
        })

        logger.info(
          { jobId: liveJob.id, awaiting: signals.awaitingEvent, prId: signals.awaitingPrId },
          'Job parked — awaiting external event',
        )
        await registry.appendLog(liveJob.id, `Job parked — waiting for: ${signals.awaitingEvent}`)
        break
      }

      if (signals.phaseComplete) {
        const nextPhase = getNextPhase(liveJob)

        if (!nextPhase) {
          // No more phases — job is done
          liveJob = await syncJob(registry, liveJob, { status: JobStatus.Complete })
          await registry.appendLog(liveJob.id, 'All phases complete — job finished successfully')
          logger.info({ jobId: liveJob.id }, 'Job completed')
          break
        }

        const nextStatus = PHASE_STATUS[nextPhase] ?? JobStatus.Initializing
        const transitionMsg = buildPhaseTransitionMessage(nextPhase, liveJob)

        liveJob = await syncJob(registry, liveJob, {
          phase: nextPhase,
          status: nextStatus,
          conversationHistory: [
            ...liveJob.conversationHistory,
            { role: 'user', content: transitionMsg },
          ],
        })
        toolCtx.job = liveJob

        logger.info({ jobId: liveJob.id, phase: nextPhase }, 'Phase advanced')
        await registry.appendLog(liveJob.id, `Phase advanced → ${nextPhase}`)
        continue // start new outer iteration for the new phase
      }

      // Claude stopped without any signals — escalate for human inspection
      logger.warn({ jobId: liveJob.id, phase: liveJob.phase }, 'Claude stopped without signals')
      liveJob = await syncJob(registry, liveJob, {
        status: JobStatus.Escalated,
        escalationMessage:
          `Claude stopped without calling mark_phase_complete or await_event ` +
          `(phase: ${liveJob.phase}). Manual inspection needed.`,
      })
      break
    }
  } catch (err) {
    logger.error({ err, jobId: liveJob.id }, 'Runner crashed — marking job failed')
    await registry.appendLog(liveJob.id, `Runner crashed: ${String(err)}`)
    try {
      await registry.updateJob(liveJob.id, {
        status: JobStatus.Failed,
        escalationMessage: String(err),
      })
    } catch {
      // Best-effort — don't mask the original error
    }
  } finally {
    // Clean up any Go processes the test harness started
    for (const [label, proc] of runningServices) {
      proc.kill('SIGTERM')
      logger.debug({ label }, 'Cleaned up running service')
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Merge a patch into the job and persist to Redis.
 * The returned job has _signals = {} (stripped by registry) — callers must
 * restore _signals manually if they need to preserve them across this call.
 */
async function syncJob(
  registry: JobRegistry,
  job: Job,
  patch: Parameters<JobRegistry['updateJob']>[1],
): Promise<Job> {
  return registry.updateJob(job.id, patch)
}

/** Call Claude with exponential backoff on 429 and 5xx errors. */
async function callClaude(
  params: Anthropic.MessageCreateParamsNonStreaming,
  anthropic: Anthropic,
  logger: Logger,
  attempt = 0,
): Promise<Anthropic.Message> {
  try {
    return await anthropic.messages.create(params)
  } catch (err) {
    if (attempt >= 2) throw err

    const apiErr = err as { status?: number }
    const isRetryable =
      err instanceof Error && 'status' in err && (apiErr.status === 429 || (apiErr.status ?? 0) >= 500)

    if (!isRetryable) throw err

    const delay = Math.pow(2, attempt + 1) * 1000
    logger.warn({ attempt, delay, status: (err as { status?: number }).status }, 'Claude API error — retrying')
    await sleep(delay)
    return callClaude(params, anthropic, logger, attempt + 1)
  }
}

function buildInitialMessage(job: Job): string {
  const lines = [
    `A new ${job.type} job has started.`,
    `Job ID: ${job.id}`,
    `Service: ${job.serviceName}`,
    `Phase: ${job.phase}`,
    '',
    'Your current job context is in the system prompt. Read your instructions carefully, ' +
    'then begin working through the steps for your current phase. ' +
    'Use the `log` tool to report progress as you go.',
  ]

  if (job.type === JobType.Feature && job.jiraTicketId) {
    lines.push(`\nThis job was triggered by Jira ticket: ${job.jiraTicketId}`)
  }

  return lines.join('\n')
}

function buildPhaseTransitionMessage(nextPhase: JobPhase, job: Job): string {
  return (
    `Phase complete. The job is now advancing to phase: **${nextPhase}**.\n\n` +
    `Your system prompt has been updated with instructions for this phase. ` +
    `Review your new role carefully before proceeding.\n\n` +
    `Job ID: ${job.id} | Service: ${job.serviceName}`
  )
}

/** Produce a short one-line summary of tool inputs for the log stream. */
function summariseInput(input: unknown): string {
  if (!input || typeof input !== 'object') return String(input)
  const entries = Object.entries(input as Record<string, unknown>)
    .slice(0, 3)
    .map(([k, v]) => {
      const str = typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)?.slice(0, 40)
      return `${k}=${str}`
    })
  return entries.join(', ')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
