import type { ActivityItem } from '../components/activity/types'
import type { Job } from '../types'
import type { RunDraft } from './intake-run'
import { getInvestigationId, getJobRepo, getReviewers, getServiceName } from './jobs'

export interface LinkedRunCardData {
  run: RunDraft
  state: 'draft' | 'superseded' | 'dispatched'
  jobId?: string
}

/**
 * The job this conversation started, if any. `dispatchedJobId` on the
 * investigation row is the authority; falling back to `params.investigationId`
 * repairs rows whose dashboard persist never landed (the 100kb JSON limit
 * used to drop exactly that PUT).
 */
export function jobForInvestigation(
  jobs: Job[],
  investigationId: string,
  dispatchedJobId?: string | null,
): Job | null {
  const fromId = dispatchedJobId?.trim()
  if (fromId) {
    const hit = jobs.find(job => job.id === fromId)
    if (hit) return hit
  }
  return jobs.find(job => getInvestigationId(job) === investigationId) ?? null
}

export function runDraftFromJob(job: Job): RunDraft {
  const repo = getJobRepo(job) ?? ''
  const serviceName = getServiceName(job) ?? ''
  const description = typeof job.params['description'] === 'string' ? job.params['description'] : ''
  return {
    repo,
    serviceName: serviceName || repo.split('/').pop() || repo,
    description: description.trim() || 'Run dispatched from this conversation.',
    reviewers: getReviewers(job).join(', '),
    workflowPath: job.workflowPath,
    interactive: job.interactive,
  }
}

function isRunCard(item: ActivityItem): item is ActivityItem & { kind: 'card' } {
  return item.kind === 'card' && item.card.type === 'run'
}

function cardData(item: ActivityItem & { kind: 'card' }): LinkedRunCardData {
  return item.card.data as LinkedRunCardData
}

/**
 * Guarantee the chat has a dispatched run card for `job`. Upgrades the
 * latest draft card in place (preserving any edits) and otherwise appends
 * a reconstructed one from the job params. Returns the same array when
 * nothing needs doing.
 */
export function ensureDispatchedRunCard(items: ActivityItem[], job: Job): ActivityItem[] {
  const already = items.some(item => {
    if (!isRunCard(item)) return false
    const data = cardData(item)
    return data.state === 'dispatched' && data.jobId === job.id
  })
  if (already) return items

  let upgraded = false
  const next = items.map(item => {
    if (!isRunCard(item) || upgraded) return item
    const data = cardData(item)
    if (data.state === 'superseded') return item
    upgraded = true
    return {
      ...item,
      card: {
        ...item.card,
        data: { ...data, run: data.run ?? runDraftFromJob(job), state: 'dispatched' as const, jobId: job.id },
      },
    }
  })
  if (upgraded) return next

  return [
    ...items,
    {
      kind: 'card',
      id: `card-run-${job.id}`,
      card: {
        type: 'run',
        data: { run: runDraftFromJob(job), state: 'dispatched', jobId: job.id } satisfies LinkedRunCardData,
      },
    },
  ]
}
