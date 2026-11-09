// ── PR review MCP tools ──────────────────────────────────────────────────────
//
// Type-gated to `pr-review` jobs. Lenses run through `executor.runSubagent`
// on every provider. Output is a fenced JSON block validated here, with one
// repair turn. The lead never depends on a provider's native Task tool.

import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import {
  reviewMarker,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
  type PrReview,
  type ReviewVerdict,
} from '@coro-ai/cloud-protocol'
import { isPrReviewJob } from '../jobs/helpers'
import type { ScmPluginRuntime } from '../plugins/types'
import { findingFingerprint, findingId } from '../reviews/id'
import { classifyPath } from '../reviews/packet'
import { effectiveSubmission, severityAtLeast, type ReviewPolicy } from '../reviews/policy'
import { runLenses, runOneLens, type LensRun } from '../reviews/lens-runner'
import type { PhaseSignals, ToolContext } from './types'

export { lensToolDecision, resolveLensMcp, toolNameLooksWritable, type LensResult } from '../reviews/lens-runner'


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

/**
 * Re-read, change, and save with no await in between, so events the
 * coordinator recorded while this tool was talking to the SCM survive.
 */
async function mutateReview(ctx: ToolContext, change: (review: PrReview) => void): Promise<PrReview> {
  const review = await loadReview(ctx)
  change(review)
  review.updatedAt = new Date().toISOString()
  await ctx.stateBackend.reviews.save(review)
  return review
}

const MAX_HEAD_FILES = 80
const MAX_HEAD_FILE_BYTES = 400_000

interface MaterialisedPr {
  diff: string
  headDir: string
  files: number
  headFiles: number
  skipped: string[]
  guidance?: string
}

/**
 * Writes the diff and the changed files at head under `<job cwd>/pr/`,
 * read through the SCM API. Nothing is cloned and nothing from head is
 * executed or loaded as instructions. Runs once per round; lenses share it.
 */
async function materialisePr(ctx: ToolContext, review: PrReview): Promise<MaterialisedPr> {
  const phase = ctx.currentPhase
  if (!phase) throw new Error('review tools need an active phase')
  const root = path.join(phase.workingDir, 'pr')
  const marker = path.join(root, '.ready.json')
  try {
    return JSON.parse(await readFile(marker, 'utf8')) as MaterialisedPr
  } catch { /* first call this round */ }

  const scm = scmFor(ctx, review.prRef.pluginId)
  if (!scm.getPrDiff) throw new Error(`The ${review.prRef.pluginId} plugin cannot read pull request diffs`)
  const diff = await scm.getPrDiff(review.prRef)
  const headDir = path.join(root, 'head')
  await mkdir(headDir, { recursive: true })

  const patch = diff.files.map(file => [
    `diff --git a/${file.path} b/${file.path}`,
    `--- ${file.status === 'added' ? '/dev/null' : `a/${file.path}`}`,
    `+++ ${file.status === 'removed' ? '/dev/null' : `b/${file.path}`}`,
    file.patch ?? '(binary or too large for the SCM to return a patch)',
  ].join('\n')).join('\n')
  await writeFile(path.join(root, 'diff.patch'), `${patch}\n`, 'utf8')

  const headSha = typeof ctx.job.params['headSha'] === 'string' ? ctx.job.params['headSha'] : review.pr.headSha
  const skipped: string[] = []
  let headFiles = 0
  if (scm.readFile && review.prRef.repoKey) {
    for (const file of diff.files) {
      if (file.status === 'removed') continue
      const classes = classifyPath(file.path)
      if (classes.some(cls => cls === 'lockfile' || cls === 'generated' || cls === 'vendored')) continue
      const dest = path.resolve(headDir, file.path)
      if (!dest.startsWith(`${headDir}${path.sep}`)) {
        skipped.push(file.path)
        continue
      }
      if (headFiles >= MAX_HEAD_FILES) {
        skipped.push(file.path)
        continue
      }
      try {
        const content = await scm.readFile({ repo: review.prRef.repoKey, path: file.path, ref: headSha })
        const bytes = content.encoding === 'base64' ? Buffer.from(content.content, 'base64') : Buffer.from(content.content, 'utf8')
        if (bytes.length > MAX_HEAD_FILE_BYTES) {
          skipped.push(file.path)
          continue
        }
        await mkdir(path.dirname(dest), { recursive: true })
        await writeFile(dest, bytes)
        headFiles += 1
      } catch {
        skipped.push(file.path)
      }
    }
  }

  const guidance = typeof ctx.job.params['repoGuidance'] === 'string' ? ctx.job.params['repoGuidance'] : undefined
  if (guidance) await writeFile(path.join(root, 'review-guidance.md'), guidance, 'utf8')

  const result: MaterialisedPr = {
    diff: 'pr/diff.patch',
    headDir: 'pr/head',
    files: diff.files.length,
    headFiles,
    skipped,
    ...(guidance ? { guidance: 'pr/review-guidance.md' } : {}),
  }
  await writeFile(marker, JSON.stringify(result), 'utf8')
  return result
}

function scmFor(ctx: ToolContext, pluginId: string): ScmPluginRuntime {
  const runtime = ctx.plugins.byId(pluginId)
  if (!runtime || !('submitReview' in runtime)) {
    throw new Error(`SCM plugin "${pluginId}" does not implement review submission`)
  }
  return runtime as ScmPluginRuntime
}

export async function reviewRunLenses(
  ctx: ToolContext,
  args: { lenses: string[]; scope?: { paths?: string[]; chunk?: number }; candidates?: unknown[] },
): Promise<{ lenses: LensRun[]; failed?: { name: string; error: string }[] }> {
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
  const workspace = await materialisePr(ctx, await loadReview(ctx))
  const task = [
    `The unified diff is at ${workspace.diff}. Changed files at the pull request head are under ${workspace.headDir}/. Read them; do not run anything from them.`,
    'Review only the files in your slice. Cite path and line from the head version.',
    `Severity floor: ${policy.minSeverity}. Do not emit findings below it.`,
    args.scope?.paths?.length ? `Paths: ${args.scope.paths.join(', ')}` : '',
    args.candidates ? `Candidates to verify:\n${JSON.stringify(args.candidates)}` : '',
    'Reply with a fenced JSON object: {"findings":[{"severity","category","path","line","title","body","sources":[{"kind","ref"}]}],"notes","sourcesUsed":["kind:ref"]}.',
  ].filter(Boolean).join('\n')
  const { runs: lenses, failed, spend } = await runLenses(
    selected,
    policy.maxParallelLenses,
    lens => lens.name,
    lens => runOneLens(ctx, lens, task, policy),
    phase.signal,
  )
  phase.recordUsage?.(spend)
  const spentBy = [
    ...lenses.map(lens => ({ name: lens.name, usage: lens.usage, findings: lens.result.findings.length })),
    ...failed.map(lens => ({ name: lens.name, usage: lens.usage, findings: 0 })),
  ]
  await mutateReview(ctx, review => {
    const round = [...review.rounds].reverse().find(item => item.jobId === ctx.job.id)
    if (!round) return
    // A lens can run twice in one round (candidates, then the verifier); costs add up.
    const costs = { ...(round.lensCosts ?? {}) }
    for (const lens of spentBy) {
      const prior = costs[lens.name]
      costs[lens.name] = {
        costUsd: (prior?.costUsd ?? 0) + lens.usage.costUsd,
        inputTokens: (prior?.inputTokens ?? 0) + lens.usage.inputTokens,
        outputTokens: (prior?.outputTokens ?? 0) + lens.usage.outputTokens,
        findings: (prior?.findings ?? 0) + lens.findings,
      }
    }
    round.lensCosts = costs
  }).catch(() => undefined)
  return {
    lenses,
    ...(failed.length > 0 ? { failed: failed.map(({ name, error }) => ({ name, error })) } : {}),
  }
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
  const packet = ctx.job.params['reviewPacket'] ?? null
  if (section === 'packet') return packet
  const workspace = await materialisePr(ctx, review)
  return {
    reviewId: review.id,
    roundKind: ctx.job.params['roundKind'] ?? null,
    pr: review.pr,
    status: review.status,
    policy: policyOf(ctx),
    workspace,
    openFindings: review.ledger.findings.filter(finding => finding.status === 'open'),
    architectureBrief: review.architectureBrief ?? null,
    rounds: review.rounds.slice(-3),
    packet,
  }
}

/** Read one file of this pull request's repository at its head or base commit. */
export async function reviewReadFile(
  ctx: ToolContext,
  args: { path: string; at?: 'head' | 'base' },
): Promise<{ path: string; at: 'head' | 'base'; sha: string; content: string; truncated: boolean }> {
  assertReviewJob(ctx)
  const review = await loadReview(ctx)
  const scm = scmFor(ctx, review.prRef.pluginId)
  if (!scm.readFile || !review.prRef.repoKey) throw new Error('This SCM plugin cannot read repository files')
  const at = args.at ?? 'head'
  const param = ctx.job.params[at === 'head' ? 'headSha' : 'baseSha']
  const sha = typeof param === 'string' && param ? param : at === 'head' ? review.pr.headSha : review.pr.baseSha
  if (!sha) throw new Error(`The ${at} commit of this pull request is not known yet`)
  const file = await scm.readFile({ repo: review.prRef.repoKey, path: args.path.replace(/^\/+/, ''), ref: sha })
  const text = file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content
  const limit = 120_000
  return { path: args.path, at, sha, content: text.slice(0, limit), truncated: file.truncated === true || text.length > limit }
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

export const REVIEW_DRAFT_KIND = 'review-draft'

type DraftComment = z.infer<typeof commentSchema>
type FinishArgs = { outcome: 'submitted' | 'replied' | 'no-op' | 'held-for-verdict' | 'failed'; summary: string; nextHint?: string }

/**
 * What a gated review phase intends to do to the pull request. It is a job
 * artefact so the checkpoint shows it for approval; the publish phase is
 * the only thing that turns it into SCM writes.
 */
export interface ReviewDraft {
  status: 'draft' | 'published'
  verdict: ReviewVerdict
  body: string
  comments: DraftComment[]
  headSha?: string
  resolve: { findingId: string; resolved: boolean }[]
  finish?: FinishArgs
  /** Set once the review itself is on the SCM, so a retried publish does not post twice. */
  postedAt?: string
  publishedAt?: string
}

/** A phase with a checkpoint writes nothing to the pull request; it drafts. */
function defersWrites(ctx: ToolContext): boolean {
  return ctx.currentPhase?.phaseConf.interactiveCheckpoint === true
}

function headShaOf(ctx: ToolContext): string | undefined {
  const head = ctx.job.params['headSha']
  return typeof head === 'string' && head ? head : undefined
}

function draftIsEmpty(draft: ReviewDraft): boolean {
  return !draft.body.trim() && draft.comments.length === 0 && draft.resolve.length === 0
}

function postable(draft: ReviewDraft): string {
  return JSON.stringify([draft.verdict, draft.body, draft.comments, draft.resolve])
}

function draftTitle(draft: ReviewDraft): string {
  const verdict = { approve: 'Approve', request_changes: 'Request changes', comment: 'Comment' }[draft.verdict]
  const count = draft.comments.length
  return `Review to post: ${verdict} · ${count} inline comment${count === 1 ? '' : 's'}`
}

async function loadDraft(ctx: ToolContext): Promise<ReviewDraft | undefined> {
  const job = await ctx.stateBackend.getJob(ctx.job.id)
  const artifact = job?.artifacts?.find(item => item.kind === REVIEW_DRAFT_KIND)
  return artifact ? artifact.data as unknown as ReviewDraft : undefined
}

/**
 * One draft per round: revisions replace it in place, so the checkpoint
 * never shows two. With `signals`, the write also decides the checkpoint:
 * an empty finished draft skips it (approving nothing is noise), and any
 * change to what will be posted, including the first draft, withdraws an
 * approval already given.
 */
async function saveDraft(
  ctx: ToolContext,
  change: (draft: ReviewDraft) => void,
  signals?: PhaseSignals,
): Promise<ReviewDraft> {
  const job = await ctx.stateBackend.getJob(ctx.job.id)
  if (!job) throw new Error('review job not found')
  const artifacts = [...(job.artifacts ?? [])]
  const index = artifacts.findIndex(item => item.kind === REVIEW_DRAFT_KIND)
  const existing = index >= 0 ? artifacts[index] : undefined
  const draft: ReviewDraft = existing
    ? structuredClone(existing.data as unknown as ReviewDraft)
    : { status: 'draft', verdict: 'comment', body: '', comments: [], resolve: [], ...(headShaOf(ctx) ? { headSha: headShaOf(ctx) } : {}) }
  const before = postable(draft)
  change(draft)
  if (signals) {
    signals.checkpointWaived = draft.finish && draftIsEmpty(draft) ? 'Nothing to post on the pull request' : undefined
    if (postable(draft) !== before) signals.checkpointReopened = 'The review draft changed, so it needs approving again'
  }
  const now = new Date()
  const artifact = {
    id: existing?.id ?? `art-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    phase: existing?.phase ?? job.phase,
    kind: REVIEW_DRAFT_KIND,
    title: draftTitle(draft),
    data: draft as unknown as Record<string, unknown>,
    createdBy: existing?.createdBy ?? job.phase,
    createdAt: existing?.createdAt ?? now.toISOString(),
    ...(existing ? { editedAt: now.toISOString(), editedBy: job.phase } : {}),
  }
  if (index >= 0) artifacts[index] = artifact
  else artifacts.push(artifact)
  await ctx.stateBackend.updateJob(ctx.job.id, { artifacts })
  const refreshed = await ctx.stateBackend.getJob(ctx.job.id)
  if (refreshed) ctx.job = refreshed
  return draft
}

export async function reviewSubmit(
  ctx: ToolContext,
  args: { verdict: ReviewVerdict; body: string; comments: DraftComment[] },
  signals?: PhaseSignals,
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

  const proposed = { verdict: args.verdict, body: args.body, comments, headSha: headShaOf(ctx) }
  if (!defersWrites(ctx)) return postReview(ctx, review, proposed)

  await saveDraft(ctx, current => {
    current.verdict = proposed.verdict
    current.body = proposed.body
    current.comments = proposed.comments
    if (proposed.headSha) current.headSha = proposed.headSha
  }, signals)
  return {
    drafted: true,
    posted: 'nothing',
    comments: comments.length,
    dropped: args.comments.length - comments.length,
    next: ctx.job.interactive
      ? 'The developer reviews this draft before anything is posted. Calling review_submit again replaces it.'
      : 'The publish phase posts this draft. Calling review_submit again replaces it.',
  }
}

/**
 * Posts a review and records its findings. The single place Coro's review
 * reaches the SCM, whether it comes straight from the lead or from the
 * approved draft in the publish phase.
 */
async function postReview(
  ctx: ToolContext,
  review: PrReview,
  draft: Pick<ReviewDraft, 'verdict' | 'body' | 'comments' | 'headSha'>,
): Promise<{ posted: string; held: boolean; comments: number }> {
  const policy = policyOf(ctx)
  const submission = effectiveSubmission(policy, draft.verdict)
  const marker = reviewMarker(review.id)
  const body = `${draft.body}\n\n${marker}`
  const scm = scmFor(ctx, review.prRef.pluginId)
  if (!scm.submitReview) throw new Error('SCM plugin cannot submit a review')
  const headSha = draft.headSha
  const comments = draft.comments

  // Only providers with real draft reviews may receive a `pending` review;
  // the others would post it publicly. Coro holds it instead.
  const holdLocally = submission.event === 'pending' && typeof scm.submitPendingReview !== 'function'
  const result = holdLocally
    ? { reviewId: '', commentIds: {} as Record<string, string> }
    : await scm.submitReview(review.prRef, {
        event: submission.event,
        body,
        ...(headSha ? { commitSha: headSha } : {}),
        comments: comments.map(toScmComment),
      })
  const pendingReviewId = submission.event === 'pending' && !holdLocally ? result.reviewId : undefined

  await mutateReview(ctx, fresh => {
    const round = fresh.totals.rounds
    for (const comment of comments) {
      const fingerprint = findingFingerprint(comment.path, comment.title, comment.category)
      const commentId = result.commentIds[toScmComment(comment).key]
      const existing = fresh.ledger.findings.find(finding => finding.fingerprint === fingerprint)
      if (existing) {
        existing.status = 'open'
        existing.lastTouchedRound = round
        existing.body = comment.body
        if (commentId) existing.commentId = commentId
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
          ...(commentId ? { commentId } : {}),
        }
        fresh.ledger.findings.push(finding)
      }
    }
    if (submission.holdVerdict || holdLocally) {
      fresh.pendingVerdict = {
        verdict: draft.verdict,
        body: draft.body,
        ...(pendingReviewId ? { pendingReviewId } : {}),
        ...(holdLocally && comments.length ? { heldComments: comments.map(toScmComment) } : {}),
        heldAt: new Date().toISOString(),
      }
    } else {
      fresh.pendingVerdict = undefined
    }
  })
  return {
    posted: holdLocally ? 'nothing' : submission.event,
    held: submission.holdVerdict || holdLocally,
    comments: comments.length,
  }
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
  const matches = (item: Finding) =>
    (!!args.threadId && item.threadId === args.threadId) || (!!args.commentId && item.commentId === args.commentId)
  const finding = review.ledger.findings.find(matches)
  // Replies attach to a comment. GitHub thread ids are GraphQL node ids, not comment ids.
  const parent = args.commentId ?? finding?.commentId ?? args.threadId
  let inThread = false
  if (parent && scm.replyToComment) {
    try {
      await scm.replyToComment(review.prRef, parent, body)
      inThread = true
    } catch (err) {
      if (!scm.postPrComment) throw err
      ctx.logger.warn({ err, parent }, 'review_reply could not reply in thread; posting a top-level comment')
    }
  }
  if (!inThread) {
    if (!scm.postPrComment) throw new Error('SCM plugin cannot post comments')
    await scm.postPrComment(review.prRef, body)
  }
  const status = args.findingStatus
  if (status) {
    await mutateReview(ctx, fresh => {
      const target = fresh.ledger.findings.find(matches)
      if (target) target.status = status
    })
  }
  return { ok: true, inThread }
}

export async function reviewResolveThread(
  ctx: ToolContext,
  args: { findingId: string; resolved: boolean },
  signals?: PhaseSignals,
): Promise<unknown> {
  assertReviewJob(ctx)
  const review = await loadReview(ctx)
  const finding = review.ledger.findings.find(item => item.id === args.findingId)
  if (!finding?.threadId) throw new Error('finding has no Coro thread')
  if (defersWrites(ctx)) {
    await saveDraft(ctx, current => {
      current.resolve = [...current.resolve.filter(item => item.findingId !== args.findingId), args]
    }, signals)
    return { queued: true, next: 'Resolved when the draft is published.' }
  }
  await resolveThreadNow(ctx, args)
  return { ok: true }
}

async function resolveThreadNow(ctx: ToolContext, args: { findingId: string; resolved: boolean }): Promise<void> {
  const review = await loadReview(ctx)
  const finding = review.ledger.findings.find(item => item.id === args.findingId)
  if (!finding?.threadId) throw new Error('finding has no Coro thread')
  const scm = scmFor(ctx, review.prRef.pluginId)
  if (!scm.resolveThread) throw new Error('SCM plugin cannot resolve threads')
  await scm.resolveThread(review.prRef, finding.threadId, args.resolved)
  await mutateReview(ctx, fresh => {
    const current = fresh.ledger.findings.find(item => item.id === args.findingId)
    if (!current) return
    if (args.resolved) current.status = 'addressed'
    current.lastTouchedRound = fresh.totals.rounds
  })
}

export async function reviewUpdateFindings(
  ctx: ToolContext,
  args: { updates: { findingId: string; status: Finding['status']; note?: string }[] },
): Promise<unknown> {
  assertReviewJob(ctx)
  let updated = 0
  await mutateReview(ctx, review => {
    for (const update of args.updates) {
      const finding = review.ledger.findings.find(item => item.id === update.findingId)
      if (!finding) continue
      finding.status = update.status
      finding.lastTouchedRound = review.totals.rounds
      if (update.note) finding.body = `${finding.body ?? ''}\n\n${update.note}`.trim()
      updated += 1
    }
  })
  return { updated }
}

export async function reviewFinish(
  ctx: ToolContext,
  args: FinishArgs,
  signals?: PhaseSignals,
): Promise<unknown> {
  assertReviewJob(ctx)
  if (defersWrites(ctx)) {
    await saveDraft(ctx, current => { current.finish = args }, signals)
    return { ok: true, deferred: true, next: 'The publish phase records this outcome when it posts the draft.' }
  }
  await finishRound(ctx, args)
  return { ok: true, nextHint: args.nextHint ?? null }
}

async function finishRound(ctx: ToolContext, args: FinishArgs): Promise<void> {
  await mutateReview(ctx, review => {
    // Only this job's own round. Falling back to "the latest" would let a late
    // finish overwrite a newer round's summary.
    const round = review.rounds.find(item => item.jobId === ctx.job.id)
    if (round) {
      round.outcome = args.outcome
      round.summary = args.summary
    }
    if (args.outcome === 'failed') return
    const head = ctx.job.params['headSha']
    if (typeof head === 'string' && head) review.ledger.lastReviewedSha = head
    const patchIds = ctx.job.params['prPatchIds']
    if (patchIds && typeof patchIds === 'object') review.ledger.patchIds = patchIds as Record<string, string>
  })
}

/**
 * The publish phase. Posts the approved draft, resolves the threads it
 * queued, and records the round. Safe to call again after a failure: a
 * review that already reached the SCM is not posted twice.
 */
export async function reviewPublish(ctx: ToolContext): Promise<unknown> {
  assertReviewJob(ctx)
  const draft = await loadDraft(ctx)
  if (!draft) {
    await finishRound(ctx, { outcome: 'no-op', summary: 'The review phase left nothing to post.' })
    return { posted: 'nothing' }
  }
  if (draft.status === 'published') return { posted: 'already', publishedAt: draft.publishedAt }

  let posted: Awaited<ReturnType<typeof postReview>> | undefined
  if (!draft.postedAt && (draft.body.trim() || draft.comments.length > 0)) {
    posted = await postReview(ctx, await loadReview(ctx), draft)
    await saveDraft(ctx, current => { current.postedAt = new Date().toISOString() })
  }
  const failed: { findingId: string; error: string }[] = []
  for (const item of draft.resolve) {
    try {
      await resolveThreadNow(ctx, item)
    } catch (err) {
      failed.push({ findingId: item.findingId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const outcome = draft.finish?.outcome
    ?? (posted?.held ? 'held-for-verdict' : posted ? 'submitted' : 'no-op')
  await finishRound(ctx, { outcome, summary: draft.finish?.summary ?? '' })
  await saveDraft(ctx, current => {
    current.status = 'published'
    current.publishedAt = new Date().toISOString()
  })
  return {
    posted: posted?.posted ?? 'nothing',
    held: posted?.held ?? false,
    comments: posted?.comments ?? 0,
    resolved: draft.resolve.length - failed.length,
    ...(failed.length ? { resolveFailures: failed } : {}),
    outcome,
  }
}
