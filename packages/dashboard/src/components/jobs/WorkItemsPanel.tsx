import { useState } from 'react'
import { AlertTriangle, Check, ChevronRight, ExternalLink, GitPullRequest } from 'lucide-react'
import type { Job, WorkItem } from '../../types'
import {
  describeWorkItem,
  linkPullRequests,
  type LinkedPullRequest,
  type WorkItemLabel,
} from '../../lib/job-detail-presentation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { cn } from '../../lib/utils'

function retryLabel(loopCount: number): string {
  return `${loopCount} ${loopCount === 1 ? 'retry' : 'retries'}`
}

function StatusMark({ status, label }: { status: WorkItem['status']; label: WorkItemLabel }) {
  if (status === 'complete') {
    return <Check className="size-3.5 shrink-0 text-success-400" strokeWidth={2.5} aria-hidden />
  }
  if (status === 'escalated') {
    return <AlertTriangle className="size-3.5 shrink-0 text-danger-400" aria-hidden />
  }
  if (label === 'Active') {
    return (
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full bg-accent-400',
          status === 'in-progress' && 'animate-pulse-dot',
        )}
        aria-hidden
      />
    )
  }
  return <span className="size-1.5 shrink-0 rounded-full border border-fg-subtle/70" aria-hidden />
}

function prLabel(pullRequest: LinkedPullRequest): string {
  const number = pullRequest.prId != null ? `#${pullRequest.prId}: ` : ''
  const merged = pullRequest.merged ? ', merged' : ''
  return `Pull request ${number}${pullRequest.title}${merged}`
}

function PullRequestMark({ merged }: { merged: boolean }) {
  return (
    <span className="relative inline-flex">
      <GitPullRequest className="size-3.5" aria-hidden />
      {merged ? (
        <Check
          className="absolute -bottom-1 -left-1 size-2 rounded-full bg-panel text-success-400"
          strokeWidth={3.5}
          aria-hidden
        />
      ) : null}
    </span>
  )
}

export default function WorkItemsPanel({ job }: { job: Job }) {
  const items = job.workItems ?? []
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  if (items.length === 0) return null

  const pullRequests = linkPullRequests(job)
  const byItem = new Map<string, LinkedPullRequest[]>()
  for (const pullRequest of pullRequests) {
    const list = byItem.get(pullRequest.workItem) ?? []
    list.push(pullRequest)
    byItem.set(pullRequest.workItem, list)
  }

  return (
    <Card>
      <CardHeader className="gap-1 px-4 py-3">
        <CardTitle className="text-sm">Work items</CardTitle>
        <CardDescription className="truncate">
          {`${items.length} ${items.length === 1 ? 'item' : 'items'}${
            job.currentWorkItem ? ` · now ${job.currentWorkItem}` : ''
          }`}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-3 pt-0 pb-3">
        <ul className="space-y-1.5">
          {items.map(item => {
            const presentation = describeWorkItem(item, job.currentWorkItem)
            const itemPullRequests = byItem.get(item.name) ?? []
            const open = expanded.has(item.name)
            return (
              <li
                key={item.name}
                aria-current={presentation.current ? 'step' : undefined}
                className={cn(
                  'rounded-xl border',
                  presentation.current
                    ? 'border-accent-500/35 bg-accent-500/10'
                    : 'border-line bg-overlay/30',
                )}
              >
                <div className="flex min-w-0 items-center gap-1 px-1.5 py-1.5">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => {
                      setExpanded(current => {
                        const next = new Set(current)
                        if (next.has(item.name)) next.delete(item.name)
                        else next.add(item.name)
                        return next
                      })
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
                  >
                    <ChevronRight
                      className={cn('size-3.5 shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')}
                      aria-hidden
                    />
                    <StatusMark status={item.status} label={presentation.label} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg" title={item.name}>
                        {item.name}
                      </span>
                      <span className="block text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                        {presentation.label}
                        {item.loopCount > 0 ? (
                          <span className="ml-1.5 normal-case tracking-normal text-fg-muted">
                            · {retryLabel(item.loopCount)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  {open || itemPullRequests.length === 0 ? null : (
                    <span className="flex shrink-0 items-center gap-0.5 pr-0.5">
                      {itemPullRequests.map(pullRequest => (
                        <a
                          key={pullRequest.artifactId}
                          href={pullRequest.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={pullRequest.title}
                          aria-label={prLabel(pullRequest)}
                          className="inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-overlay hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
                        >
                          <PullRequestMark merged={pullRequest.merged} />
                        </a>
                      ))}
                    </span>
                  )}
                </div>
                {open ? (
                  itemPullRequests.length === 0 ? (
                    <p className="px-3 pb-2.5 text-[11px] text-fg-subtle">No pull requests</p>
                  ) : (
                    <ul className="space-y-1 px-2 pb-2">
                      {itemPullRequests.map(pullRequest => (
                        <li key={pullRequest.artifactId}>
                          <a
                            href={pullRequest.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[12px] leading-snug text-fg hover:bg-overlay/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
                          >
                            <span className="mt-0.5 shrink-0 text-fg-muted">
                              <PullRequestMark merged={pullRequest.merged} />
                            </span>
                            <span className="min-w-0 flex-1 break-words">
                              {pullRequest.prId != null ? (
                                <span className="mr-1.5 font-mono text-fg-subtle">#{pullRequest.prId}</span>
                              ) : null}
                              {pullRequest.title}
                            </span>
                            <ExternalLink className="mt-0.5 size-3 shrink-0 text-fg-subtle" aria-hidden />
                          </a>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
