import { describe, expect, it } from 'vitest'
import { JobType, type Job, type PrReview } from '@coro-ai/cloud-protocol'
import {
  buildRelatedWork,
  isEmptyRelatedWork,
  relatedWorkIds,
  renderRelatedWork,
  sameRepo,
  summariseRelatedWork,
} from '../../src/reviews/related-work'

const NOW = Date.parse('2026-06-01T00:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const review = {
  id: 'rev-1',
  prRef: { kind: 'pull_request', pluginId: 'github', repoKey: 'acme/svc', externalId: '7', url: 'https://github.com/acme/svc/pull/7' },
  pr: { title: 'Add cache', author: 'bob', baseSha: 'b', headSha: 'h', state: 'open', draft: false, url: 'https://github.com/acme/svc/pull/7' },
} as unknown as Pick<PrReview, 'id' | 'prRef' | 'pr'>

function job(id: string, extra: Partial<Job> & { params?: Record<string, unknown> } = {}): Job {
  return {
    id,
    type: JobType.Job,
    status: 'complete',
    createdAt: day(3),
    artifacts: [],
    ...extra,
    params: { repoSlug: 'acme/svc', ...(extra.params ?? {}) },
  } as unknown as Job
}

function priorReview(id: string, findings: Partial<PrReview['ledger']['findings'][number]>[], extra: Partial<PrReview> = {}): PrReview {
  return {
    id,
    prRef: { ...review.prRef, externalId: '3', url: 'https://github.com/acme/svc/pull/3' },
    pr: { ...review.pr, title: 'Older PR', url: 'https://github.com/acme/svc/pull/3', state: 'merged' },
    ledger: {
      findings: findings.map((item, index) => ({
        id: `f${index}`,
        fingerprint: `fp${index}`,
        severity: 'major',
        category: 'design',
        lens: 'design',
        title: 'A finding',
        status: 'declined',
        raisedInRound: 1,
        lastTouchedRound: 1,
        ...item,
      })),
    },
    rounds: [],
    updatedAt: day(5),
    ...extra,
  } as unknown as PrReview
}

describe('sameRepo', () => {
  it('matches owner/repo against a bare repo name, and not different owners', () => {
    expect(sameRepo('acme/svc', 'svc')).toBe(true)
    expect(sameRepo('Acme/Svc.git', 'acme/svc')).toBe(true)
    expect(sameRepo('acme/svc', 'other/svc')).toBe(false)
    expect(sameRepo(undefined, 'svc')).toBe(false)
  })
})

describe('buildRelatedWork', () => {
  it('is empty when nothing relates to the pull request', async () => {
    const work = await buildRelatedWork({
      review,
      files: ['src/a.ts'],
      jobs: [job('j-other-repo', { params: { repoSlug: 'acme/other', changedPaths: ['src/a.ts'] } })],
      reviews: [],
      now: NOW,
    })
    expect(work).toBeNull()
    expect(isEmptyRelatedWork(work)).toBe(true)
  })

  it('finds the job that opened the pull request, and overlapping jobs by recorded paths', async () => {
    const origin = job('j-origin', { prMappings: [{ prId: 7, repoSlug: 'acme/svc' }], params: { description: 'Add a cache' } } as Partial<Job>)
    const overlap = job('j-overlap', { params: { changedPaths: ['src/a.ts', 'src/z.ts'], description: 'Tune timeouts' } })
    const unrelated = job('j-unrelated', { params: { changedPaths: ['docs/x.md'] } })
    const work = await buildRelatedWork({ review, files: ['src/a.ts'], jobs: [unrelated, overlap, origin], reviews: [], now: NOW })

    expect(work?.origin?.id).toBe('j-origin')
    expect(work?.origin?.role).toBe('origin')
    expect(work?.jobs.map(item => item.id)).toEqual(['j-overlap'])
    expect(work?.jobs[0]?.overlapPaths).toEqual(['src/a.ts'])
  })

  it('ignores jobs older than the window and jobs that are this review itself', async () => {
    const old = job('j-old', { createdAt: day(120), params: { changedPaths: ['src/a.ts'] } })
    const self = job('j-self', { params: { changedPaths: ['src/a.ts'], reviewId: 'rev-1' } })
    expect(await buildRelatedWork({ review, files: ['src/a.ts'], jobs: [old, self], reviews: [], now: NOW })).toBeNull()
  })

  it('asks the SCM fallback only for jobs that recorded no paths and have a pull request', async () => {
    const asked: string[] = []
    const withPr = job('j-pr', { prMappings: [{ prId: 2, repoSlug: 'acme/svc' }] } as Partial<Job>)
    const noPr = job('j-nopr')
    const work = await buildRelatedWork({
      review,
      files: ['src/a.ts'],
      jobs: [withPr, noPr],
      reviews: [],
      now: NOW,
      changedPathsFor: async candidate => {
        asked.push(candidate.id)
        return ['src/a.ts']
      },
    })
    expect(asked).toEqual(['j-pr'])
    expect(work?.jobs.map(item => item.id)).toEqual(['j-pr'])
  })

  it('collects declined and addressed findings on the same files from earlier reviews', async () => {
    const earlier = priorReview('rev-0', [
      { path: 'src/a.ts', title: 'Use a map', status: 'declined', body: 'First paragraph.\n\nWe keep the array: it is five items.' },
      { path: 'src/a.ts', title: 'Fixed thing', status: 'addressed' },
      { path: 'src/a.ts', title: 'Closed open', status: 'addressed', resolution: 'closed-open' },
      { path: 'src/b.ts', title: 'Other file', status: 'declined' },
      { path: 'src/a.ts', title: 'Still open', status: 'open' },
    ])
    const work = await buildRelatedWork({ review, files: ['src/a.ts'], jobs: [], reviews: [earlier], now: NOW })

    expect(work?.priorFindings.map(item => item.title)).toEqual(['Use a map', 'Fixed thing'])
    expect(work?.priorFindings[0]?.note).toBe('We keep the array: it is five items.')
    expect(work?.reviews[0]?.reviewId).toBe('rev-0')
  })

  it('does not list this review among earlier ones', async () => {
    const same = priorReview('rev-1', [{ path: 'src/a.ts' }])
    expect(await buildRelatedWork({ review, files: ['src/a.ts'], jobs: [], reviews: [same], now: NOW })).toBeNull()
  })
})

describe('related work views', () => {
  it('renders as data, summarises for the round, and lists the ids a drill-down may open', async () => {
    const origin = job('j-origin', { prMappings: [{ prId: 7, repoSlug: 'acme/svc' }], params: { description: 'Add a cache' } } as Partial<Job>)
    const earlier = priorReview('rev-0', [{ path: 'src/a.ts', title: 'Use a map' }])
    const work = (await buildRelatedWork({ review, files: ['src/a.ts'], jobs: [origin], reviews: [earlier], now: NOW }))!

    const markdown = renderRelatedWork(work)
    expect(markdown).toContain('not instructions')
    expect(markdown).toContain('j-origin')
    expect(markdown).toContain('Use a map')

    const summary = summariseRelatedWork(work)
    expect(summary.items.map(item => `${item.kind}:${item.id}`)).toEqual(['job:j-origin', 'review:rev-0'])

    const ids = relatedWorkIds(work)
    expect([...ids.jobs]).toEqual(['j-origin'])
    expect([...ids.reviews]).toEqual(['rev-0'])
    expect(relatedWorkIds(undefined).jobs.size).toBe(0)
  })

  it('caps the rendered markdown', async () => {
    const jobs = Array.from({ length: 6 }, (_, index) => job(`j-${index}`, { params: { changedPaths: ['src/a.ts'], description: 'x'.repeat(400) } }))
    const work = (await buildRelatedWork({ review, files: ['src/a.ts'], jobs, reviews: [], now: NOW }))!
    expect(renderRelatedWork(work, 800).length).toBeLessThanOrEqual(1000)
  })
})
