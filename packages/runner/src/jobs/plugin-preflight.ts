import type { JobInput, Job } from '@coro/cloud-protocol'
import { PluginResolutionError, type PluginRegistry } from '../plugins/registry'

type JobPluginParamsSource = Pick<JobInput, 'params'> | Pick<Job, 'params'>

export interface JobPluginRequirementIssue {
  kind: 'scm' | 'tracker'
  message: string
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function formatIssue(kind: 'scm' | 'tracker', message: string): string {
  if (kind === 'scm') {
    return `SCM setup incomplete. ${message} Configure Settings > Git to enable GitHub or Bitbucket, then restart the runner.`
  }
  return `Tracker setup incomplete. ${message} Configure Settings > Tracker to enable Jira, Linear, or GitHub Issues, then restart the runner.`
}

export function getJobPluginRequirementIssues(
  input: JobPluginParamsSource,
  plugins: PluginRegistry,
): JobPluginRequirementIssue[] {
  const params = (input.params ?? {}) as Record<string, unknown>
  const issues: JobPluginRequirementIssue[] = []

  const repoSlug = stringParam(params, 'repoSlug')
  const requestedScm = stringParam(params, 'scm')
  if (repoSlug || requestedScm) {
    try {
      plugins.resolveScm(requestedScm ? { scm: requestedScm } : {})
    } catch (err) {
      if (err instanceof PluginResolutionError) {
        issues.push({ kind: 'scm', message: formatIssue('scm', err.message) })
      } else {
        throw err
      }
    }
  }

  const jiraTicketId = stringParam(params, 'jiraTicketId')
  const requestedTracker = stringParam(params, 'tracker')
  if (jiraTicketId || requestedTracker) {
    try {
      plugins.resolveTracker(requestedTracker ? { tracker: requestedTracker } : {})
    } catch (err) {
      if (err instanceof PluginResolutionError) {
        issues.push({ kind: 'tracker', message: formatIssue('tracker', err.message) })
      } else {
        throw err
      }
    }
  }

  return issues
}

export function assertJobPluginRequirements(
  input: JobPluginParamsSource,
  plugins: PluginRegistry,
): void {
  const issues = getJobPluginRequirementIssues(input, plugins)
  if (issues.length === 0) return
  throw new Error(issues.map(issue => issue.message).join(' '))
}