// ── Review lens runner ───────────────────────────────────────────────────────
//
// Runs one review lens through `executor.runSubagent`, on every provider.
// Output is a fenced JSON block validated here, with one repair turn. Shared
// by pull-request review and by the pre-PR code review in coding jobs.

import { readFileSync } from 'fs'
import path from 'path'
import { z } from 'zod'
import { toolMatchesAllowList, type HookPolicy, type SubagentExecutionRequest } from '@coro-ai/plugin-sdk'
import { resolveModelAlias } from '../jobs/phase-assignment'
import type { LensConfig } from '../workflow-parser'
import type { ReviewPolicy } from './policy'
import { withRunnerToolEquivalents } from '../tools/native-tool-equivalents'
import type { ToolContext } from '../tools/types'

const WRITE_VERB = /(?:^|_)(create|update|delete|write|post|merge|transition|comment)(?:_|$)/i

// Models cite `sourcesUsed` in the same `{kind, ref}` shape as a finding's
// `sources`, so both forms are accepted and stored as `kind:ref`.
const sourceCitation = z.union([
  z.string(),
  z.object({ kind: z.string().optional(), ref: z.string() })
    .transform(source => (source.kind ? `${source.kind}:${source.ref}` : source.ref)),
])

export const lensResultSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(['blocker', 'major', 'minor', 'nit']),
    category: z.enum(['correctness', 'security', 'tests', 'design', 'architecture', 'contract', 'performance', 'style', 'other']),
    path: z.string().optional(),
    line: z.number().int().optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    sources: z.array(z.object({
      kind: z.enum(['code', 'adr', 'catalog', 'doc', 'checker', 'memory']),
      ref: z.string(),
    })).optional(),
  })).default([]),
  notes: z.string().optional(),
  sourcesUsed: z.array(sourceCitation).default([]),
})

export type LensResult = z.infer<typeof lensResultSchema>

/** `@architecture` becomes the server ids configured for that role. */
export function resolveLensMcp(lens: LensConfig, policy: Pick<ReviewPolicy, 'mcpRoles'>): { serverIds: string[]; allowTools: string[]; denyTools: string[] } {
  const serverIds: string[] = []
  const allowTools: string[] = []
  const denyTools: string[] = []
  for (const entry of lens.mcpServers ?? []) {
    if (entry.startsWith('@')) {
      const role = policy.mcpRoles[entry.slice(1)]
      if (!role) continue
      serverIds.push(...role.servers)
      allowTools.push(...role.allowTools)
      denyTools.push(...role.denyTools)
    } else {
      serverIds.push(entry)
    }
  }
  return { serverIds: [...new Set(serverIds)], allowTools, denyTools }
}

/**
 * Lenses read. An allow glob such as `mcp__arch__*` cannot be narrowed
 * ahead of time, so plugin MCP tools are checked per call: an explicit
 * deny wins, and a write-shaped name is refused unless it is allowed by
 * its exact name.
 */
export function lensToolDecision(
  toolName: string,
  mcp: { allowTools: string[]; denyTools: string[] },
): { allow: boolean; reason?: string } {
  if (!toolName.startsWith('mcp__') || toolName.startsWith('mcp__coro__')) return { allow: true }
  if (toolMatchesAllowList(toolName, mcp.denyTools)) {
    return { allow: false, reason: `${toolName} is denied for review lenses.` }
  }
  if (toolNameLooksWritable(toolName) && !mcp.allowTools.includes(toolName)) {
    return { allow: false, reason: `${toolName} looks like a write. Review lenses only read; allow it by its exact name to override.` }
  }
  return { allow: true }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  const raw = fenced?.[1] ?? text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('lens output has no JSON object')
  return JSON.parse(raw.slice(start, end + 1))
}

export interface LensRunOptions {
  /** Working directory for the lens. Defaults to the phase's own. */
  cwd?: string
  /**
   * `skip` for untrusted pull requests: nothing from the code under review
   * is loaded as instructions. `load` for Coro's own branch.
   */
  projectContext?: 'skip' | 'load'
}

export type LensUsage = { inputTokens: number; outputTokens: number; costUsd: number }
export type LensRun = { name: string; result: LensResult; usage: LensUsage }
export type LensFailure = { name: string; error: string; usage: LensUsage }

/** A lens that ran but could not produce valid output; `usage` is what it spent. */
export class LensRunError extends Error {
  constructor(message: string, readonly usage: LensUsage) {
    super(message)
    this.name = 'LensRunError'
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runOneLens(
  ctx: ToolContext,
  lens: LensConfig,
  task: string,
  policy: Pick<ReviewPolicy, 'mcpRoles'>,
  options: LensRunOptions = {},
): Promise<LensRun> {
  const phase = ctx.currentPhase
  if (!phase) throw new Error('review lens: no active phase')
  const mcp = resolveLensMcp(lens, policy)
  const executor = lens.provider
    ? ctx.plugins.resolveExecutor({ provider: lens.provider })
    : phase.executor
  if (typeof executor.runSubagent !== 'function') {
    throw new Error(
      `review lens: executor "${executor.manifest.id}" has no runSubagent. ` +
      'Lenses cannot fall back to a provider-native Task tool.',
    )
  }
  let systemPrompt = `You are the ${lens.name} review lens. Return one fenced JSON object matching the lens schema. Do not post to the pull request.`
  if (lens.agent) {
    try {
      systemPrompt = readFileSync(path.join(phase.jobIntelligenceDir, lens.agent), 'utf-8')
    } catch { /* keep the short prompt */ }
  }
  const alias = resolveModelAlias(
    (lens.model || lens.tier) ? { model: lens.model, tier: lens.tier } : { tier: 'review-deep' },
    ctx.settings.llm?.aliases ?? {},
  )
  const allowed = withRunnerToolEquivalents(
    [...(lens.tools ?? ['Read', 'Grep', 'Glob']), ...mcp.allowTools],
    executor.capabilities,
  )
  const pluginMcpServers = Object.fromEntries(
    Object.entries(phase.pluginMcpServers).filter(([id]) => mcp.serverIds.includes(id)),
  )
  const inherited = phase.hookPolicy.onPreToolUse?.bind(phase.hookPolicy)
  const hookPolicy: HookPolicy = {
    ...phase.hookPolicy,
    allowedTools: allowed,
    onPreToolUse: async (toolName, input) => {
      const decision = lensToolDecision(toolName, mcp)
      if (!decision.allow) return decision
      return inherited ? inherited(toolName, input) : { allow: true }
    },
  }
  const req: SubagentExecutionRequest = {
    name: lens.name,
    systemPrompt,
    task,
    model: alias.model,
    ...(alias.reasoningEffort ? { modelHints: { reasoningEffort: alias.reasoningEffort } } : {}),
    cwd: options.cwd ?? phase.workingDir,
    intelligenceDir: phase.jobIntelligenceDir,
    mcpServer: phase.mcpServer,
    pluginMcpServers,
    allowedTools: allowed,
    hookPolicy,
    maxTurns: lens.maxTurns ?? 16,
    signal: phase.signal ?? new AbortController().signal,
    projectContext: options.projectContext ?? 'skip',
    mcpServerIds: mcp.serverIds,
  }
  const first = await executor.runSubagent(req)
  const usage = {
    inputTokens: first.usage.inputTokens,
    outputTokens: first.usage.outputTokens,
    costUsd: first.usage.totalCostUsd ?? 0,
  }
  let parsed: LensResult
  try {
    parsed = lensResultSchema.parse(extractJson(first.output))
  } catch (err) {
    const repair = await executor.runSubagent({
      ...req,
      task: `${task}\n\nYour previous output failed validation: ${messageOf(err)}. Reply with only a fenced JSON object.`,
    }).catch(repairErr => {
      throw new LensRunError(`${lens.name} lens repair turn failed: ${messageOf(repairErr)}`, usage)
    })
    usage.inputTokens += repair.usage.inputTokens
    usage.outputTokens += repair.usage.outputTokens
    usage.costUsd += repair.usage.totalCostUsd ?? 0
    try {
      parsed = lensResultSchema.parse(extractJson(repair.output))
    } catch (repairErr) {
      throw new LensRunError(`${lens.name} lens output failed validation twice: ${messageOf(repairErr)}`, usage)
    }
  }
  if (lens.name === 'architecture') {
    parsed = {
      ...parsed,
      findings: parsed.findings.filter(finding => (finding.sources?.length ?? 0) > 0),
    }
  }
  return { name: lens.name, result: parsed, usage }
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      out[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

/**
 * Runs lenses in parallel. A lens that fails comes back in `failed` with
 * what it spent, so one bad lens neither discards the others' results nor
 * hides their cost. An aborted phase still throws.
 */
export async function runLenses<T>(
  items: T[],
  limit: number,
  nameOf: (item: T) => string,
  run: (item: T) => Promise<LensRun>,
  signal?: AbortSignal,
): Promise<{ runs: LensRun[]; failed: LensFailure[]; spend: LensUsage }> {
  const settled = await mapPool(items, limit, async (item): Promise<LensRun | LensFailure> => {
    try {
      return await run(item)
    } catch (err) {
      if (signal?.aborted) throw err
      const usage = err instanceof LensRunError ? err.usage : { inputTokens: 0, outputTokens: 0, costUsd: 0 }
      return { name: nameOf(item), error: messageOf(err), usage }
    }
  })
  const runs = settled.filter((item): item is LensRun => 'result' in item)
  const failed = settled.filter((item): item is LensFailure => 'error' in item)
  const spend = settled.reduce(
    (sum, item) => ({
      inputTokens: sum.inputTokens + item.usage.inputTokens,
      outputTokens: sum.outputTokens + item.usage.outputTokens,
      costUsd: sum.costUsd + item.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  )
  return { runs, failed, spend }
}

export function toolNameLooksWritable(name: string): boolean {
  return WRITE_VERB.test(name)
}
