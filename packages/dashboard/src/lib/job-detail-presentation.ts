import type { Artifact, PhaseUsage, PrMapping, WorkItem } from '../types'

export type ArtifactCategory =
  | 'plan'
  | 'spec'
  | 'report'
  | 'analysis'
  | 'pull-request'
  | 'link'
  | 'markdown'
  | 'data'

export type WorkItemLabel = 'Complete' | 'Active' | 'Pending' | 'Escalated'

export interface WorkItemPresentation {
  label: WorkItemLabel
  /** The item the live console is currently working on. */
  current: boolean
}

/** Most recent execution of a phase. Repeated phases append, so the last match wins. */
export function latestPhaseUsage(
  usages: PhaseUsage[] | undefined,
  phase: string,
): PhaseUsage | undefined {
  if (!usages || usages.length === 0) return undefined
  for (let index = usages.length - 1; index >= 0; index -= 1) {
    if (usages[index]?.phase === phase) return usages[index]
  }
  return undefined
}

/**
 * Filename when the artefact has one on disk, otherwise its title.
 * Agents can post kinds this UI has never seen, so the title is the fallback.
 */
export function artifactFileLabel(artifact: Pick<Artifact, 'title' | 'data'>): string {
  const path = artifact.data['path']
  if (typeof path === 'string' && path.trim()) {
    const filename = path.split('/').filter(Boolean).pop()
    return filename && filename.length > 0 ? filename : path.trim()
  }
  return artifact.title
}

/** Open-ended artefact kinds collapse onto a small set of document metaphors. */
export function artifactCategory(kind: string): ArtifactCategory {
  const normalized = kind.toLowerCase()
  if (normalized === 'pr-link' || normalized === 'pr-preview') return 'pull-request'
  if (normalized === 'url') return 'link'
  if (normalized.includes('analysis')) return 'analysis'
  if (normalized.includes('plan')) return 'plan'
  if (normalized.includes('spec')) return 'spec'
  if (
    normalized.includes('report')
    || normalized.includes('evaluation')
    || normalized.includes('test-result')
  ) {
    return 'report'
  }
  if (normalized.endsWith('-md') || normalized === 'markdown') return 'markdown'
  return 'data'
}

export function artifactCategoryLabel(category: ArtifactCategory): string {
  switch (category) {
    case 'plan':
      return 'Plan'
    case 'spec':
      return 'Spec'
    case 'report':
      return 'Report'
    case 'analysis':
      return 'Analysis'
    case 'pull-request':
      return 'Pull request'
    case 'link':
      return 'Link'
    case 'markdown':
      return 'Document'
    case 'data':
      return 'Data'
  }
}

export function artifactsNewestFirst<T extends Pick<Artifact, 'createdAt'>>(artifacts: T[]): T[] {
  return [...artifacts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/** Pull-request artefacts are shown on the work item, not in the artifact list. */
export function isPullRequestArtifact(kind: string): boolean {
  const normalized = kind.toLowerCase()
  return normalized === 'pr-link' || normalized === 'pr-preview'
}

export function documentArtifacts<T extends Pick<Artifact, 'kind' | 'createdAt'>>(artifacts: T[]): T[] {
  return artifactsNewestFirst(artifacts.filter(artifact => !isPullRequestArtifact(artifact.kind)))
}

/** External document link. Pull requests are resolved separately. */
export function artifactExternalUrl(artifact: Pick<Artifact, 'kind' | 'data'>): string | null {
  if (artifact.kind !== 'url' && artifact.kind !== 'pr-link') return null
  const url = artifact.data['url']
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Prose a non-file artefact can show instead of its raw payload. */
export function artifactSummaryText(artifact: Pick<Artifact, 'data'>): string | null {
  const summary = artifact.data['summary']
  if (typeof summary !== 'string') return null
  const trimmed = summary.trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface LinkedPullRequest {
  artifactId: string
  prId: number | null
  /** Full pull-request title when the agent recorded one. */
  title: string
  url: string
  workItem: string
}

/**
 * Opened pull requests (`pr-link` with a url), assigned to a work item.
 * There is no artifact.workItem field. Preference is the agent's own
 * `data.workItem` on the matching preview, then a work-item name written
 * in the title, then `prMappings`, then the work item that was current
 * when the artefact was posted (`createdBy`).
 */
export function linkPullRequests(input: {
  artifacts?: Artifact[]
  workItems?: Pick<WorkItem, 'name'>[]
  prMappings?: PrMapping[]
}): LinkedPullRequest[] {
  const artifacts = input.artifacts ?? []
  const names = (input.workItems ?? []).map(item => item.name).filter(name => name.length > 0)
  const mappings = input.prMappings ?? []
  const previews = artifacts.filter(artifact => artifact.kind === 'pr-preview')
  const linked: LinkedPullRequest[] = []

  for (const artifact of artifacts) {
    if (artifact.kind !== 'pr-link') continue
    const url = artifactExternalUrl(artifact)
    if (!url) continue
    const workItem = assignPullRequest(artifact, previews, names, mappings)
    if (!workItem) continue
    linked.push({
      artifactId: artifact.id,
      prId: numericId(artifact.data['prId']),
      title: pullRequestTitle(artifact),
      url,
      workItem,
    })
  }

  const order = new Map(names.map((name, index) => [name, index]))
  return linked.sort((left, right) => {
    const byItem = (order.get(left.workItem) ?? names.length) - (order.get(right.workItem) ?? names.length)
    if (byItem !== 0) return byItem
    return (left.prId ?? Number.MAX_SAFE_INTEGER) - (right.prId ?? Number.MAX_SAFE_INTEGER)
  })
}

function pullRequestTitle(artifact: Artifact): string {
  const recorded = artifact.data['title']
  if (typeof recorded === 'string' && recorded.trim()) return recorded.trim()
  return artifact.title
}

function assignPullRequest(
  artifact: Artifact,
  previews: Artifact[],
  names: string[],
  mappings: PrMapping[],
): string | null {
  const explicit = textField(artifact.data, 'workItem')
  if (explicit && names.includes(explicit)) return explicit

  const recordedTitle = textField(artifact.data, 'title')
  if (recordedTitle) {
    for (let index = previews.length - 1; index >= 0; index -= 1) {
      const preview = previews[index]
      if (!preview || textField(preview.data, 'title') !== recordedTitle) continue
      const previewItem = textField(preview.data, 'workItem')
      if (previewItem && names.includes(previewItem)) return previewItem
    }
  }

  const named = longestNameIn(artifact.title, names) ?? (recordedTitle ? longestNameIn(recordedTitle, names) : null)
  if (named) return named

  const prId = numericId(artifact.data['prId'])
  const mapping = prId == null ? undefined : mappings.find(item => item.prId === prId)
  if (mapping && names.includes(mapping.workItem)) return mapping.workItem

  return createdByWorkItem(artifact.createdBy, names)
}

function createdByWorkItem(createdBy: string, names: string[]): string | null {
  const separator = createdBy.indexOf(':')
  if (separator < 0) return null
  const name = createdBy.slice(separator + 1)
  return names.includes(name) ? name : null
}

function longestNameIn(text: string, names: string[]): string | null {
  let match: string | null = null
  for (const name of names) {
    if (!name || !text.includes(name)) continue
    if (!match || name.length > match.length) match = name
  }
  return match
}

function textField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function numericId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

/**
 * Status comes from the work item itself. `currentWorkItem` only decides
 * which row is linked to the live console — it does not invent progress.
 */
export function describeWorkItem(
  item: Pick<WorkItem, 'name' | 'status'>,
  currentWorkItem: string | null,
): WorkItemPresentation {
  const current = currentWorkItem != null && item.name === currentWorkItem
  if (item.status === 'complete') return { label: 'Complete', current }
  if (item.status === 'escalated') return { label: 'Escalated', current }
  if (item.status === 'in-progress' || current) return { label: 'Active', current }
  return { label: 'Pending', current }
}
