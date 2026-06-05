import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, FolderOpen, GitPullRequest, RefreshCw } from 'lucide-react'
import type { Job } from '../types'
import { fetchJobDiff, parseUnifiedDiff, type JobDiff } from '../lib/job-diff'
import { fetchEditors, openJobWorkspace, type EditorInfo } from '../lib/open-workspace'
import { EditorIcon } from './editor-icon'
import DiffView from './diff-view'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Badge, type badgeVariants } from './ui/badge'
import type { VariantProps } from 'class-variance-authority'
import ErrorState from './common/error-state'
import { renderInlineMarkdown } from './intelligence/markdown-mini'
import { cn } from '../lib/utils'

const POLL_INTERVAL_MS = 4000

export interface JobChangesPanelProps {
  job: Job
  /** When true (job not terminal), poll for new changes. */
  live: boolean
}

interface PrPreview {
  title?: string
  description?: string
  base?: string
  sourceBranch?: string
  workItem?: string
}

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

interface PrStatus {
  label: string
  variant: BadgeVariant
  prUrl?: string
}

function readPrPreviews(job: Job): PrPreview[] {
  const out: PrPreview[] = []
  const byBranch = new Map<string, number>()
  for (const a of job.artifacts ?? []) {
    if (a.kind !== 'pr-preview') continue
    const d = a.data as Record<string, unknown>
    const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined)
    const preview: PrPreview = {
      title: str('title'),
      description: str('description'),
      base: str('base'),
      sourceBranch: str('sourceBranch'),
      workItem: str('workItem'),
    }
    const key = preview.sourceBranch
    if (key && byBranch.has(key)) {
      out[byBranch.get(key)!] = preview
    } else {
      if (key) byBranch.set(key, out.length)
      out.push(preview)
    }
  }
  return out
}

function findPrLink(job: Job, preview: PrPreview): { url?: string; prId?: number } | undefined {
  if (!preview.title) return undefined
  for (const a of job.artifacts ?? []) {
    if (a.kind !== 'pr-link') continue
    const d = a.data as Record<string, unknown>
    if (d.title !== preview.title) continue
    const url = typeof d.url === 'string' ? d.url : undefined
    const rawId = d.prId
    const prId =
      typeof rawId === 'number' ? rawId : typeof rawId === 'string' && rawId.trim() ? Number(rawId) : undefined
    return { url, prId: Number.isFinite(prId) ? prId : undefined }
  }
  return undefined
}

/** Per-preview status (supports multiple stacked PRs on one work item). */
function derivePrStatus(preview: PrPreview, job: Job): PrStatus {
  const wi = preview.workItem
  const workItem = wi ? job.workItems?.find(w => w.name === wi) : undefined
  const link = findPrLink(job, preview)
  const prUrl = link?.url
  const mapping =
    link?.prId != null ? job.prMappings?.find(m => m.prId === link.prId) : undefined

  if (workItem?.status === 'escalated') {
    return { label: 'Escalated', variant: 'danger', prUrl }
  }
  if (mapping?.mergedAt) {
    return { label: 'Merged', variant: 'success', prUrl }
  }
  if (mapping && !mapping.mergedAt) {
    return { label: 'PR open', variant: 'accent', prUrl }
  }
  if (workItem?.status === 'complete') {
    return { label: 'Merged', variant: 'success', prUrl }
  }
  if (wi && wi === job.currentWorkItem) {
    return { label: 'In progress', variant: 'warning', prUrl }
  }
  return { label: 'Awaiting review', variant: 'neutral', prUrl }
}

/** True when a preview still needs developer attention (not merged/escalated). */
export function hasActionablePrPreview(job: Job): boolean {
  return readPrPreviews(job).some(p => {
    const { label } = derivePrStatus(p, job)
    return label !== 'Merged' && label !== 'Escalated'
  })
}

function useJobDiff(
  jobId: string,
  opts: { base?: string; head?: string; live: boolean; enabled?: boolean },
) {
  const { base, head, live, enabled = true } = opts
  const [diff, setDiff] = useState<JobDiff | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)

  const load = useCallback(
    async (manual: boolean) => {
      if (inFlight.current) return
      inFlight.current = true
      if (manual) setRefreshing(true)
      try {
        const data = await fetchJobDiff(jobId, { base, head })
        setDiff(data)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load changes')
      } finally {
        inFlight.current = false
        setLoading(false)
        if (manual) setRefreshing(false)
      }
    },
    [jobId, base, head],
  )

  useEffect(() => {
    if (!enabled) return
    void load(false)
    if (!live) return
    const id = window.setInterval(() => void load(false), POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [load, live, enabled])

  return { diff, loading, error, refresh: () => load(true), refreshing }
}

export default function JobChangesPanel({ job, live }: JobChangesPanelProps) {
  const previews = useMemo(() => readPrPreviews(job), [job])
  const showWorkingNow = live || previews.length === 0

  return (
    <div className="space-y-6">
      <OpenWorkspaceBar jobId={job.id} />

      {showWorkingNow ? (
        <CurrentWorkSection jobId={job.id} live={live} workItem={job.currentWorkItem} />
      ) : null}

      {previews.length > 0 ? (
        <PullRequestsSection jobId={job.id} job={job} live={live} previews={previews} />
      ) : null}
    </div>
  )
}

function OpenWorkspaceBar({ jobId }: { jobId: string }) {
  const [editors, setEditors] = useState<EditorInfo[] | null>(null)
  const [isLocal, setIsLocal] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchEditors()
      .then(r => {
        if (!active) return
        setIsLocal(r.mode === 'local')
        setEditors(r.editors)
      })
      .catch(() => {
        if (active) setEditors([])
      })
    return () => {
      active = false
    }
  }, [])

  const open = useCallback(
    async (target: 'editor' | 'folder', editor?: string) => {
      const key = editor ?? target
      setBusy(key)
      setError(null)
      try {
        await openJobWorkspace(jobId, { target, editor })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open')
      } finally {
        setBusy(null)
      }
    },
    [jobId],
  )

  if (!isLocal) return null

  const hasEditors = (editors ?? []).length > 0

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasEditors ? <span className="text-xs text-fg-subtle">Open in</span> : null}
      {(editors ?? []).map(e => (
        <Button
          key={e.id}
          type="button"
          variant="secondary"
          size="icon"
          className="size-8"
          onClick={() => open('editor', e.id)}
          disabled={busy !== null}
          title={`Open in ${e.name}`}
          aria-label={`Open in ${e.name}`}
        >
          <EditorIcon id={e.id} />
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => open('folder')}
        disabled={busy !== null}
        title="Reveal folder in file manager"
        aria-label="Reveal folder in file manager"
      >
        <FolderOpen />
      </Button>
      {error ? <span className="text-xs text-danger-400">{error}</span> : null}
    </div>
  )
}

/** Live working-tree diff for whatever the agent is building right now. */
function CurrentWorkSection({
  jobId,
  live,
  workItem,
}: {
  jobId: string
  live: boolean
  workItem: string | null
}) {
  const { diff, loading, error, refresh, refreshing } = useJobDiff(jobId, { live })
  const files = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff?.patch])

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-fg">Working now</h3>
        {workItem ? (
          <p className="mt-0.5 text-xs text-fg-subtle">
            Work item: <span className="font-medium text-fg-muted">{workItem}</span>
            {' — '}live diff from the repo checkout (each PR below has its own branch diff).
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-fg-subtle">Live changes in the cloned repository.</p>
        )}
      </div>

      <Card>
        <CardHeader className="gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
          <CardDescription className="m-0">
            <DiffSummaryLine diff={diff} />
          </CardDescription>
          <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="pt-5">
          {loading && !diff ? (
            <div className="animate-pulse text-sm text-fg-subtle">Loading changes…</div>
          ) : error ? (
            <ErrorState title="Could not load changes" message={error} />
          ) : !diff || files.length === 0 ? (
            <EmptyChanges available={diff?.available ?? false} />
          ) : (
            <DiffView files={files} truncated={diff.truncated} />
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function PullRequestsSection({
  jobId,
  job,
  live,
  previews,
}: {
  jobId: string
  job: Job
  live: boolean
  previews: PrPreview[]
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-fg">Pull requests</h3>
        <p className="mt-0.5 text-xs text-fg-subtle">
          {previews.length} pull request{previews.length === 1 ? '' : 's'} — expand to review each
          branch&apos;s changes (including stacked PRs).
        </p>
      </div>
      <div className="space-y-3">
        {previews.map((preview, i) => (
          <WorkItemChanges
            key={preview.sourceBranch ?? `wi-${i}`}
            jobId={jobId}
            live={live}
            preview={preview}
            status={derivePrStatus(preview, job)}
          />
        ))}
      </div>
    </section>
  )
}

function WorkItemChanges({
  jobId,
  live,
  preview,
  status,
}: {
  jobId: string
  live: boolean
  preview: PrPreview
  status: PrStatus
}) {
  const [expanded, setExpanded] = useState(false)
  const { diff, loading, error, refresh, refreshing } = useJobDiff(jobId, {
    base: preview.base,
    head: preview.sourceBranch,
    live,
    enabled: expanded,
  })
  const files = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff?.patch])

  return (
    <Card className="border-line">
      <CardHeader className="gap-2 pb-3">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex w-full items-start gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="mt-1 size-4 shrink-0 text-fg-subtle" />
          ) : (
            <ChevronRight className="mt-1 size-4 shrink-0 text-fg-subtle" />
          )}
          <GitPullRequest className="mt-0.5 size-4 shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="truncate text-sm">
                {preview.title || preview.workItem || 'Pull request'}
              </CardTitle>
              <PrStatusBadge status={status} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
              {preview.workItem ? <Badge variant="neutral">{preview.workItem}</Badge> : null}
              {preview.sourceBranch ? (
                <Badge variant="neutral" className="font-mono normal-case tracking-normal">
                  {preview.sourceBranch}
                  {preview.base ? <span className="text-fg-subtle"> → {preview.base}</span> : null}
                </Badge>
              ) : null}
              {status.prUrl ? (
                <a
                  href={status.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-accent-300 hover:text-accent-200"
                >
                  View PR
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
              {expanded ? <DiffSummaryLine diff={diff} compact /> : null}
            </div>
          </div>
        </button>
      </CardHeader>
      {expanded ? (
        <CardContent className="space-y-4 border-t border-line pt-4">
          {preview.description ? (
            <div
              className="prose-coro space-y-2 text-sm leading-6 text-fg"
              dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(preview.description) }}
            />
          ) : null}
          {status.label === 'Merged' && (!diff || files.length === 0) ? (
            <p className="text-xs text-fg-subtle">
              This work item was merged. Expand showed no local diff — open the PR on the SCM for the final
              changes.
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
              Refresh
            </Button>
          </div>
          {loading && !diff ? (
            <div className="animate-pulse text-sm text-fg-subtle">Loading changes…</div>
          ) : error ? (
            <ErrorState title="Could not load changes" message={error} />
          ) : !diff || files.length === 0 ? (
            status.label !== 'Merged' ? <EmptyChanges available={diff?.available ?? false} /> : null
          ) : (
            <DiffView files={files} truncated={diff.truncated} defaultCollapsed />
          )}
        </CardContent>
      ) : null}
    </Card>
  )
}

function PrStatusBadge({ status }: { status: PrStatus }) {
  return <Badge variant={status.variant}>{status.label}</Badge>
}

function DiffSummaryLine({ diff, compact }: { diff: JobDiff | null; compact?: boolean }) {
  if (!diff || diff.files.length === 0) {
    if (compact) return null
    return <>Code the agent has written in the cloned repo, before any PR is opened.</>
  }
  return (
    <span className={cn(compact && 'text-fg-subtle')}>
      <span className="font-mono">{diff.stats.files}</span> file{diff.stats.files === 1 ? '' : 's'} changed
      {diff.stats.insertions > 0 ? <span className="ml-2 text-success-400">+{diff.stats.insertions}</span> : null}
      {diff.stats.deletions > 0 ? <span className="ml-2 text-danger-400">−{diff.stats.deletions}</span> : null}
      <span className="ml-2 text-fg-subtle">vs {diff.base}</span>
    </span>
  )
}

function EmptyChanges({ available }: { available: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-canvas/30 px-4 py-8 text-center text-sm text-fg-subtle">
      {available
        ? 'No changes yet. They will appear here as the agent edits files.'
        : 'No repository checkout yet. Changes appear once the agent clones the repo and starts coding.'}
    </div>
  )
}
