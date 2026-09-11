import type { JobInput, Job } from '@coro-ai/cloud-protocol'
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

function trackerRefPluginId(params: Record<string, unknown>): string | undefined {
  const ref = params['trackerRef']
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return undefined
  return stringParam(ref as Record<string, unknown>, 'pluginId')
}

function formatDispatchScmIssue(message: string): string {
  return `SCM setup incomplete. ${message} Configure Settings > Git to enable GitHub or Bitbucket, then restart the runner.`
}

function formatSetParamIssue(kind: 'scm' | 'tracker', field: string, requested: string, message: string): string {
  const settingsHint = kind === 'scm'
    ? 'Enable it in Settings > Git.'
    : 'Enable it in Settings > Tracker.'
  return `Cannot set ${field} to "${requested}": ${message} ${settingsHint}`
}

function resolveKind(
  kind: 'scm' | 'tracker',
  requested: string,
  plugins: PluginRegistry,
): PluginResolutionError | undefined {
  try {
    if (kind === 'scm') plugins.resolveScm({ scm: requested })
    else plugins.resolveTracker({ tracker: requested })
    return undefined
  } catch (err) {
    if (err instanceof PluginResolutionError) return err
    throw err
  }
}

/**
 * Dispatch-time clone gate. A new job that names a repo (or an explicit
 * SCM plugin) cannot start without a resolvable SCM plugin — there is
 * nothing to clone with.
 *
 * Tracker is intentionally not gated here. Tracker is optional
 * (`tracker.available` in the prompt); a ticket id or `params.tracker`
 * must not block creation. Resume / `runJob` must not call this.
 */
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
        issues.push({ kind: 'scm', message: formatDispatchScmIssue(err.message) })
      } else {
        throw err
      }
    }
  }

  return issues
}

/**
 * Validate plugin ids in a `set_job_params` payload. Only the incoming
 * keys are checked — restating `language` (or any other field) on a job
 * that already carries `params.tracker` must not fail.
 *
 * Empty / whitespace values are ignored so the agent can clear a plugin
 * selection. `trackerRef.pluginId` is checked independently unless it
 * duplicates `params.tracker` (already resolved above).
 */
export function getIncomingPluginSelectionIssues(
  incoming: Record<string, unknown>,
  plugins: PluginRegistry,
): JobPluginRequirementIssue[] {
  const issues: JobPluginRequirementIssue[] = []

  const requestedScm = stringParam(incoming, 'scm')
  if (requestedScm) {
    const err = resolveKind('scm', requestedScm, plugins)
    if (err) {
      issues.push({
        kind: 'scm',
        message: formatSetParamIssue('scm', 'params.scm', requestedScm, err.message),
      })
    }
  }

  const requestedTracker = stringParam(incoming, 'tracker')
  if (requestedTracker) {
    const err = resolveKind('tracker', requestedTracker, plugins)
    if (err) {
      issues.push({
        kind: 'tracker',
        message: formatSetParamIssue('tracker', 'params.tracker', requestedTracker, err.message),
      })
    }
  }

  const refPluginId = trackerRefPluginId(incoming)
  if (refPluginId && refPluginId !== requestedTracker) {
    const err = resolveKind('tracker', refPluginId, plugins)
    if (err) {
      issues.push({
        kind: 'tracker',
        message: formatSetParamIssue('tracker', 'params.trackerRef.pluginId', refPluginId, err.message),
      })
    }
  }

  return issues
}

export class PluginPreflightError extends Error {
  readonly missingKind: 'scm' | 'tracker'

  constructor(missingKind: 'scm' | 'tracker', message: string) {
    super(message)
    this.name = 'PluginPreflightError'
    this.missingKind = missingKind
  }
}

export function assertJobPluginRequirements(
  input: JobPluginParamsSource,
  plugins: PluginRegistry,
): void {
  const issues = getJobPluginRequirementIssues(input, plugins)
  if (issues.length === 0) return
  const first = issues[0]!
  throw new PluginPreflightError(first.kind, issues.map(issue => issue.message).join(' '))
}
