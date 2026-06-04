import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, GitPullRequest, RefreshCw } from 'lucide-react'
import type { Job } from '../types'
import { fetchJobDiff, parseUnifiedDiff, type JobDiff } from '../lib/job-diff'
import { fetchEditors, openJobWorkspace, type EditorInfo } from '../lib/open-workspace'
import { EditorIcon } from './editor-icon'
import DiffView from './diff-view'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
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

/**
 * Collect the job's `pr-preview` artifacts, one per intended PR / work item.
 * Deduped by source branch (latest re-post wins, original position preserved)
 * so re-running the coder for a work item updates rather than duplicates it.
 */
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

/** Shared diff fetch + poll. Only fetches while `enabled` (lets collapsed sections stay idle). */
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

/**
 * The "Changes" surface for a run: the proposed PR(s) and the live code diff the
 * agent has produced in the cloned repo — visible before any PR is opened on the
 * SCM. With multiple in-flight previews (coder over-run) it groups changes per
 * work item; otherwise it shows the single live working-tree diff.
 */
export default function JobChangesPanel({ job, live }: JobChangesPanelProps) {
  const previews = useMemo(() => readPrPreviews(job), [job])
  const grouped = previews.length >= 2

  return (
    <div className="space-y-5">
      <OpenWorkspaceBar jobId={job.id} />
      {grouped ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-subtle">
            This run prepared <span className="font-medium text-fg">{previews.length}</span> pull requests. Each
            work item is shown separately below — expand one to review its changes.
          </p>
          {previews.map((preview, i) => (
            <WorkItemChanges
              key={preview.sourceBranch ?? `wi-${i}`}
              jobId={job.id}
              live={live}
              preview={preview}
              index={i}
            />
          ))}
        </div>
      ) : (
        <>
          {previews[0] ? <PrPreviewCard preview={previews[0]} /> : null}
          <ChangesCard jobId={job.id} live={live} />
        </>
      )}
    </div>
  )
}

/**
 * "Open in VS Code / Cursor" + "Reveal folder" bar. Local-mode only — the
 * runner reports which editors it can actually launch (empty in hybrid mode,
 * where the runner host is not the developer's desktop), and we hide the whole
 * bar when there is nothing we can open.
 */
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

/** Single live diff (working tree) — the common single-work-item view. */
function ChangesCard({ jobId, live }: { jobId: string; live: boolean }) {
  const { diff, loading, error, refresh, refreshing } = useJobDiff(jobId, { live })
  const files = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff?.patch])

  return (
    <Card>
      <CardHeader className="gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Changes</CardTitle>
          <CardDescription>
            <DiffSummaryLine diff={diff} />
          </CardDescription>
        </div>
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
  )
}

/**
 * A collapsible per-work-item section. The diff is fetched lazily (only once the
 * section is expanded) and scoped to the work item's pushed branch, so an
 * already-opened preview never bleeds into another's changes.
 */
function WorkItemChanges({
  jobId,
  live,
  preview,
  index,
}: {
  jobId: string
  live: boolean
  preview: PrPreview
  index: number
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
    <Card className="border-accent-500/20">
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
          <GitPullRequest className="mt-0.5 size-4 shrink-0 text-accent-300" />
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-sm">
              <span className="mr-2 text-fg-subtle">PR {index + 1}.</span>
              {preview.title || preview.workItem || 'Proposed pull request'}
            </CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
              {preview.sourceBranch ? (
                <Badge variant="neutral" className="font-mono">
                  {preview.sourceBranch}
                  {preview.base ? <span className="text-fg-subtle"> → {preview.base}</span> : null}
                </Badge>
              ) : null}
              {preview.workItem && preview.workItem !== preview.title ? (
                <Badge variant="neutral">{preview.workItem}</Badge>
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
            <EmptyChanges available={diff?.available ?? false} />
          ) : (
            <DiffView files={files} truncated={diff.truncated} defaultCollapsed />
          )}
        </CardContent>
      ) : null}
    </Card>
  )
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

function PrPreviewCard({ preview }: { preview: PrPreview }) {
  return (
    <Card className="border-accent-500/25 bg-accent-500/5">
      <CardHeader className="gap-2 border-b border-accent-500/15 pb-4">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg border border-accent-500/25 bg-accent-500/10 text-accent-300">
            <GitPullRequest className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{preview.title || 'Proposed pull request'}</CardTitle>
            <CardDescription>This is what Coro will open as a PR once you approve.</CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {preview.sourceBranch ? (
            <Badge variant="neutral" className="font-mono">
              {preview.sourceBranch}
              {preview.base ? <span className="text-fg-subtle"> → {preview.base}</span> : null}
            </Badge>
          ) : null}
          {preview.workItem ? <Badge variant="neutral">{preview.workItem}</Badge> : null}
        </div>
      </CardHeader>
      {preview.description ? (
        <CardContent className="pt-4">
          <div
            className="prose-coro space-y-2 text-sm leading-6 text-fg"
            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(preview.description) }}
          />
        </CardContent>
      ) : null}
    </Card>
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
