// Retrospective view vocabulary.
//
// The runner owns parsing: `GET /retrospectives[/:jobId]` returns findings
// already read out of the run's artefacts, so the dashboard never interprets
// a raw report payload. What lives here is the presentation vocabulary —
// tier copy, category and severity labels, window bounds — shared by the
// launch form, the history list, and the checkpoint panel.

import type { FindingCategory, FindingSeverity, Job, RetrospectiveOutcome, RetrospectiveTiers } from '../types'
import type { Tone } from './status'

export const RETROSPECTIVE_PATH = '/retrospectives'
export const RETROSPECTIVE_WORKFLOW_SLUG = 'retrospective'

export const RETROSPECTIVE_DEFAULT_WINDOW = 25
export const RETROSPECTIVE_MIN_WINDOW = 5
export const RETROSPECTIVE_MAX_WINDOW = 100

export const RETROSPECTIVE_DEFAULT_TIERS: RetrospectiveTiers = {
  tenant: true,
  upstreamIntelligence: false,
  upstreamCode: false,
}

export type TierKey = keyof RetrospectiveTiers

export interface TierMeta {
  key: TierKey
  label: string
  description: string
}

/**
 * Tier copy, ordered by how far the change travels. The launch form renders
 * these as toggles and the run header lists the enabled ones, so each tier is
 * described in exactly one place.
 */
export const TIER_META: ReadonlyArray<TierMeta> = [
  {
    key: 'tenant',
    label: 'Your intelligence',
    description: 'Propose memory, skill, and agent edits to your own team and repo layers.',
  },
  {
    key: 'upstreamIntelligence',
    label: 'Coro intelligence',
    description:
      'Open an issue and a markdown pull request against the Coro repository. ' +
      'Requires an upstream destination in your config.',
  },
  {
    key: 'upstreamCode',
    label: 'Coro code',
    description:
      'Dispatch an implementation run that fixes runner code upstream. ' +
      'Requires an upstream destination in your config.',
  },
]

interface CategoryMeta {
  label: string
  description: string
  tone: Tone
}

const CATEGORY_META: Record<FindingCategory, CategoryMeta> = {
  'tenant-intelligence': {
    label: 'Your intelligence',
    description: 'Fix belongs in this install\u2019s own memory, skills, or agents.',
    tone: 'accent',
  },
  'base-intelligence': {
    label: 'Coro intelligence',
    description: 'Fix belongs in the base intelligence layer every install ships with.',
    tone: 'warning',
  },
  'runner-code': {
    label: 'Coro code',
    description: 'Fix needs a code change in the runner itself.',
    tone: 'danger',
  },
}

const SEVERITY_TONE: Record<FindingSeverity, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

export function categoryLabel(category: FindingCategory): string {
  return CATEGORY_META[category].label
}

export function categoryDescription(category: FindingCategory): string {
  return CATEGORY_META[category].description
}

export function categoryTone(category: FindingCategory): Tone {
  return CATEGORY_META[category].tone
}

export function severityTone(severity: FindingSeverity): Tone {
  return SEVERITY_TONE[severity]
}

/** Names of the tiers this run was launched with. */
export function enabledTierLabels(tiers: RetrospectiveTiers): string[] {
  return TIER_META.filter(tier => tiers[tier.key]).map(tier => tier.label)
}

/** Detected from the workflow path, so it also matches overlaid workflows. */
export function isRetrospectiveJob(job: Pick<Job, 'workflowPath'>): boolean {
  return job.workflowPath.includes(`workflows/${RETROSPECTIVE_WORKFLOW_SLUG}/`)
}

/** Outcomes indexed by the finding they resolve. */
export function outcomesByFinding(
  outcomes: ReadonlyArray<RetrospectiveOutcome>,
): Map<string, RetrospectiveOutcome> {
  return new Map(outcomes.map(outcome => [outcome.findingId, outcome]))
}

/** Human label for where a finding ended up. */
export function destinationLabel(destination: string): string {
  switch (destination) {
    case 'tenant':
      return 'Your intelligence'
    case 'upstream-intelligence':
      return 'Coro intelligence'
    case 'upstream-issue':
      return 'Reported to Coro'
    case 'upstream-issue-comment':
      return 'Added to existing Coro report'
    case 'upstream-code':
      return 'Coro code'
    case 'none':
      return 'Not shipped'
    default:
      return destination
  }
}

export function destinationTone(destination: string): Tone {
  if (destination === 'none' || destination === 'unknown') return 'neutral'
  return 'success'
}
