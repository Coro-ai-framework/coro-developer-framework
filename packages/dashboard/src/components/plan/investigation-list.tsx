import { useState } from 'react'
import { X } from 'lucide-react'
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
  onRemove,
  busy,
  disabled,
  revealRemoveOnHover = true,
}: {
  rows: InvestigationSummary[]
  currentId: string
  loading: boolean
  loadingMore: boolean
  total: number
  onSelect: (id: string) => void
  onLoadMore: () => void
  onRemove: (id: string) => void | Promise<void>
  busy?: boolean
  disabled?: boolean
  /** Desktop rail hides the control until hover; dialogs keep it visible. */
  revealRemoveOnHover?: boolean
}) {
  const hasMore = rows.length < total
  const [pendingId, setPendingId] = useState<string | null>(null)

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

  async function handleRemove(row: InvestigationSummary) {
    const label = row.title.trim() || 'this conversation'
    const ok = window.confirm(
      busy && row.id === currentId
        ? `Coro is still working. Remove “${label}” from history?`
        : `Remove “${label}” from history?`,
    )
    if (!ok) return
    setPendingId(row.id)
    try {
      await onRemove(row.id)
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-1 pr-2">
          {rows.map(row => {
            const active = row.id === currentId
            const removing = pendingId === row.id
            return (
              <li key={row.id}>
                <div
                  className={cn(
                    'group relative flex rounded-xl border transition-colors',
                    active
                      ? 'border-accent-500/30 bg-accent-500/10'
                      : 'border-transparent bg-transparent hover:border-line hover:bg-overlay/60',
                    (disabled || removing) && 'opacity-60',
                  )}
                >
                  {active ? (
                    <span
                      className="absolute left-0 top-2.5 h-4 w-0.5 rounded-full bg-accent-400"
                      aria-hidden
                    />
                  ) : null}
                  <button
                    type="button"
                    disabled={disabled || removing}
                    onClick={() => onSelect(row.id)}
                    className="flex min-w-0 flex-1 flex-col gap-1.5 py-2.5 pl-3 pr-8 text-left"
                  >
                    <span className={cn('line-clamp-2 text-[13px] font-medium leading-5', active ? 'text-fg' : 'text-fg-muted')}>
                      {row.title || 'Draft'}
                    </span>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-fg-subtle">{formatRelativeTime(row.updatedAt)}</span>
                      {statusBadge(row)}
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={disabled || removing}
                    onClick={() => void handleRemove(row)}
                    className={cn(
                      'absolute right-1.5 top-1.5 rounded-full p-0.5 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg',
                      revealRemoveOnHover
                        ? 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'
                        : 'opacity-70 hover:opacity-100',
                    )}
                    aria-label={`Remove ${row.title || 'conversation'}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
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
