import { query, type McpSdkServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { Logger } from 'pino'
import { ChildProcess } from 'child_process'
import path from 'path'
import { BitBucketClient } from '../clients/bitbucket'
import { GitClient } from '../clients/git'
import { JiraClient } from '../clients/jira'
import { LokiClient } from '../clients/loki'
import { TempoClient } from '../clients/tempo'
import { Settings } from '../config/settings'
import { buildSystemPrompt } from '../prompt/builder'
import { createA5McpServer } from '../mcp-server'
import { ToolContext, PhaseSignals } from '../tools/types'
import {
  loadWorkflowConfig,
  getNextPhase as wfGetNextPhase,
  getPhaseConfig,
  SubagentConfig,
} from '../workflow-parser'
import { JobRegistry } from './registry'
import {
  Job,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  isTerminalStatus,
  jobServiceName,
  jobJiraTicketId,
} from './types'

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
  logger: Logger
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
export async function runJob(job: Job, ctx: RunnerContext): Promise<void> {
  const { registry, settings, logger } = ctx

  const runningServices = new Map<string, ChildProcess>()

  const workflowConfig = job.workflowPath
    ? await loadWorkflowConfig(job.workflowPath, settings.paths.a5aiDir, logger)
    : null

  if (!workflowConfig && job.workflowPath) {
    logger.warn({ jobId: job.id, workflowPath: job.workflowPath }, 'No workflow config found')
  }

  let liveJob: Job = { ...job }

  // Shared mutable context — the MCP server's tool handlers close over these
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

  const signals: PhaseSignals = {}
  const mcpServer = createA5McpServer(toolCtx, signals)

  logger.info({ jobId: liveJob.id, type: liveJob.type, phase: liveJob.phase }, 'Job runner started')

  try {
    await registry.appendLog(liveJob.id, `Runner started — phase: ${liveJob.phase}`)

    while (!isTerminalStatus(liveJob.status)) {
      // Reset signals for this phase
      resetSignals(signals)

      const systemPrompt = await buildSystemPrompt(liveJob, settings, ctx.gitClient, logger)
      const phaseConf = workflowConfig ? getPhaseConfig(workflowConfig, liveJob.phase) : null

      const prompt = liveJob.sessionId
        ? buildPhaseTransitionMessage(liveJob.phase, liveJob)
        : buildInitialMessage(liveJob)

      const model = selectModel(phaseConf, settings)
      const workingDir = path.join(settings.paths.workingDir, liveJob.id)

      // Build subagent definitions from workflow config
      const agents = phaseConf?.subagents
        ? buildSubagentDefinitions(phaseConf.subagents, settings, mcpServer as McpSdkServerConfig)
        : undefined

      // Update job status for the current phase
      const phaseStatus = phaseConf?.status ?? liveJob.phase
      liveJob = await syncJob(registry, liveJob, { status: phaseStatus })
      toolCtx.job = liveJob

      logger.info(
        { jobId: liveJob.id, phase: liveJob.phase, model },
        'Starting Agent SDK query for phase',
      )

      const queryOptions: Record<string, unknown> = {
        systemPrompt,
        model,
        cwd: workingDir,
        mcpServers: { a5: mcpServer },
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
          'mcp__a5__*',
          ...(agents ? ['Agent'] : []),
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 200,
        thinking: { type: 'adaptive' },
        persistSession: false,
        env: { ANTHROPIC_API_KEY: settings.claude.apiKey },
      }

      if (agents) {
        queryOptions.agents = agents
      }

      // Resume from previous session or start fresh
      if (liveJob.sessionId) {
        queryOptions.resume = liveJob.sessionId
      }

      // Run the Agent SDK query — this handles the entire tool-use loop
      let sessionId: string | undefined

      for await (const message of query({
        prompt,
        options: queryOptions as Parameters<typeof query>[0]['options'],
      })) {
        // Capture the session ID for potential resumption
        if (message.type === 'system') {
          const sysMsg = message as Record<string, unknown>
          if (sysMsg.session_id) {
            sessionId = sysMsg.session_id as string
          }
        }

        // Stream assistant text to the job log
        if (message.type === 'assistant') {
          const msg = message as Record<string, unknown>
          const content = msg.content
          if (typeof content === 'string' && content.trim()) {
            await registry.appendLog(liveJob.id, content.slice(0, 500))
          }
        }

        // Log tool usage
        if (message.type === 'tool_use_summary') {
          const msg = message as Record<string, unknown>
          const toolName = msg.tool_name ?? msg.name ?? 'unknown'
          await registry.appendLog(liveJob.id, `→ ${String(toolName)}`)
        }

        // If signals were set (job control tools were called), we can stop early
        if (signals.phaseComplete || signals.awaitingEvent || signals.escalated) {
          break
        }
      }

      // Store session ID for potential future resumption
      if (sessionId) {
        liveJob = await syncJob(registry, liveJob, { sessionId })
        toolCtx.job = liveJob
      }

      // ── Post-query signal processing ───────────────────────────────────────

      if (isTerminalStatus(liveJob.status)) break

      if (signals.escalated) {
        break
      }

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

        liveJob = await syncJob(registry, liveJob, { phase: nextPhase })
        toolCtx.job = liveJob

        logger.info({ jobId: liveJob.id, phase: nextPhase }, 'Phase advanced')
        await registry.appendLog(liveJob.id, `Phase advanced → ${nextPhase}`)
        continue
      }

      // Claude stopped without calling any job-control tool
      logger.warn({ jobId: liveJob.id, phase: liveJob.phase }, 'Agent SDK query ended without signals')
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

async function syncJob(
  registry: JobRegistry,
  job: Job,
  patch: Partial<Job>,
): Promise<Job> {
  return registry.updateJob(job.id, patch)
}

function resetSignals(s: PhaseSignals): void {
  s.phaseComplete = undefined
  s.awaitingEvent = undefined
  s.awaitingPrId = undefined
  s.escalated = undefined
  s.escalationReason = undefined
}

function selectModel(
  phaseConf: { model?: string } | null | undefined,
  settings: Settings,
): string {
  const model = phaseConf?.model ?? 'planning'
  return model === 'coding' ? settings.claude.codingModel : settings.claude.planningModel
}

function buildSubagentDefinitions(
  subagents: SubagentConfig[],
  settings: Settings,
  mcpServer: McpSdkServerConfig,
) {
  const defs: Record<string, unknown> = {}
  for (const sa of subagents) {
    defs[sa.name] = {
      description: `Subagent: ${sa.name}`,
      prompt: sa.agent
        ? `You are the ${sa.name} subagent. Follow your instructions carefully.`
        : `You are a helper subagent named ${sa.name}.`,
      tools: sa.tools ?? ['Read', 'Glob', 'Grep', 'Bash', 'mcp__a5__*'],
      model: sa.model === 'coding'
        ? (settings.claude.codingModel.includes('opus') ? 'opus' : 'sonnet')
        : (sa.model ?? 'inherit'),
      mcpServers: [mcpServer],
    }
  }
  return defs
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
