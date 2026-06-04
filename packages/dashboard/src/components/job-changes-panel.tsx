import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitPullRequest, RefreshCw } from 'lucide-react'
import type { Job } from '../types'
import { fetchJobDiff, parseUnifiedDiff, type JobDiff } from '../lib/job-diff'
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

function readPrPreview(job: Job): PrPreview | null {
  // Prefer the most recent pr-preview artifact (one per work item / PR).
  const previews = (job.artifacts ?? []).filter(a => a.kind === 'pr-preview')
  const latest = previews[previews.length - 1]
  if (!latest) return null
  const d = latest.data as Record<string, unknown>
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined)
  return {
    title: str('title'),
    description: str('description'),
    base: str('base'),
    sourceBranch: str('sourceBranch'),
    workItem: str('workItem'),
  }
}

/**
 * The "Changes" surface for a run: the proposed PR (title + description) and
 * the live code diff the agent has produced in the cloned repo — visible
 * before any PR is opened on the SCM.
 */
export default function JobChangesPanel({ job, live }: JobChangesPanelProps) {
  const [diff, setDiff] = useState<JobDiff | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)

  const preview = useMemo(() => readPrPreview(job), [job])

  const load = useCallback(
    async (manual: boolean) => {
      if (inFlight.current) return
      inFlight.current = true
      if (manual) setRefreshing(true)
      try {
        const data = await fetchJobDiff(job.id)
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
    [job.id],
  )

  useEffect(() => {
    void load(false)
    if (!live) return
    const id = window.setInterval(() => void load(false), POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [load, live])

  const files = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff?.patch])

  return (
    <div className="space-y-5">
      {preview ? <PrPreviewCard preview={preview} /> : null}

      <Card>
        <CardHeader className="gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Changes</CardTitle>
            <CardDescription>
              {diff && diff.files.length > 0 ? (
                <>
                  <span className="font-mono">{diff.stats.files}</span> file{diff.stats.files === 1 ? '' : 's'} changed
                  {diff.stats.insertions > 0 ? (
                    <span className="ml-2 text-success-400">+{diff.stats.insertions}</span>
                  ) : null}
                  {diff.stats.deletions > 0 ? (
                    <span className="ml-2 text-danger-400">−{diff.stats.deletions}</span>
                  ) : null}
                  <span className="ml-2 text-fg-subtle">vs {diff.base}</span>
                </>
              ) : (
                'Code the agent has written in the cloned repo, before any PR is opened.'
              )}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
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
    </div>
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
