import { describe, expect, it } from 'vitest'
import {
  artifactCategory,
  artifactExternalUrl,
  artifactFileLabel,
  artifactSummaryText,
  describeWorkItem,
  documentArtifacts,
  latestPhaseUsage,
  linkPullRequests,
} from '../src/lib/job-detail-presentation'
import type { Artifact, PhaseUsage } from '../src/types'

function usage(phase: string, model: string): PhaseUsage {
  return {
    phase,
    model,
    inputTokens: 10,
    outputTokens: 4,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.1,
    durationMs: 1000,
    durationApiMs: 800,
    numTurns: 2,
  }
}

describe('latestPhaseUsage', () => {
  it('returns the last execution when a phase repeats', () => {
    const first = usage('coding', 'claude-sonnet')
    const second = usage('coding', 'claude-opus')
    const other = usage('review', 'claude-haiku')
    expect(latestPhaseUsage([first, other, second], 'coding')).toBe(second)
  })

  it('ignores other phases and missing history', () => {
    expect(latestPhaseUsage(undefined, 'coding')).toBeUndefined()
    expect(latestPhaseUsage([], 'coding')).toBeUndefined()
    expect(latestPhaseUsage([usage('planning', 'claude-sonnet')], 'coding')).toBeUndefined()
  })
})

describe('artifact presentation', () => {
  it('uses the filename and falls back to the title', () => {
    expect(artifactFileLabel({
      title: 'Implementation plan',
      data: { path: 'artifacts/planning/plan.md' },
    })).toBe('plan.md')
    expect(artifactFileLabel({
      title: 'Scratch notes',
      data: { path: '   ' },
    })).toBe('Scratch notes')
    expect(artifactFileLabel({
      title: 'Raw result',
      data: {},
    })).toBe('Raw result')
  })

  it('maps known kinds and leaves unknown structured data as data', () => {
    expect(artifactCategory('implementation-plan-md')).toBe('plan')
    expect(artifactCategory('spec-md')).toBe('spec')
    expect(artifactCategory('evaluation-md')).toBe('report')
    expect(artifactCategory('test-results')).toBe('report')
    expect(artifactCategory('analysis-contract')).toBe('analysis')
    expect(artifactCategory('pr-link')).toBe('pull-request')
    expect(artifactCategory('pr-preview')).toBe('pull-request')
    expect(artifactCategory('url')).toBe('link')
    expect(artifactCategory('notes-md')).toBe('markdown')
    expect(artifactCategory('mystery-json')).toBe('data')
  })
})

function artifact(partial: Partial<Artifact> & Pick<Artifact, 'id' | 'kind' | 'title'>): Artifact {
  return {
    phase: 'review',
    data: {},
    createdBy: 'review',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

describe('document artifacts', () => {
  it('drops pull requests and keeps every other kind, newest first', () => {
    const older = artifact({ id: 'a', kind: 'register', title: 'Register', createdAt: '2026-01-01T00:00:00.000Z' })
    const link = artifact({ id: 'b', kind: 'pr-link', title: 'PR #1', data: { url: 'https://example.com/1' } })
    const preview = artifact({ id: 'c', kind: 'pr-preview', title: 'Draft' })
    const newer = artifact({
      id: 'd',
      kind: 'review-summary',
      title: 'Gate',
      createdAt: '2026-02-01T00:00:00.000Z',
      data: { summary: 'Merged cleanly.' },
    })
    expect(documentArtifacts([older, link, preview, newer]).map(item => item.id)).toEqual(['d', 'a'])
    expect(artifactExternalUrl(link)).toBe('https://example.com/1')
    expect(artifactExternalUrl(artifact({
      id: 'u',
      kind: 'url',
      title: 'Notes',
      data: { url: ' https://example.com/notes ' },
    }))).toBe('https://example.com/notes')
    expect(artifactSummaryText(newer)).toBe('Merged cleanly.')
  })
})

describe('linkPullRequests', () => {
  const names = [{ name: 'governance-and-helm-docs' }, { name: 's2s-per-group-mode-map' }]

  it('uses the preview work item when the mapping names a different item', () => {
    const preview = artifact({
      id: 'preview',
      kind: 'pr-preview',
      title: 'short',
      createdBy: 'coding:s2s-per-group-mode-map',
      data: {
        title: 'Address review of PR 27',
        workItem: 'governance-and-helm-docs',
      },
    })
    const link = artifact({
      id: 'link',
      kind: 'pr-link',
      title: 'PR #28: governance-and-helm-docs',
      createdBy: 'review:s2s-per-group-mode-map',
      data: {
        title: 'Address review of PR 27',
        url: 'https://github.com/acme/repo/pull/28',
        prId: 28,
      },
    })
    expect(linkPullRequests({
      artifacts: [preview, link],
      workItems: names,
      prMappings: [{ prId: 28, workItem: 's2s-per-group-mode-map', repoSlug: 'acme/repo', openedAt: '2026-01-01T00:00:00.000Z' }],
    })).toEqual([{
      artifactId: 'link',
      prId: 28,
      title: 'Address review of PR 27',
      url: 'https://github.com/acme/repo/pull/28',
      workItem: 'governance-and-helm-docs',
    }])
  })

  it('ignores drafts and links that match no work item', () => {
    const draft = artifact({ id: 'draft', kind: 'pr-preview', title: 'Draft', data: { workItem: 'governance-and-helm-docs' } })
    const orphan = artifact({
      id: 'orphan',
      kind: 'pr-link',
      title: 'PR #9',
      data: { url: 'https://github.com/acme/repo/pull/9', prId: 9, title: 'Unrelated change' },
    })
    expect(linkPullRequests({ artifacts: [draft, orphan], workItems: names })).toEqual([])
  })
})

describe('describeWorkItem', () => {
  it('keeps source status and marks only the current item', () => {
    expect(describeWorkItem({ name: 'api', status: 'pending' }, null)).toEqual({
      label: 'Pending',
      current: false,
    })
    expect(describeWorkItem({ name: 'api', status: 'pending' }, 'api')).toEqual({
      label: 'Active',
      current: true,
    })
    expect(describeWorkItem({ name: 'api', status: 'in-progress' }, 'docs')).toEqual({
      label: 'Active',
      current: false,
    })
    expect(describeWorkItem({ name: 'api', status: 'complete' }, 'api')).toEqual({
      label: 'Complete',
      current: true,
    })
    expect(describeWorkItem({ name: 'api', status: 'escalated' }, 'docs')).toEqual({
      label: 'Escalated',
      current: false,
    })
  })
})
