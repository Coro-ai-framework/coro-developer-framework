import type { Job } from '../types'
import { isTerminalStatus } from './status'

export const CAMPAIGN_WORKFLOW_PATH = 'workflows/campaign/workflow.md'

function startCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function isCampaignJob(job: Pick<Job, 'workflowPath' | 'campaignChildren'>): boolean {
  return job.workflowPath === CAMPAIGN_WORKFLOW_PATH || Array.isArray(job.campaignChildren)
}

export function getRunKindLabel(job: Pick<Job, 'workflowPath' | 'campaignChildren'>): 'Job' | 'Campaign' {
  return isCampaignJob(job) ? 'Campaign' : 'Job'
}

export function deriveWorkflowLabel(workflowPath: string): string {
  const segments = workflowPath.split('/').filter(Boolean)
  const workflowSlug = segments.length >= 2 ? segments[segments.length - 2] : segments[segments.length - 1]
  return workflowSlug ? startCase(workflowSlug) : 'Workflow'
}

export function getRunDetailPath(job: Pick<Job, 'id'>): string {
  return `/jobs/${job.id}`
}

export function deriveJobTitle(job: Pick<Job, 'id' | 'params'>): string {
  const serviceName = typeof job.params['serviceName'] === 'string' ? job.params['serviceName'] : null
  const campaignChildName = typeof job.params['campaignChildName'] === 'string' ? job.params['campaignChildName'] : null
  const jiraTicketId = typeof job.params['jiraTicketId'] === 'string' ? job.params['jiraTicketId'] : null
  return serviceName ?? campaignChildName ?? jiraTicketId ?? job.id
}

export function deriveJobDescription(job: Pick<Job, 'params'>): string | null {
  const description = typeof job.params['description'] === 'string' ? job.params['description'] : null
  return description && description.trim().length > 0 ? description : null
}

export function getReviewers(job: Pick<Job, 'params'>): string[] {
  const reviewers = job.params['reviewers']
  return Array.isArray(reviewers) ? reviewers.filter((reviewer): reviewer is string => typeof reviewer === 'string') : []
}

export function getRepoSlug(job: Pick<Job, 'params'>): string | null {
  const repo = job.params['repoSlug']
  return typeof repo === 'string' && repo.length > 0 ? repo : null
}

export function getServiceName(job: Pick<Job, 'params'>): string | null {
  const serviceName = job.params['serviceName']
  return typeof serviceName === 'string' && serviceName.length > 0 ? serviceName : null
}

export function getCurrentWorkItem(job: Pick<Job, 'currentWorkItem'>): string {
  return job.currentWorkItem ?? 'Waiting for the next action'
}

export function isActiveJob(job: Pick<Job, 'status'>): boolean {
  return !isTerminalStatus(job.status)
}

export function sortJobsByUpdatedAt<T extends Pick<Job, 'updatedAt'>>(jobs: T[]): T[] {
  return [...jobs].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
}