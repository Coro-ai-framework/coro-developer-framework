import { mkdirSync } from 'fs'
import { join } from 'path'
import type { Logger } from 'pino'
import {
  accumulateNormalizedUsage,
  emptyNormalizedUsage,
  type ChatTool,
  type NormalizedTokenUsage,
  type PhaseExecutorRuntime,
  type PluginMcpServerConfig,
} from '@coro-ai/plugin-sdk'
import type { Settings } from '../config/settings'
import { resolveModelAlias } from '../jobs/phase-assignment'
import type { PluginRegistry } from '../plugins/registry'
import type { IntakeStreamEvent } from './stream-events'
import { toolEndEvent, toolStartEvent } from './stream-events'
import { buildIntakeSubagentSystemPrompt } from './system-prompt'
import type { WorkspaceTools } from '../tools/workspace-tools'
import {
  createIntakeRunTool,
  INTAKE_MAX_SUBAGENT_TASKS,
  INTAKE_SUBAGENT_TIMEOUT_MS,
  type IntakeSubagentDispatcher,
  type IntakeSubagentReport,
  type IntakeToolDeps,
} from './tools'

export const INTAKE_SUBAGENT_MAX_TOOL_ROUNDS = 15
export const INTAKE_SUBAGENT_MAX_OUTPUT_TOKENS = 4096

export function intakeSubagentsEnabled(settings: Settings): boolean {
  return settings.intake?.toolsEnabled !== false && settings.intake?.subagentsEnabled !== false
}

type SubagentExecutor = Pick<PhaseExecutorRuntime, 'supports' | 'manifest'> & {
  chat: NonNullable<PhaseExecutorRuntime['chat']>
}

export function resolveIntakeSubagentModel(
  executor: SubagentExecutor,
  parentModel: string,
  settings: Settings,
): string {
  const canRun = (model: string, provider?: string): boolean => {
    if (!model) return false
    if (provider && executor.manifest?.id && provider !== executor.manifest.id) return false
    try {
      return typeof executor.supports === 'function' && executor.supports(model)
    } catch {
      return false
    }
  }
  const override = settings.intake?.subagentModel?.trim()
  if (override && canRun(override)) return override
  const mini = resolveModelAlias({ tier: 'mini' }, settings.llm?.aliases ?? {})
  if (mini.resolvedFromAlias && canRun(mini.model, mini.provider)) return mini.model
  return parentModel
}

async function withSubagentDeadline<T>(
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), INTAKE_SUBAGENT_TIMEOUT_MS)
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(
      parent.aborted ? 'Aborted' : `Subagent timed out after ${INTAKE_SUBAGENT_TIMEOUT_MS / 1000}s`,
    ))
    if (controller.signal.aborted) fail()
    else controller.signal.addEventListener('abort', fail, { once: true })
  })
  try {
    return await Promise.race([run(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    parent.removeEventListener('abort', onParentAbort)
  }
}

export interface IntakeSubagentDispatcherOptions {
  executor: SubagentExecutor
  parentModel: string
  settings: Settings
  registry: PluginRegistry
  /** Lookup tools only — never includes delegate_investigation, so subagents cannot recurse. */
  lookupTools: ReadonlyArray<ChatTool>
  toolDeps: Pick<IntakeToolDeps, 'stateBackend' | 'workingDir'>
  pluginMcpServers: Record<string, PluginMcpServerConfig>
  /** The conversation's stable work root; each subagent gets its own subdirectory. */
  workRoot: string
  /** Already bound with canAsk: false. Subagents never prompt the developer. */
  permissionGate?: (name: string, input: unknown) => Promise<{ allow: boolean; reason?: string }>
  workspace?: WorkspaceTools
  nativeTools?: boolean
  emit: (event: IntakeStreamEvent) => void
  logger?: Logger
}

export interface IntakeSubagentRunner extends IntakeSubagentDispatcher {
  /** Billed usage of every subagent this turn has run so far. */
  usage(): NormalizedTokenUsage
}

export function createIntakeSubagentDispatcher(opts: IntakeSubagentDispatcherOptions): IntakeSubagentRunner {
  const model = resolveIntakeSubagentModel(opts.executor, opts.parentModel, opts.settings)
  const systemPrompt = buildIntakeSubagentSystemPrompt({ scratchDir: opts.workRoot })
  let usage = emptyNormalizedUsage()
  let inFlight = 0
  let seq = 0

  async function runOne(task: string, label: string, signal: AbortSignal): Promise<IntakeSubagentReport> {
    const n = label.replace(/\D/g, '') || String(seq)
    const cwd = join(opts.workRoot, 'subagents', `subagent-${n}`)
    mkdirSync(cwd, { recursive: true })
    const hasMcp = Object.keys(opts.pluginMcpServers).length > 0
    const hasTools = opts.lookupTools.length > 0
    const result = await opts.executor.chat({
      messages: [{ role: 'user', content: task }],
      systemPrompt,
      model,
      cwd,
      maxOutputTokens: INTAKE_SUBAGENT_MAX_OUTPUT_TOKENS,
      signal,
      ...(opts.permissionGate
        ? { permissionGate: opts.permissionGate, permissionTimeoutMs: 60_000 }
        : {}),
      ...(opts.nativeTools ? { nativeTools: true } : {}),
      ...(hasMcp ? { pluginMcpServers: opts.pluginMcpServers } : {}),
      ...(hasTools || opts.workspace
        ? {
            tools: opts.lookupTools,
            maxToolRounds: INTAKE_SUBAGENT_MAX_TOOL_ROUNDS,
            runTool: createIntakeRunTool(opts.registry, signal, {
              ...opts.toolDeps,
              ...(opts.workspace ? { workspace: opts.workspace } : {}),
              ...(opts.permissionGate ? { gate: opts.permissionGate } : {}),
            }),
          }
        : {}),
      onToolStart: info => opts.emit(toolStartEvent(info, label)),
      onToolEnd: record => opts.emit(toolEndEvent(record, label)),
    })
    usage = accumulateNormalizedUsage(usage, result.usage)
    const output = result.output.trim()
    if (!output) {
      return { task, ok: false, output: '', error: 'The subagent returned an empty response.', toolCalls: result.toolCalls.length }
    }
    return { task, ok: true, output, toolCalls: result.toolCalls.length }
  }

  return {
    usage: () => usage,
    async delegate(tasks, signal) {
      if (inFlight + tasks.length > INTAKE_MAX_SUBAGENT_TASKS) {
        throw new Error(
          `delegate_investigation: ${inFlight} subagent${inFlight === 1 ? ' is' : 's are'} still running, ` +
          `and this call asks for ${tasks.length} more (limit ${INTAKE_MAX_SUBAGENT_TASKS}). ` +
          'Wait for the in-flight subagents to finish before delegating more.',
        )
      }
      const labels = tasks.map(() => {
        seq += 1
        return `Subagent ${seq}`
      })
      inFlight += tasks.length
      try {
        const settled = await Promise.allSettled(
          tasks.map((task, i) => withSubagentDeadline(signal, s => runOne(task, labels[i]!, s))),
        )
        const reports = settled.map((item, i) => {
          if (item.status === 'fulfilled') return item.value
          const reason = item.reason
          return {
            task: tasks[i]!,
            ok: false,
            output: '',
            error: reason instanceof Error ? reason.message : String(reason),
            toolCalls: 0,
          }
        })
        opts.logger?.debug(
          { model, tasks: tasks.length, ok: reports.filter(r => r.ok).length, failed: reports.filter(r => !r.ok).length },
          'intake: subagents settled',
        )
        return reports
      } finally {
        inFlight -= tasks.length
      }
    },
  }
}
