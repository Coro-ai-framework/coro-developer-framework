import { query, type McpSdkServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync } from 'fs'
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
  type WorkflowConfig,
} from '../workflow-parser'
import { JobRegistry } from './registry'
import {
  Job,
  STATUS_AWAITING_PR_MERGE,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  isTerminalStatus,
  jobServiceName,
  jobJiraTicketId,
} from './types'
import { ensureClaudeCodeCliExecutable, resolveClaudeCodeCliPath } from '../claude-code-path'

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

/** Arguments passed to a test/injected `query` implementation. */
export interface QueryInvocation {
  prompt: string
  options: Record<string, unknown>
  signals: PhaseSignals
  /** Shared with MCP tools — same reference as the runner’s live job state. */
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
  const { registry, settings, logger } = ctx

  const runningServices = new Map<string, ChildProcess>()

  const workflowConfig: WorkflowConfig | null =
    options?.workflowConfigOverride !== undefined
      ? options.workflowConfigOverride
      : job.workflowPath
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

  /** Bundled Claude Code entrypoint; npm ships it as non-executable — we chmod if needed. */
  const claudeCodeCliPath = resolveClaudeCodeCliPath(process.cwd())
  ensureClaudeCodeCliExecutable(claudeCodeCliPath, logger)

  try {
    await registry.appendLog(liveJob.id, `Runner started — phase: ${liveJob.phase}`)

    while (!isTerminalStatus(liveJob.status)) {
      // Reset signals for this phase
      resetSignals(signals)

      const systemPrompt = await buildSystemPrompt(liveJob, settings, ctx.gitClient, logger)
      const phaseConf = workflowConfig ? getPhaseConfig(workflowConfig, liveJob.phase) : null

      // pendingPrompt is set by the dispatcher when a webhook event resumes the job.
      // It carries the event content the agent needs to act on.
      const prompt = liveJob.pendingPrompt
        ? liveJob.pendingPrompt
        : liveJob.sessionId
          ? buildPhaseTransitionMessage(liveJob.phase, liveJob)
          : buildInitialMessage(liveJob)

      // Clear pendingPrompt immediately so it isn't replayed on the next turn.
      if (liveJob.pendingPrompt) {
        liveJob = await syncJob(registry, liveJob, { pendingPrompt: undefined })
        toolCtx.job = liveJob
      }

      const model = selectModel(phaseConf, settings)
      const workingDir = path.join(settings.paths.workingDir, liveJob.id)
      /** SDK spawns Claude Code with `cwd: workingDir`. Missing dir causes spawn ENOENT, which the SDK misreports as “cli.js not found”. */
      mkdirSync(workingDir, { recursive: true })

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
        pathToClaudeCodeExecutable: claudeCodeCliPath,
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
        persistSession: true,
        // Must inherit process.env (PATH, HOME, …). A bare object replaces the SDK default and breaks spawn('node', …).
        // BB_* vars give the agent everything it needs to construct authenticated clone URLs without
        // embedding credentials in the system prompt itself.
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: settings.claude.apiKey,
          BB_WORKSPACE: settings.bitbucket.workspace,
          BB_CODER_APP_PASSWORD: settings.bitbucket.coderAccount.appPassword,
          BB_BASE_URL: 'https://bitbucket.org',
          // x-token-auth is the correct git username for BitBucket API tokens (ATATT3x...)
          BB_GIT_USERNAME: settings.bitbucket.coderAccount.appPassword.startsWith('ATATT')
            ? 'x-token-auth'
            : encodeURIComponent(settings.bitbucket.coderAccount.username),
        },
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

      const queryStream = options?.queryImpl
        ? options.queryImpl({ prompt, options: queryOptions, signals, toolCtx })
        : query({
            prompt,
            options: queryOptions as Parameters<typeof query>[0]['options'],
          })

      for await (const raw of queryStream) {
        const message = raw as Record<string, unknown>
        // Capture the session ID for potential resumption
        if (message['type'] === 'system') {
          const sessionIdRaw = message['session_id']
          if (typeof sessionIdRaw === 'string') sessionId = sessionIdRaw
        }

        // Stream assistant text to the job log
        if (message['type'] === 'assistant') {
          const content = message['content']
          if (typeof content === 'string' && content.trim()) {
            await registry.appendLog(liveJob.id, content)
          } else if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block['type'] === 'text' && typeof block['text'] === 'string' && (block['text'] as string).trim()) {
                await registry.appendLog(liveJob.id, block['text'] as string)
              } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
                await registry.appendLog(liveJob.id, `[thinking] ${(block['thinking'] as string).slice(0, 300)}`)
              }
            }
          }
        }

        // Log tool use with inputs
        if (message['type'] === 'tool_use' || message['type'] === 'tool_use_summary') {
          const toolName = message['tool_name'] ?? message['name'] ?? 'unknown'
          const input = message['input'] ?? message['params']
          const inputStr = input ? ` ${JSON.stringify(input).slice(0, 300)}` : ''
          await registry.appendLog(liveJob.id, `→ ${String(toolName)}${inputStr}`)
        }

        // Log tool results
        if (message['type'] === 'tool_result') {
          const toolName = message['tool_name'] ?? message['name'] ?? 'unknown'
          const isError = message['is_error'] ?? false
          const content = message['content']
          const resultStr = typeof content === 'string' ? content.slice(0, 300) : JSON.stringify(content).slice(0, 300)
          const prefix = isError ? '✗' : '✓'
          await registry.appendLog(liveJob.id, `${prefix} ${String(toolName)}: ${resultStr}`)
        }

        // Log any other event types for debugging (result event carries Claude's final summary)
        const knownTypes = new Set(['system', 'assistant', 'tool_use', 'tool_use_summary', 'tool_result', 'user'])
        if (!knownTypes.has(String(message['type'] ?? ''))) {
          const eventType = String(message['type'])
          // For the final result event, log the full result text rather than truncated JSON
          if (eventType === 'result') {
            const result = message['result']
            if (typeof result === 'string') {
              await registry.appendLog(liveJob.id, `[result] ${result}`)
            } else {
              await registry.appendLog(liveJob.id, `[event:result] ${JSON.stringify(message)}`)
            }
          } else {
            await registry.appendLog(liveJob.id, `[event:${eventType}] ${JSON.stringify(message).slice(0, 500)}`)
          }
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

        // Ensure the pr→job reverse-lookup key exists so webhooks can find this job.
        // This covers cases where the PR was created outside bb_create_pr (e.g. curl).
        if (signals.awaitingPrId) {
          await registry.mapPrToJob(signals.awaitingPrId, liveJob.id)
        }

        logger.info(
          { jobId: liveJob.id, awaiting: signals.awaitingEvent, prId: signals.awaitingPrId },
          'Job parked — awaiting external event',
        )
        await registry.appendLog(liveJob.id, `Job parked — waiting for: ${signals.awaitingEvent}`)
        break
      }

      if (signals.phaseComplete) {
        const nextPhase = signals.nextPhase
          ?? (workflowConfig ? wfGetNextPhase(workflowConfig, liveJob.phase) : null)

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

      // Claude stopped without calling any job-control tool.
      // Safety net: if a PR was mapped to this job during the current turn
      // (e.g. agent used curl instead of mcp__a5__bb_create_pr), auto-park it.
      const freshJob = await registry.getJob(liveJob.id)
      const latestPrMapping = freshJob?.prMappings.at(-1)
      if (latestPrMapping) {
        logger.warn(
          { jobId: liveJob.id, prId: latestPrMapping.prId },
          'No signal but PR mapping exists — auto-parking job waiting for PR merge',
        )
        await registry.appendLog(
          liveJob.id,
          `[auto-park] PR #${latestPrMapping.prId} detected. Agent did not call await_event — parking automatically.`,
        )
        liveJob = await syncJob(registry, liveJob, {
          status: STATUS_AWAITING_PR_MERGE,
          awaitingEvent: 'pr:fulfilled',
          awaitingPrId: latestPrMapping.prId,
        })
        break
      }

      logger.warn({ jobId: liveJob.id, phase: liveJob.phase }, 'Agent SDK query ended without signals')
      const noSignalMsg =
        `Escalated: Claude finished this phase without calling mark_phase_complete or await_event ` +
        `(phase: ${liveJob.phase}). Manual inspection needed.`
      await registry.appendLog(liveJob.id, noSignalMsg)
      liveJob = await syncJob(registry, liveJob, {
        status: STATUS_ESCALATED,
        escalationMessage: noSignalMsg,
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
  s.nextPhase = undefined
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
