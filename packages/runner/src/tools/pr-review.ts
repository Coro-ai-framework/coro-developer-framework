// ── PR review MCP tools ──────────────────────────────────────────────────────
//
// Type-gated to `pr-review` jobs. Lenses run through `executor.runSubagent`
// on every provider. Output is a fenced JSON block validated here, with one
// repair turn. The lead never depends on a provider's native Task tool.

import { readFileSync } from 'fs'
import path from 'path'
import { z } from 'zod'
import type { HookPolicy, SubagentExecutionRequest } from '@coro-ai/plugin-sdk'
import {
  reviewMarker,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
  type PrReview,
  type ReviewVerdict,
} from '@coro-ai/cloud-protocol'
import { isPrReviewJob } from '../jobs/helpers'
import { resolveModelAlias } from '../jobs/phase-assignment'
import type { LensConfig } from '../workflow-parser'
import type { ScmPluginRuntime } from '../plugins/types'
import { findingFingerprint, findingId } from '../reviews/id'
import { effectiveSubmission, severityAtLeast, type ReviewPolicy } from '../reviews/policy'
import { withRunnerToolEquivalents } from './native-tool-equivalents'
import type { ToolContext } from './types'

const WRITE_VERB = /(?:^|_)(create|update|delete|write|post|merge|transition|comment)(?:_|$)/i

const lensResultSchema = z.object({
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
  sourcesUsed: z.array(z.string()).default([]),
})

export type LensResult = z.infer<typeof lensResultSchema>

function assertReviewJob(ctx: ToolContext): void {
  if (!isPrReviewJob(ctx.job)) {
    throw new Error('review tools are only available on a pr-review job')
  }
}

function policyOf(ctx: ToolContext): ReviewPolicy {
  const raw = ctx.job.params['reviewPolicy']
  if (raw && typeof raw === 'object') return raw as ReviewPolicy
  if (!ctx.settings.reviews) throw new Error('review policy is not configured')
  return ctx.settings.reviews
}

async function loadReview(ctx: ToolContext): Promise<PrReview> {
  const id = ctx.job.params['reviewId']
  if (typeof id !== 'string') throw new Error('review job is missing reviewId')
  const review = await ctx.stateBackend.reviews.get(id)
  if (!review) throw new Error(`review ${id} not found`)
  return review
}

function scmFor(ctx: ToolContext, pluginId: string): ScmPluginRuntime {
  const runtime = ctx.plugins.byId(pluginId)
  if (!runtime || !('submitReview' in runtime)) {
    throw new Error(`SCM plugin "${pluginId}" does not implement review submission`)
  }
  return runtime as ScmPluginRuntime
}

/** `@architecture` becomes the server ids configured for that role. */
export function resolveLensMcp(lens: LensConfig, policy: ReviewPolicy): { serverIds: string[]; allowTools: string[] } {
  const serverIds: string[] = []
  const allowTools: string[] = []
  for (const entry of lens.mcpServers ?? []) {
    if (entry.startsWith('@')) {
      const role = policy.mcpRoles[entry.slice(1)]
      if (!role) continue
      serverIds.push(...role.servers)
      allowTools.push(...role.allowTools)
    } else {
      serverIds.push(entry)
    }
  }
  return { serverIds: [...new Set(serverIds)], allowTools }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  const raw = fenced?.[1] ?? text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('lens output has no JSON object')
  return JSON.parse(raw.slice(start, end + 1))
}

async function runOneLens(
  ctx: ToolContext,
  lens: LensConfig,
  task: string,
  policy: ReviewPolicy,
): Promise<{ name: string; result: LensResult; usage: { inputTokens: number; outputTokens: number; costUsd: number } }> {
  const phase = ctx.currentPhase
  if (!phase) throw new Error('review_run_lenses: no active phase')
  const mcp = resolveLensMcp(lens, policy)
  const executor = lens.provider
    ? ctx.plugins.resolveExecutor({ provider: lens.provider })
    : phase.executor
  if (typeof executor.runSubagent !== 'function') {
    throw new Error(
      `review_run_lenses: executor "${executor.manifest.id}" has no runSubagent. ` +
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
  const hookPolicy: HookPolicy = { ...phase.hookPolicy, allowedTools: allowed }
  const req: SubagentExecutionRequest = {
    name: lens.name,
    systemPrompt,
    task,
    model: alias.model,
    ...(alias.reasoningEffort ? { modelHints: { reasoningEffort: alias.reasoningEffort } } : {}),
    cwd: phase.workingDir,
    intelligenceDir: phase.jobIntelligenceDir,
    mcpServer: phase.mcpServer,
    pluginMcpServers,
    allowedTools: allowed,
    hookPolicy,
    maxTurns: lens.maxTurns ?? 16,
    signal: new AbortController().signal,
    projectContext: 'skip',
    mcpServerIds: mcp.serverIds,
  }
  const first = await executor.runSubagent(req)
  let parsed: LensResult
  try {
    parsed = lensResultSchema.parse(extractJson(first.output))
  } catch (err) {
    const repair = await executor.runSubagent({
      ...req,
      task: `${task}\n\nYour previous output failed validation: ${err instanceof Error ? err.message : String(err)}. Reply with only a fenced JSON object.`,
    })
    parsed = lensResultSchema.parse(extractJson(repair.output))
  }
  if (lens.name === 'architecture') {
    parsed = {
      ...parsed,
      findings: parsed.findings.filter(finding => (finding.sources?.length ?? 0) > 0),
    }
  }
  const cost = first.usage.totalCostUsd ?? 0
  return {
    name: lens.name,
    result: parsed,
    usage: { inputTokens: first.usage.inputTokens, outputTokens: first.usage.outputTokens, costUsd: cost },
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export async function reviewRunLenses(
  ctx: ToolContext,
  args: { lenses: string[]; scope?: { paths?: string[]; chunk?: number }; candidates?: unknown[] },
): Promise<{ lenses: Awaited<ReturnType<typeof runOneLens>>[] }> {
  assertReviewJob(ctx)
  const phase = ctx.currentPhase
  if (!phase) throw new Error('review_run_lenses: no active phase')
  const declared = phase.phaseConf.lenses ?? []
  const policy = policyOf(ctx)
  const wanted = args.lenses.filter(name => {
    if (policy.lenses.length > 0 && !policy.lenses.includes(name) && name !== 'verifier') return false
    return declared.some(lens => lens.name === name)
  })
  const unknown = args.lenses.filter(name => !declared.some(lens => lens.name === name))
  if (unknown.length > 0) {
    throw new Error(`review_run_lenses: undeclared lenses: ${unknown.join(', ')}`)
  }
  const selected = declared.filter(lens => wanted.includes(lens.name))
  const task = [
    'Review only the files in your slice. Cite path and line.',
    `Severity floor: ${policy.minSeverity}. Do not emit findings below it.`,
    args.scope?.paths?.length ? `Paths: ${args.scope.paths.join(', ')}` : '',
    args.candidates ? `Candidates to verify:\n${JSON.stringify(args.candidates)}` : '',
    'Reply with a fenced JSON object: {"findings":[{"severity","category","path","line","title","body","sources":[{"kind","ref"}]}],"notes","sourcesUsed":[]}.',
  ].filter(Boolean).join('\n')
  const lenses = await mapPool(selected, policy.maxParallelLenses, lens => runOneLens(ctx, lens, task, policy))
  const review = await loadReview(ctx).catch(() => null)
  if (review) {
    const round = [...review.rounds].reverse().find(item => item.jobId === ctx.job.id)
    if (round) {
      round.lensCosts = {
        ...(round.lensCosts ?? {}),
        ...Object.fromEntries(lenses.map(lens => [lens.name, {
          costUsd: lens.usage.costUsd,
          inputTokens: lens.usage.inputTokens,
          outputTokens: lens.usage.outputTokens,
          findings: lens.result.findings.length,
        }])),
      }
      await ctx.stateBackend.reviews.save(review)
    }
  }
  return { lenses }
}

export async function reviewGetContext(
  ctx: ToolContext,
  args: { section?: 'overview' | 'packet' | 'ledger' | 'threads' | 'history' },
): Promise<unknown> {
  assertReviewJob(ctx)
  const review = await loadReview(ctx)
  const section = args.section ?? 'overview'
  if (section === 'ledger') return review.ledger
  if (section === 'history') return review.rounds.slice(-8)
  if (section === 'threads') {
    const scm = scmFor(ctx, review.prRef.pluginId)
    if (!scm.listReviewThreads) return []
    return scm.listReviewThreads(review.prRef)
  }
  return {
    reviewId: review.id,
    pr: review.pr,
    status: review.status,
    policy: policyOf(ctx),
    openFindings: review.ledger.findings.filter(finding => finding.status === 'open'),
    architectureBrief: review.architectureBrief ?? null,
    rounds: review.rounds.slice(-3),
    packet: ctx.job.params['reviewPacket'] ?? null,
  }
}

const commentSchema = z.object({
  findingId: z.string().optional(),
  path: z.string(),
  line: z.number().int(),
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  category: z.enum(['correctness', 'security', 'tests', 'design', 'architecture', 'contract', 'performance', 'style', 'other']),
  title: z.string(),
  body: z.string(),
})

export async function reviewSubmit(
  ctx: ToolContext,
  args: { verdict: ReviewVerdict; body: string; comments: z.infer<typeof commentSchema>[] },
): Promise<unknown> {
  assertReviewJob(ctx)
  const policy = policyOf(ctx)
  const review = await loadReview(ctx)
  const comments = args.comments
    .filter(comment => severityAtLeast(comment.severity, policy.minSeverity))
    .filter(comment => {
      const fp = findingFingerprint(comment.path, comment.title, comment.category)
      return !review.ledger.findings.some(existing =>
        existing.fingerprint === fp && (existing.status === 'open' || existing.status === 'declined'))
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, policy.maxCommentsPerRound)

  const submission = effectiveSubmission(policy, args.verdict)
  const marker = reviewMarker(review.id)
  const body = `${args.body}\n\n${marker}`
  const scm = scmFor(ctx, review.prRef.pluginId)
  if (!scm.submitReview) throw new Error('SCM plugin cannot submit a review')

  let pendingReviewId: string | undefined
  if (submission.event === 'pending') {
    const pending = await scm.submitReview(review.prRef, {
      event: 'pending',
      body,
      comments: comments.map(toScmComment),
    })
    pendingReviewId = pending.reviewId
  } else {
    await scm.submitReview(review.prRef, {
      event: submission.event,
      body,
      comments: comments.map(toScmComment),
    })
  }

  const round = review.totals.rounds
  for (const comment of comments) {
    const fingerprint = findingFingerprint(comment.path, comment.title, comment.category)
    const existing = review.ledger.findings.find(finding => finding.fingerprint === fingerprint)
    if (existing) {
      existing.status = 'open'
      existing.lastTouchedRound = round
      existing.body = comment.body
    } else {
      const finding: Finding = {
        id: comment.findingId ?? findingId(),
        fingerprint,
        severity: comment.severity,
        category: comment.category as FindingCategory,
        lens: 'lead',
        path: comment.path,
        line: comment.line,
        side: comment.side,
        title: comment.title,
        body: comment.body,
        status: 'open',
        raisedInRound: round,
        lastTouchedRound: round,
      }
      review.ledger.findings.push(finding)
    }
  }
  if (submission.holdVerdict) {
    review.pendingVerdict = {
      verdict: args.verdict,
      body: args.body,
      ...(pendingReviewId ? { pendingReviewId } : {}),
      heldAt: new Date().toISOString(),
    }
    review.status = 'awaiting-verdict'
  } else {
    review.pendingVerdict = undefined
  }
  review.updatedAt = new Date().toISOString()
  await ctx.stateBackend.reviews.save(review)
  return { posted: submission.event, held: submission.holdVerdict, comments: comments.length }
}

function toScmComment(comment: z.infer<typeof commentSchema>) {
  return {
    key: `${comment.path}:${comment.line}`,
    path: comment.path,
    line: comment.line,
    side: comment.side ?? 'RIGHT' as const,
    body: `**${comment.severity}** ${comment.title}\n\n${comment.body}`,
  }
}

function severityRank(severity: FindingSeverity): number {
  return { nit: 0, minor: 1, major: 2, blocker: 3 }[severity]
}

export async function reviewReply(
  ctx: ToolContext,
  args: { threadId?: string; commentId?: string; body: string; findingStatus?: Finding['status'] },
): Promise<unknown> {
  assertReviewJob(ctx)
  const review = await loadReview(ctx)
  const scm = scmFor(ctx, review.prRef.pluginId) as ScmPluginRuntime & {
    postPrComment?: (ref: PrReview['prRef'], body: string) => Promise<unknown>
    replyToComment?: (ref: PrReview['prRef'], parentId: string, body: string) => Promise<unknown>
  }
  const body = `${args.body}\n\n${reviewMarker(review.id)}`
  if (args.threadId && scm.replyToComment) {
    await scm.replyToComment(review.prRef, args.threadId, body)
  } else if (scm.postPrComment) {
    await scm.postPrComment(review.prRef, body)
  } else {
    throw new Error('SCM plugin cannot post comments')
  }
  if (args.findingStatus) {
    const finding = review.ledger.findings.find(item => item.threadId === args.threadId || item.commentId === args.commentId)
    if (finding) finding.status = args.findingStatus
    await ctx.stateBackend.reviews.save(review)
  }
  return { ok: true }
}

export async function reviewResolveThread(
  ctx: ToolContext,
  args: { findingId: string; resolved: boolean },
): Promise<unknown> {
  assertReviewJob(ctx)
  const review = await loadReview(ctx)
  const finding = review.ledger.findings.find(item => item.id === args.findingId)
  if (!finding?.threadId) throw new Error('finding has no Coro thread')
  const scm = scmFor(ctx, review.prRef.pluginId)
  if (!scm.resolveThread) throw new Error('SCM plugin cannot resolve threads')
  await scm.resolveThread(review.prRef, finding.threadId, args.resolved)
  finding.status = args.resolved ? 'addressed' : finding.status
  finding.lastTouchedRound = review.totals.rounds
  await ctx.stateBackend.reviews.save(review)
  return { ok: true }
}

export async function reviewUpdateFindings(
  ctx: ToolContext,
  args: { updates: { findingId: string; status: Finding['status']; note?: string }[] },
): Promise<unknown> {
  assertReviewJob(ctx)
  const review = await loadReview(ctx)
  for (const update of args.updates) {
    const finding = review.ledger.findings.find(item => item.id === update.findingId)
    if (!finding) continue
    finding.status = update.status
    finding.lastTouchedRound = review.totals.rounds
    if (update.note) finding.body = `${finding.body ?? ''}\n\n${update.note}`.trim()
  }
  await ctx.stateBackend.reviews.save(review)
  return { updated: args.updates.length }
}

export async function reviewFinish(
  ctx: ToolContext,
  args: { outcome: 'submitted' | 'replied' | 'no-op' | 'held-for-verdict' | 'failed'; summary: string; nextHint?: string },
): Promise<unknown> {
  assertReviewJob(ctx)
  const review = await loadReview(ctx)
  const round = [...review.rounds].reverse().find(item => item.jobId === ctx.job.id)
    ?? review.rounds[review.rounds.length - 1]
  if (round) {
    round.outcome = args.outcome
    round.summary = args.summary
    round.jobId = ctx.job.id
    if (args.outcome === 'held-for-verdict') review.status = 'awaiting-verdict'
  }
  const head = ctx.job.params['headSha']
  if (typeof head === 'string' && head) review.ledger.lastReviewedSha = head
  review.updatedAt = new Date().toISOString()
  await ctx.stateBackend.reviews.save(review)
  return { ok: true, nextHint: args.nextHint ?? null }
}

export function toolNameLooksWritable(name: string): boolean {
  return WRITE_VERB.test(name)
}
