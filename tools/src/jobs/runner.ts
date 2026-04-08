import { query, type McpSdkServerConfig, type Query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, readFileSync } from 'fs'
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
  STATUS_COMPLETE,
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

  logger.info({ jobId: liveJob.id, type: liveJob.type, phase: liveJob.phase }, 'Job runner started')

  /** Bundled Claude Code entrypoint; npm ships it as non-executable — we chmod if needed. */
  const claudeCodeCliPath = resolveClaudeCodeCliPath(process.cwd())
  ensureClaudeCodeCliExecutable(claudeCodeCliPath, logger)

  try {
    await registry.appendLog(liveJob.id, `Runner started — phase: ${liveJob.phase}`)

    while (!isTerminalStatus(liveJob.status)) {
      // Reset signals and create a fresh MCP server for each phase.
      // Reusing the MCP server across phases can leave the transport in a
      // broken state if the previous Claude Code subprocess exited uncleanly.
      resetSignals(signals)
      const mcpServer = createA5McpServer(toolCtx, signals)

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
      /** SDK spawns Claude Code with `cwd: workingDir`. Missing dir causes spawn ENOENT, which the SDK misreports as "cli.js not found". */
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
          // SDK default is 60s — agent phases run for minutes to hours. Without
          // this, the Claude Code subprocess closes the MCP transport mid-phase,
          // leaving all mcp__a5__* tools disconnected while built-in tools still work.
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000',
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

      // Register the Query reference so the dispatcher can inject human
      // messages via streamInput(). Only real SDK Query objects (not test
      // mocks) have the streamInput method.
      const isRealQuery = !options?.queryImpl && typeof (queryStream as Query).streamInput === 'function'
      if (isRealQuery) {
        options?.onQueryStart?.(liveJob.id, queryStream as Query)
      }

      try {
      for await (const raw of queryStream) {
        const message = raw as Record<string, unknown>
        const eventType = String(message['type'] ?? '')

        // Capture the session ID from any event that carries it
        if (eventType === 'system') {
          const sid = message['session_id']
          if (typeof sid === 'string') sessionId = sid
        }

        // SDKAssistantMessage: wraps a BetaMessage at message.message with content blocks.
        // Content blocks include text, thinking, tool_use, and mcp_tool_use.
        if (eventType === 'assistant') {
          const betaMsg = message['message'] as Record<string, unknown> | undefined
          const content = betaMsg?.['content']
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              const bt = String(block['type'] ?? '')
              if (bt === 'text' && typeof block['text'] === 'string' && (block['text'] as string).trim()) {
                await registry.appendLog(liveJob.id, block['text'] as string)
              } else if (bt === 'thinking' && typeof block['thinking'] === 'string') {
                await registry.appendLog(liveJob.id, `[thinking] ${(block['thinking'] as string).slice(0, 300)}`)
              } else if (bt === 'tool_use' || bt === 'mcp_tool_use') {
                const toolName = String(block['name'] ?? 'unknown')
                const input = block['input']
                const inputStr = input ? ` ${JSON.stringify(input).slice(0, 300)}` : ''
                await registry.appendLog(liveJob.id, `→ ${toolName}${inputStr}`)
              }
            }
          }
        }

        // SDKToolUseSummaryMessage: human-readable summary of preceding tool uses
        if (eventType === 'tool_use_summary') {
          const summary = message['summary']
          if (typeof summary === 'string' && summary.trim()) {
            await registry.appendLog(liveJob.id, `[tool_summary] ${summary.slice(0, 500)}`)
          }
        }

        // SDKToolProgressMessage: heartbeat for long-running tools
        if (eventType === 'tool_progress') {
          const toolName = message['tool_name']
          const elapsed = message['elapsed_time_seconds']
          if (typeof toolName === 'string' && typeof elapsed === 'number' && elapsed >= 10) {
            await registry.appendLog(liveJob.id, `⏳ ${toolName} running (${Math.round(elapsed)}s)`)
          }
        }

        // SDKResultMessage: final result when query() completes
        if (eventType === 'result') {
          const isError = message['is_error']
          if (isError) {
            const errors = message['errors']
            const errStr = Array.isArray(errors) ? (errors as string[]).join('; ') : 'unknown error'
            await registry.appendLog(liveJob.id, `[error] ${errStr.slice(0, 500)}`)
          } else {
            const result = message['result']
            if (typeof result === 'string' && result.trim()) {
              await registry.appendLog(liveJob.id, `[result] ${result}`)
            }
          }
        }

        // Silently ignore: user messages, stream_event (partial deltas — too noisy),
        // auth_status, and other internal system subtypes. Log truly unexpected types.
        const handledTypes = new Set([
          'system', 'assistant', 'tool_use_summary', 'tool_progress', 'result',
          'user', 'stream_event', 'auth_status',
        ])
        if (!handledTypes.has(eventType)) {
          await registry.appendLog(liveJob.id, `[event:${eventType}] ${JSON.stringify(message).slice(0, 500)}`)
        }

        // If an exception signal was set, stop processing the stream early.
        // phaseComplete is an optional hint — the runner auto-advances anyway.
        if (signals.phaseComplete || signals.nextPhase || signals.awaitingEvent || signals.escalated) {
          break
        }
      }
      } finally {
        if (isRealQuery) {
          options?.onQueryEnd?.(liveJob.id)
        }
      }

      // Store session ID for potential future resumption
      if (sessionId) {
        liveJob = await syncJob(registry, liveJob, { sessionId })
        toolCtx.job = liveJob
      }

      // ── Post-query signal processing ───────────────────────────────────────
      //
      // Priority order:
      //   1. Terminal status (already completed by another mechanism) → stop
      //   2. Escalated (agent explicitly asked for human help) → stop
      //   3. Awaiting event (agent needs to wait for external input) → park
      //   4. Default: auto-advance to the next phase (or complete if none)
      //
      // The agent does NOT need to call mark_phase_complete. Finishing the
      // query is sufficient — the runner treats "no exception signal" as
      // "phase done, move on." This eliminates the most common failure mode
      // where the LLM forgets to call a job-control tool.

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

      // Default: auto-advance to the next phase.
      // goto_phase overrides the next phase; otherwise use the workflow sequence.
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
  } catch (err) {
    logger.error({ err, jobId: liveJob.id }, 'Runner crashed — marking job failed')
    await registry.appendLog(liveJob.id, `Runner crashed: ${String(err)}`)
    try {
      const current = await registry.getJob(liveJob.id)
      if (!current || !isTerminalStatus(current.status)) {
        // Clear sessionId so the next resume starts a fresh Claude Code subprocess.
        // A crash (529 overload, network error, SDK bug) leaves the MCP transport in
        // a broken state — resuming the old session would give the agent working
        // built-in tools but broken mcp__a5__* tools. A fresh session costs
        // conversation context but restores full MCP connectivity.
        await registry.updateJob(liveJob.id, {
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
    let agentPrompt = `You are a helper subagent named ${sa.name}.`
    if (sa.agent) {
      try {
        const agentMd = readFileSync(
          path.join(settings.paths.a5aiDir, sa.agent),
          'utf-8',
        )
        agentPrompt = agentMd
      } catch {
        agentPrompt = `You are the ${sa.name} subagent. Follow your instructions carefully.`
      }
    }

    defs[sa.name] = {
      description: `Subagent: ${sa.name}`,
      prompt: agentPrompt,
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
