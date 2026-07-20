// ── run_subagent MCP tool ─────────────────────────────────────────────────────
//
// Single-shot side-conversation dispatcher. The parent agent calls
// `mcp__coro__run_subagent({ name, task })`; the runner looks up the
// matching `subagents:` entry on the active phase config, builds a
// {@link SubagentExecutionRequest} from it, resolves the right
// executor (parent's by default; the subagent's `provider` override
// when set), and calls `executor.runSubagent(req)`.
//
// Modelled on Anthropic's Task tool — fresh stateless conversation,
// no recursion, no session resume, no developer-input channel.
//
// Registration is gated on the *parent phase's* executor capability:
// when `executor.capabilities.supportsNativeSubagents === true`
// (Anthropic SDK), the runner skips registering this tool to avoid
// two parallel dispatch paths. See `mcp-server.ts`.

import { readFileSync } from 'fs'
import path from 'path'
import type { HookPolicy, SubagentExecutionRequest } from '@coro-ai/plugin-sdk'
import type { ToolContext } from './types'
import { resolveModelAlias } from '../jobs/phase-assignment'

/**
 * Tool whitelist applied when a workflow YAML omits `subagents[].tools`.
 * Read-only tools + Coro MCP surface are always safe; Write/Edit/Bash
 * stay opt-in per workflow.
 */
const DEFAULT_SUBAGENT_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Skill',
  'mcp__coro__read_memory',
  'mcp__coro__read_skill',
  'mcp__coro__file_read',
  'mcp__coro__file_glob',
  'mcp__coro__file_grep',
] as const

/** Hard cap on per-phase concurrent subagent invocations. */
const MAX_CONCURRENT_PER_PHASE = 4

/**
 * Per-phase concurrency counter, keyed by `${jobId}:${phase}`. Reset
 * implicitly on phase boundaries because keys age out only when the
 * runner finishes — fine because counts are decremented in the tool's
 * `finally`.
 */
const inFlight = new Map<string, number>()

export interface RunSubagentInput {
  name: string
  task: string
}

export interface RunSubagentResult {
  output: string
  stopReason: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    totalCostUsd?: number
  }
}

export async function runSubagent(
  ctx: ToolContext,
  input: RunSubagentInput,
): Promise<RunSubagentResult> {
  // ── Boundary validation ──────────────────────────────────────────
  // Belt-and-suspenders alongside OpenAI strict-mode schema checks:
  // some providers / older models still slip past the schema, and a
  // missing `task` here would otherwise propagate as `userPrompt:
  // undefined` into the subagent's first turn and surface as an
  // opaque "Missing required parameter: input[0].content" from the
  // OpenAI API — unrecoverable signal for the calling agent.
  if (!input || typeof input !== 'object') {
    throw new Error(
      'run_subagent: invalid arguments. Expected { name: string, task: string }. ' +
      'Example: { "name": "code-reviewer", "task": "Review the diff at <path>" }',
    )
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new Error(
      'run_subagent: missing required string field "name". ' +
      'Schema: { name: string, task: string }. ' +
      'Example: { "name": "code-reviewer", "task": "Review the diff at <path>" }. ' +
      'Note: the field is named "name" — not "agent", "subagent", or "subagentName".',
    )
  }
  if (typeof input.task !== 'string' || input.task.trim() === '') {
    throw new Error(
      'run_subagent: missing required string field "task". ' +
      'Schema: { name: string, task: string }. ' +
      'Example: { "name": "code-reviewer", "task": "Review the diff at <path>" }. ' +
      'Note: the field is named "task" — not "prompt", "input", "message", or "description". ' +
      'Pass a single plain-text string describing the entire job; the subagent has no view of your conversation.',
    )
  }

  const phase = ctx.currentPhase
  if (!phase) {
    throw new Error('run_subagent: no active phase context — tool invoked outside a phase invocation.')
  }

  const decl = phase.phaseConf.subagents?.find(s => s.name === input.name)
  if (!decl) {
    const available = (phase.phaseConf.subagents ?? []).map(s => s.name).join(', ') || '<none>'
    throw new Error(
      `run_subagent: unknown subagent "${input.name}" for phase "${phase.phaseConf.name}". ` +
      `Declared subagents: ${available}`,
    )
  }

  // Resolve the executor: explicit `provider:` on the subagent wins,
  // otherwise the parent phase's executor handles it.
  const subagentExecutor = decl.provider
    ? ctx.plugins.resolveExecutor({ provider: decl.provider })
    : phase.executor

  if (typeof subagentExecutor.runSubagent !== 'function') {
    throw new Error(
      `run_subagent: executor "${subagentExecutor.manifest.id}" does not implement runSubagent(). ` +
      `Did the workflow pin a subagent to a provider with native subagent dispatch?`,
    )
  }

  // Build the system prompt: agent file + .claude/CLAUDE.md prepend
  // when the executor doesn't walk it natively (matches the parity
  // logic in {@link buildExecutorSubagentSpecs}).
  let systemPrompt = `You are a helper subagent named ${decl.name}.`
  if (decl.agent) {
    try {
      systemPrompt = readFileSync(
        path.join(phase.jobIntelligenceDir, decl.agent),
        'utf-8',
      )
    } catch {
      systemPrompt = `You are the ${decl.name} subagent. Follow your instructions carefully.`
    }
  }
  if (!subagentExecutor.capabilities.supportsClaudeMdNativeWalkUp) {
    try {
      const claudeMd = readFileSync(
        path.join(phase.jobIntelligenceDir, '.claude', 'CLAUDE.md'),
        'utf-8',
      )
      systemPrompt = claudeMd + '\n\n---\n\n' + systemPrompt
    } catch { /* CLAUDE.md missing — proceed without */ }
  }

  // Resolve model: subagent's own model/tier wins, falling through to
  // the executor's tier defaults via the same alias machinery as
  // regular phases. The alias's reasoning-effort hint travels with it so
  // per-tier `reasoningEffort` applies to subagents too (default tier
  // for an undeclared subagent is `mini`).
  const subagentAlias = resolveModelAlias(
    (decl.model || decl.tier) ? { model: decl.model, tier: decl.tier } : { tier: 'mini' },
    ctx.settings.llm?.aliases ?? {},
  )
  const model = subagentAlias.model
  const modelHints = subagentAlias.reasoningEffort
    ? { reasoningEffort: subagentAlias.reasoningEffort }
    : undefined

  // Tool whitelist: workflow declaration > parent phase whitelist >
  // safe defaults.
  const allowedTools: ReadonlyArray<string> =
    decl.tools && decl.tools.length > 0
      ? [...decl.tools]
      : phase.hookPolicy.allowedTools && phase.hookPolicy.allowedTools.length > 0
        ? phase.hookPolicy.allowedTools
        : [...DEFAULT_SUBAGENT_TOOLS]

  const concurrencyKey = `${ctx.job.id}:${phase.phaseConf.name}`
  const current = inFlight.get(concurrencyKey) ?? 0
  if (current >= MAX_CONCURRENT_PER_PHASE) {
    throw new Error(
      `run_subagent: per-phase concurrency cap (${MAX_CONCURRENT_PER_PHASE}) reached for ` +
      `${concurrencyKey}. Wait for in-flight subagents to finish before dispatching more.`,
    )
  }
  inFlight.set(concurrencyKey, current + 1)

  const abortController = new AbortController()
  const hookPolicy: HookPolicy = {
    ...phase.hookPolicy,
    allowedTools,
  }

  const req: SubagentExecutionRequest = {
    name: decl.name,
    systemPrompt,
    task: input.task,
    model,
    ...(modelHints ? { modelHints } : {}),
    cwd: phase.workingDir,
    intelligenceDir: phase.jobIntelligenceDir,
    mcpServer: phase.mcpServer,
    pluginMcpServers: phase.pluginMcpServers,
    allowedTools,
    hookPolicy,
    maxTurns: 16,
    signal: abortController.signal,
  }

  const startedAt = Date.now()
  try {
    const result = await subagentExecutor.runSubagent(req)

    const usageOut: RunSubagentResult['usage'] = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      ...(typeof result.usage.totalCostUsd === 'number'
        ? { totalCostUsd: result.usage.totalCostUsd }
        : {}),
    }

    const costNote = typeof usageOut.totalCostUsd === 'number'
      ? ` $${usageOut.totalCostUsd.toFixed(4)}`
      : ''
    await ctx.stateBackend.appendLog(
      ctx.job.id,
      `[run_subagent] ${decl.name} on ${subagentExecutor.manifest.id}/${model} ` +
      `→ ${usageOut.inputTokens} in / ${usageOut.outputTokens} out tokens${costNote} ` +
      `(${Date.now() - startedAt}ms, stop=${result.stopReason})`,
    )

    return {
      output: result.output,
      stopReason: result.stopReason,
      usage: usageOut,
    }
  } finally {
    const next = (inFlight.get(concurrencyKey) ?? 1) - 1
    if (next <= 0) inFlight.delete(concurrencyKey)
    else inFlight.set(concurrencyKey, next)
  }
}
