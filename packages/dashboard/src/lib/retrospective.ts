// Retrospective view vocabulary.
//
// The runner owns parsing: `GET /retrospectives[/:jobId]` returns findings
// already read out of the run's artefacts, so the dashboard never interprets
// a raw report payload. What lives here is the presentation vocabulary —
// tier copy, category and severity labels, window bounds — shared by the
// launch form, the history list, and the checkpoint panel.

import type {
  FindingCategory,
  FindingSeverity,
  Job,
  RetrospectiveFinding,
  RetrospectiveOutcome,
  RetrospectiveTiers,
} from '../types'
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
  /**
   * Needs a contribution destination in the runner's config. The launch
   * form disables these when the runner reports none, because dispatch
   * refuses the run outright rather than downgrading it.
   */
  requiresUpstream?: boolean
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
    description: 'Open an issue and dispatch a contribution job that edits Coro\'s base intelligence.',
    requiresUpstream: true,
  },
  {
    key: 'upstreamCode',
    label: 'Coro code',
    description: 'Open an issue and dispatch a contribution job that fixes Coro\'s runner code.',
    requiresUpstream: true,
  },
]

/** Settings deep link for the config the upstream tiers need. */
export const CONTRIBUTION_SETTINGS_PATH = '/settings#contribution'

/**
 * Tiers with their unconfigured destinations turned off.
 *
 * Used when the runner reports no contribution destination: the toggles
 * are disabled, but state set before that answer arrived (or persisted by
 * a future default) must not reach dispatch either.
 */
export function availableTiers(tiers: RetrospectiveTiers, upstreamConfigured: boolean): RetrospectiveTiers {
  if (upstreamConfigured) return tiers
  return {
    ...tiers,
    upstreamIntelligence: false,
    upstreamCode: false,
  }
}

/**
 * The approval message the analyst reads at the start of its shipping phase.
 *
 * The shipping phase acts per finding, so a bare "approved" leaves it
 * guessing which of five findings the developer meant. This composes the
 * decision into the shape `agents/retrospective-analyst.md` is written
 * against: ids on an `Approved findings:` line, ids on a `Skipped findings:`
 * line, nothing else that could read as a finding id.
 *
 * Ids are emitted in the analyst's own order rather than click order, so the
 * message reads against the list the developer was looking at.
 */
export function composeApprovalMessage(
  findings: ReadonlyArray<Pick<RetrospectiveFinding, 'id'>>,
  approvedIds: ReadonlySet<string>,
): string {
  const approved = findings.filter(f => approvedIds.has(f.id)).map(f => f.id)
  const skipped = findings.filter(f => !approvedIds.has(f.id)).map(f => f.id)

  const lines = [
    `Approved findings: ${approved.length > 0 ? approved.join(', ') : 'none'}`,
    `Skipped findings: ${skipped.length > 0 ? skipped.join(', ') : 'none'}`,
  ]
  lines.push(
    approved.length === 0
      ? 'Ship nothing. Record every finding as not shipped, with the reason "not approved by the developer", and finish the run.'
      : 'Ship only the approved findings. Record each skipped finding as not shipped, with the reason "not approved by the developer".',
  )
  return lines.join('\n')
}

/** One defect, with the symptoms the analyst wrote up separately. */
export interface FindingGroup {
  /** Stable key for React — the root cause, or the lone finding's id. */
  key: string
  /** Set only when the group really is a shared root cause. */
  rootCause?: string
  findings: RetrospectiveFinding[]
}

/**
 * Findings gathered into the units they ship as.
 *
 * A root cause becomes one upstream issue and one work item, so it has to be
 * one decision here too: approving three symptoms and skipping the fourth
 * would ask the shipping phase for three quarters of a pull request. Findings
 * with no `rootCause` are their own group, which is the common case.
 *
 * Order follows the analyst's, anchored at each group's first member, so the
 * ballot reads in the order the report was written.
 */
export function groupFindings(findings: ReadonlyArray<RetrospectiveFinding>): FindingGroup[] {
  const groups: FindingGroup[] = []
  const byRootCause = new Map<string, FindingGroup>()

  for (const finding of findings) {
    const rootCause = finding.rootCause?.trim()
    if (!rootCause) {
      groups.push({ key: finding.id, findings: [finding] })
      continue
    }

    const existing = byRootCause.get(rootCause)
    if (existing) {
      existing.findings.push(finding)
      continue
    }

    const group: FindingGroup = { key: `root:${rootCause}`, rootCause, findings: [finding] }
    byRootCause.set(rootCause, group)
    groups.push(group)
  }

  return groups
}

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
