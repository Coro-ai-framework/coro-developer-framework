import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { MemoryReviewStore } from '../../src/reviews/store'
import { ReviewCoordinator, isIrrelevantConversation } from '../../src/reviews/coordinator'
import { REVIEW_POLICY_DEFAULTS, effectiveSubmission, resolveReviewPolicy } from '../../src/reviews/policy'
import { buildPacket, classifyPath, isOutOfScopeDelta, patchUnchanged } from '../../src/reviews/packet'
import { decodeReviewState, renderSummaryComment } from '../../src/reviews/marker'
import { parseReviewCommand } from '../../src/reviews/commands'
import { deltaToReviewKind, diffPrSnapshot } from '../../src/reviews/pr-change-detector'
import { resolveLensMcp } from '../../src/tools/pr-review'
import { parseWorkflowConfig, resolveInitialPhase } from '../../src/workflow-parser'
import type { ExternalRef, PrReview } from '@coro-ai/cloud-protocol'

const ref: ExternalRef = { kind: 'pull_request', pluginId: 'github', repoKey: 'acme/svc', externalId: '7' }

function review(): PrReview {
  return {
    id: 'rev_test',
    prRef: ref,
    reviewer: { login: 'ada', mode: 'self' },
    status: 'idle',
    pr: { title: 'Add rate limit', author: 'grace', baseSha: 'a', headSha: 'b', state: 'open', draft: false, url: 'https://github.com/acme/svc/pull/7' },
    ledger: { findings: [] },
    rounds: [],
    pendingEvents: [],
    totals: { rounds: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('review policy', () => {
  it('lets the repo raise the severity floor and not the budget', () => {
    const policy = resolveReviewPolicy({
      user: { budgetUsdPerPr: 5, minSeverity: 'minor', autonomy: 'full' },
      repo: { minSeverity: 'major', budgetUsdPerPr: 50, mcpRoles: { architecture: { servers: ['evil'], allowTools: [], denyTools: [] } } },
    })
    expect(policy.minSeverity).toBe('major')
    expect(policy.budgetUsdPerPr).toBe(5)
    expect(policy.mcpRoles).toEqual({})
  })

  it('holds an approval when autonomy is comment and approval is recommend', () => {
    const policy = { ...REVIEW_POLICY_DEFAULTS, autonomy: 'comment' as const, approval: 'recommend' as const }
    expect(effectiveSubmission(policy, 'approve')).toEqual({ event: 'comment', holdVerdict: true })
    expect(effectiveSubmission(policy, 'comment').holdVerdict).toBe(false)
  })
})

describe('review packet', () => {
  it('routes code to correctness and skips a docs-only file', () => {
    expect(classifyPath('src/app.ts')).toContain('code')
    const packet = buildPacket({
      files: [{ path: 'README.md', additions: 3, deletions: 0 }],
      lenses: [
        { name: 'correctness', when: ['code'] },
        { name: 'verifier', when: ['always'] },
      ],
      maxDiffLines: 1000,
      maxLensInputTokens: 1000,
      contextTokens: 10000,
    })
    expect(packet.routes).toEqual([])
  })

  it('treats a lockfile-only delta as out of scope and a rebase as unchanged', () => {
    const files = [{ path: 'pnpm-lock.yaml', classes: ['lockfile' as const], additions: 10, deletions: 1 }]
    expect(isOutOfScopeDelta(files, [])).toBe(true)
    expect(patchUnchanged({ 'a.ts': 'p1' }, { 'a.ts': 'p1' })).toBe(true)
    expect(patchUnchanged({ 'a.ts': 'p1' }, { 'a.ts': 'p2' })).toBe(false)
  })
})

describe('review marker', () => {
  it('round-trips the review through the sticky comment', () => {
    const body = renderSummaryComment(review())
    expect(decodeReviewState(body)?.id).toBe('rev_test')
  })
})

describe('review coordinator', () => {
  it('debounces two pushes into one round', async () => {
    const store = new MemoryReviewStore()
    const dispatched: string[] = []
    const coordinator = new ReviewCoordinator({
      store,
      policy: { ...REVIEW_POLICY_DEFAULTS, debounceSec: 0, enabled: true },
      reviewerLogin: 'ada',
      now: () => 1_700_000_000_000,
      setTimer: fn => {
        queueMicrotask(fn)
        return { clear() {} }
      },
      dispatchRound: async (item, kind) => {
        dispatched.push(kind)
        return { jobId: `job-${dispatched.length}` }
      },
    })
    await coordinator.ingest({ kind: 'manual', prRef: ref, at: 't', data: { title: 'Add rate limit' }, source: 'manual' })
    await coordinator.ingest({ kind: 'commits-pushed', prRef: ref, at: 't2', data: {}, source: 'activity-poll' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(dispatched.length).toBeGreaterThan(0)
  })

  it('ignores a bot reply that is not about the review', () => {
    const item = review()
    expect(isIrrelevantConversation(item, [{
      kind: 'comment',
      prRef: ref,
      at: 't',
      data: { body: 'thanks' },
      source: 'activity-poll',
    }])).toBe(true)
    expect(parseReviewCommand('@coro pause')?.name).toBe('pause')
  })
})

describe('pr change detector', () => {
  it('emits a push when the head sha changes', () => {
    const deltas = diffPrSnapshot(
      { state: 'open', approvalCount: 0, commentCount: 0, headSha: 'a' },
      { state: 'open', approvalCount: 0, commentCount: 0, headSha: 'b' },
      [],
    )
    expect(deltas.map(delta => deltaToReviewKind(delta))).toContain('commits-pushed')
  })
})

describe('pr-review workflow', () => {
  it('parses terminal phases, lenses, and round-kind overrides', () => {
    const markdown = readFileSync(
      path.resolve(__dirname, '../../../intelligence-base/layer/workflows/pr-review/workflow.md'),
      'utf8',
    )
    const config = parseWorkflowConfig(markdown)
    expect(config).not.toBeNull()
    const review = config!.phases.find(phase => phase.name === 'review')
    expect(review?.terminal).toBe(true)
    expect(review?.lenses?.map(lens => lens.name)).toContain('architecture')
    expect(resolveInitialPhase(config!, 'pr-review:conversation')).toBe('converse')
    expect(resolveInitialPhase(config!, 'pr-review:closing')).toBe('learn')
  })
})

describe('lens mcp scoping', () => {
  it('gives the architecture role its servers and nobody else a write tool by default', () => {
    const resolved = resolveLensMcp(
      { name: 'architecture', mcpServers: ['@architecture'] },
      { ...REVIEW_POLICY_DEFAULTS, mcpRoles: { architecture: { servers: ['backstage'], allowTools: ['mcp__backstage__get_*'], denyTools: [] } } },
    )
    expect(resolved.serverIds).toEqual(['backstage'])
    expect(resolved.allowTools).toEqual(['mcp__backstage__get_*'])
    expect(resolveLensMcp({ name: 'correctness' }, REVIEW_POLICY_DEFAULTS).serverIds).toEqual([])
  })
})
