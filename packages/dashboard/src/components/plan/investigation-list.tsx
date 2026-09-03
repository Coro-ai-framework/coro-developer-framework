import { formatRelativeTime } from '../../lib/format'
import type { InvestigationSummary } from '../../lib/intake-investigation'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { Skeleton } from '../ui/skeleton'
import { cn } from '../../lib/utils'

function statusBadge(row: InvestigationSummary) {
  if (row.status === 'dispatched') {
    return <Badge variant="success">Dispatched</Badge>
  }
  if (row.status === 'closed') {
    return <Badge variant="neutral">Closed</Badge>
  }
  if (row.readiness?.state === 'ready') {
    return <Badge variant="accent">Ready</Badge>
  }
  if (row.readiness?.state === 'no-run-needed') {
    return <Badge variant="neutral">No run</Badge>
  }
  if (row.readiness?.state === 'investigating') {
    return <Badge variant="warning">Open</Badge>
  }
  return <Badge variant="neutral">Active</Badge>
}

export function InvestigationList({
  rows,
  currentId,
  loading,
  loadingMore,
  total,
  onSelect,
  onLoadMore,
  disabled,
}: {
  rows: InvestigationSummary[]
  currentId: string
  loading: boolean
  loadingMore: boolean
  total: number
  onSelect: (id: string) => void
  onLoadMore: () => void
  disabled?: boolean
}) {
  const hasMore = rows.length < total

  if (loading) {
    return (
      <div className="space-y-2 p-1">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="px-1 py-6 text-[13px] leading-5 text-fg-muted">
        Conversations you start will show up here. New conversation keeps this one in the list.
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-1 pr-2">
          {rows.map(row => {
            const active = row.id === currentId
            return (
              <li key={row.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(row.id)}
                  className={cn(
                    'group flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                    active
                      ? 'border-accent-500/30 bg-accent-500/10'
                      : 'border-transparent bg-transparent hover:border-line hover:bg-overlay/60',
                    disabled && 'opacity-60',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={cn('line-clamp-2 text-[13px] font-medium leading-5', active ? 'text-fg' : 'text-fg-muted')}>
                      {row.title || 'Draft'}
                    </span>
                    {active ? (
                      <span className="mt-1 h-4 w-0.5 shrink-0 rounded-full bg-accent-400" aria-hidden />
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-fg-subtle">{formatRelativeTime(row.updatedAt)}</span>
                    {statusBadge(row)}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </ScrollArea>
      {hasMore ? (
        <Button
          type="button"
          variant="ghost"
          className="mt-2 w-full"
          disabled={loadingMore || disabled}
          onClick={onLoadMore}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  )
}
