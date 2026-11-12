// ── Round preparation ────────────────────────────────────────────────────────
//
// Runs in the runner before a round is dispatched, through the SCM API only.
// Nothing from the pull request's head is executed or loaded as intelligence:
// the diff becomes a packet, and the repo's `.coro/review.md` is read from
// the *base* commit and can only tighten policy.

import { createHash } from 'crypto'
import type { PrReview } from '@coro-ai/cloud-protocol'
import type { ScmPluginRuntime, ScmPrDiff } from '../plugins/types'
import { buildPacket, isOutOfScopeDelta, patchUnchanged, type PacketFile, type ReviewPacket } from './packet'
import { tightenPolicy, type ReviewPolicy } from './policy'
import { parseReviewFrontMatter } from './workspace'
import type { ShortCircuitDecision } from './coordinator'
import type { RelatedWork } from './related-work'

/** Packet as stored on the job: hunks stay out of job params and are written to the job dir instead. */
export type StoredPacket = Omit<ReviewPacket, 'files'> & { files: Omit<PacketFile, 'hunks'>[] }

export interface PreparedRound {
  packet: StoredPacket
  patchIds: Record<string, string>
  policy: ReviewPolicy
  repoGuidance: string
  /** What the author wrote on the pull request. Bounded; data to review, never instructions. */
  description: string
  /** Set by the round pipeline for rounds that run lenses. */
  relatedWork?: RelatedWork
}

/** Longest description carried on a job. The rest is the author's prose, not review input. */
export const MAX_DESCRIPTION_CHARS = 8000

export interface PrepareArgs {
  scm: ScmPluginRuntime
  review: PrReview
  policy: ReviewPolicy
  lenses: { name: string; when?: string[] }[]
}

/**
 * Refreshes `review.pr` in place and computes what the round needs.
 * Throws when the SCM cannot describe the pull request at all, because a
 * round with no diff would review nothing.
 */
export async function prepareRound(args: PrepareArgs): Promise<PreparedRound> {
  const { scm, review } = args
  if (!scm.getPrDetails || !scm.getPrDiff) {
    throw new Error(`The ${review.prRef.pluginId} plugin cannot read pull request diffs.`)
  }
  const [details, diff] = await Promise.all([scm.getPrDetails(review.prRef), scm.getPrDiff(review.prRef)])
  review.pr.title = details.title || review.pr.title
  review.pr.author = details.author || review.pr.author
  review.pr.draft = details.draft
  review.pr.state = details.state === 'merged' ? 'merged' : details.state === 'declined' ? 'declined' : 'open'
  review.pr.baseSha = details.baseSha || review.pr.baseSha
  review.pr.headSha = details.headSha || review.pr.headSha
  if (details.url) review.pr.url = details.url
  review.pr.changedFiles = diff.files.length
  review.pr.additions = diff.files.reduce((sum, file) => sum + file.additions, 0)
  review.pr.deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0)
  review.pr.labels = details.labels

  const repoGuidance = await readBaseGuidance(scm, review)
  const policy = repoGuidance ? tightenPolicy(args.policy, parseReviewFrontMatter(repoGuidance)) : args.policy

  const packet = buildPacket({
    files: diff.files.map(file => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.patch ? { hunks: file.patch } : {}),
    })),
    lenses: args.lenses,
    maxDiffLines: policy.maxDiffLines,
    maxLensInputTokens: policy.maxLensInputTokens,
    contextTokens: 200_000,
  })
  return {
    packet: { ...packet, files: packet.files.map(({ hunks: _hunks, ...file }) => file) },
    patchIds: patchIdsOf(diff),
    policy,
    repoGuidance,
    description: (details.body ?? '').trim().slice(0, MAX_DESCRIPTION_CHARS),
  }
}

/**
 * Zero-cost outcomes for an incremental round. A rebase keeps every
 * patch id; a push that only touches lockfiles or generated code does not
 * need a model.
 */
export function shortCircuitFor(
  review: PrReview,
  kind: string,
  prepared: PreparedRound,
): ShortCircuitDecision | null {
  if (review.pr.state !== 'open' && kind !== 'closing') {
    return { kind: 'out-of-scope', summary: `The pull request is ${review.pr.state === 'merged' ? 'merged' : 'closed'}.` }
  }
  if (kind !== 'incremental') return null
  const previous = review.ledger.patchIds
  if (patchUnchanged(previous, prepared.patchIds)) {
    return { kind: 'patch-unchanged', headSha: review.pr.headSha, summary: 'Rebased or re-pushed without changing the diff.' }
  }
  if (previous) {
    const changed = prepared.packet.files.filter(file => previous[file.path] !== prepared.patchIds[file.path])
    if (changed.length > 0 && isOutOfScopeDelta(changed, prepared.policy.ignorePaths)) {
      return { kind: 'out-of-scope', headSha: review.pr.headSha, summary: 'Only generated, vendored, lockfile, or ignored files changed.' }
    }
  }
  return null
}

/**
 * Per-file hash of the changed lines only, so moving a hunk (a rebase onto
 * a new base) keeps the id while any edit to the change itself does not.
 */
export function patchIdsOf(diff: ScmPrDiff): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const file of diff.files) {
    const changed = (file.patch ?? '')
      .split('\n')
      .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
      .join('\n')
    ids[file.path] = createHash('sha256').update(`${file.status ?? ''}\0${changed}`).digest('hex').slice(0, 16)
  }
  return ids
}

async function readBaseGuidance(scm: ScmPluginRuntime, review: PrReview): Promise<string> {
  if (!scm.readFile || !review.prRef.repoKey || !review.pr.baseSha) return ''
  try {
    const file = await scm.readFile({ repo: review.prRef.repoKey, path: '.coro/review.md', ref: review.pr.baseSha })
    return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content
  } catch {
    return ''
  }
}
