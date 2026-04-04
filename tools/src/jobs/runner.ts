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
import { executeTool, ToolContext } from '../tools/index'
import {
  WorkflowConfig,
  loadWorkflowConfig,
  getNextPhase as wfGetNextPhase,
  getPhaseConfig,
} from '../workflow-parser'
import { JobRegistry } from './registry'
import { Job, STATUS_COMPLETE, STATUS_ESCALATED, STATUS_FAILED, isTerminalStatus, jobServiceName, jobJiraTicketId } from './types'

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
  toolDefinitions: Anthropic.Tool[]
  logger: Logger
}

// ── Workflow-config–driven helpers ────────────────────────────────────────────

function selectModel(phase: string, config: WorkflowConfig | null, settings: Settings): string {
  const pc = config ? getPhaseConfig(config, phase) : null
  const model = pc?.model ?? 'planning'
  return model === 'coding' ? settings.claude.codingModel : settings.claude.planningModel
}

function phaseStatus(phase: string, config: WorkflowConfig | null): string {
  return getPhaseConfig(config ?? { initialPhase: '', initialStatus: '', phases: [], overrides: {} }, phase)?.status ?? phase
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

  // Load the workflow config once at the start of the run.
  // Falls back gracefully — the runner still works without a config,
  // it just can't advance phases automatically.
  const workflowConfig = job.workflowPath
    ? await loadWorkflowConfig(job.workflowPath, settings.paths.a5aiDir, logger)
    : null

  if (!workflowConfig && job.workflowPath) {
    logger.warn({ jobId: job.id, workflowPath: job.workflowPath }, 'No workflow config found — phase advancement will be limited')
  }

  let liveJob: Job = { ...job, _signals: {} }

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
          status: phaseStatus(liveJob.phase, workflowConfig),
          conversationHistory: [{ role: 'user', content: initMsg }],
        })
        toolCtx.job = liveJob
      }

      // Inner loop: tool calls within a single Claude turn
      let turnComplete = false
      while (!turnComplete) {
        const response = await callClaude(
          {
            model: selectModel(liveJob.phase, workflowConfig, settings),
            max_tokens: 8192,
            system: systemPrompt,
            messages: liveJob.conversationHistory as Anthropic.MessageParam[],
            tools: ctx.toolDefinitions,
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

        logger.error({ stopReason: response.stop_reason, jobId: liveJob.id }, 'Unexpected stop reason')
        liveJob = await syncJob(registry, liveJob, {
          status: STATUS_ESCALATED,
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
        const awaitStatus = signals.awaitingEvent.includes('plan')
          ? 'awaiting-plan-approval'
          : 'awaiting-pr-merge'

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
        const nextPhase = workflowConfig
          ? wfGetNextPhase(workflowConfig, liveJob.phase)
          : null

        if (!nextPhase) {
          liveJob = await syncJob(registry, liveJob, { status: STATUS_COMPLETE })
          await registry.appendLog(liveJob.id, 'All phases complete — job finished successfully')
          logger.info({ jobId: liveJob.id }, 'Job completed')
          break
        }

        const nextStatus = phaseStatus(nextPhase, workflowConfig)
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

      logger.warn({ jobId: liveJob.id, phase: liveJob.phase }, 'Claude stopped without signals')
      liveJob = await syncJob(registry, liveJob, {
        status: STATUS_ESCALATED,
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
        status: STATUS_FAILED,
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
    `Service: ${jobServiceName(job)}`,
    `Phase: ${job.phase}`,
    '',
    'Your current job context is in the system prompt. Read your instructions carefully, ' +
    'then begin working through the steps for your current phase. ' +
    'Use the `log` tool to report progress as you go.',
  ]

  const jiraTicketId = jobJiraTicketId(job)
  if (jiraTicketId) {
    lines.push(`\nThis job was triggered by Jira ticket: ${jiraTicketId}`)
  }

  return lines.join('\n')
}

function buildPhaseTransitionMessage(nextPhase: string, job: Job): string {
  return (
    `Phase complete. The job is now advancing to phase: **${nextPhase}**.\n\n` +
    `Your system prompt has been updated with instructions for this phase. ` +
    `Review your new role carefully before proceeding.\n\n` +
    `Job ID: ${job.id} | Service: ${jobServiceName(job)}`
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
