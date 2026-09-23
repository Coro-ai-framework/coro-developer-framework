import { useState, type ReactNode } from 'react'
import { ChevronDown, GitPullRequest } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Job } from '../../types'
import { getRepoSlug, getReviewers, getRunDetailPath } from '../../lib/jobs'
import {
  getParentRunBreadcrumbLabel,
  getParentRunId,
  getRunWorkflowTag,
} from '../../lib/run-labels'
import { cn } from '../../lib/utils'

/**
 * Run metadata beside the activity log. Collapsed by default so the work
 * list and console stay in view. Real context-budget details can land in
 * this body later without moving the panel.
 */
export default function RunContextPanel({ job }: { job: Job }) {
  const [open, setOpen] = useState(false)
  const reviewers = getReviewers(job)
  const repoSlug = getRepoSlug(job)
  const parentRunId = getParentRunId(job)
  const workflow = getRunWorkflowTag(job)
  const summary = repoSlug ?? workflow

  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: 'Workflow', value: workflow },
    { label: 'Phase', value: job.phase },
  ]
  if (repoSlug) rows.push({ label: 'Repository', value: repoSlug })
  if (reviewers.length > 0) rows.push({ label: 'Reviewers', value: reviewers.join(', ') })
  if (parentRunId) {
    rows.push({
      label: getParentRunBreadcrumbLabel(),
      value: (
        <Link
          to={getRunDetailPath({ id: parentRunId })}
          className="font-mono text-accent-300 hover:text-accent-400"
        >
          {parentRunId}
        </Link>
      ),
    })
  }
  if (job.prMappings && job.prMappings.length > 0) {
    rows.push({
      label: 'Pull requests',
      value: (
        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <GitPullRequest className="size-3.5" aria-hidden />
          {job.prMappings.length} mapping{job.prMappings.length === 1 ? '' : 's'}
        </span>
      ),
    })
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/85 shadow-[var(--shadow-card)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-overlay/40"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-fg">Context</span>
          <span className="block truncate text-[12px] text-fg-muted">{summary}</span>
        </span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-line px-4 py-3 text-sm">
          {rows.map(row => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{row.label}</span>
              <span className="min-w-0 text-right break-words text-fg">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
