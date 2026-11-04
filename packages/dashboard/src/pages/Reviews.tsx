import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  CircleDollarSign,
  ExternalLink,
  GitPullRequest,
  GitPullRequestArrow,
  Hourglass,
  Search,
  ShieldAlert,
} from 'lucide-react'
import PageHeader from '../components/common/page-header'
import EmptyState from '../components/common/empty-state'
import ErrorState from '../components/common/error-state'
import StatCard from '../components/common/stat-card'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Input } from '../components/ui/input'
import SegmentedControl from '../components/ui/segmented-control'
import { Skeleton } from '../components/ui/skeleton'
import EngineStatusStrip from '../components/reviews/engine-status-strip'
import NoticeBanner, { type Notice } from '../components/reviews/notice-banner'
import StartReviewDialog from '../components/reviews/start-review-dialog'
import { ReviewStatusBadge, SeverityCounts } from '../components/reviews/review-badges'
import { ReviewActionsMenu, useReviewActions } from '../components/reviews/review-actions'
import { useReviewEngine, useReviews } from '../hooks/useReviews'
import { formatRelativeTime } from '../lib/format'
import {
  REVIEWS_PATH,
  countBySeverity,
  formatReviewCost,
  isActiveReview,
  needsAttention,
  openFindings,
  prNumberLabel,
  reviewStatusMeta,
  scmLabel,
  type PrReview,
} from '../lib/reviews'

type ViewFilter = 'open' | 'attention' | 'held' | 'closed' | 'all'

const VIEW_FILTERS: Array<{ value: ViewFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'attention', label: 'Needs you' },
  { value: 'held', label: 'Paused & skipped' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]

function parseView(raw: string | null): ViewFilter {
  return VIEW_FILTERS.some(option => option.value === raw) ? (raw as ViewFilter) : 'open'
}

function matchesView(review: PrReview, view: ViewFilter): boolean {
  switch (view) {
    case 'open':
      return review.status !== 'done' && review.status !== 'skipped'
    case 'attention':
      return needsAttention(review)
    case 'held':
      return review.status === 'paused' || review.status === 'skipped'
    case 'closed':
      return review.status === 'done'
    case 'all':
      return true
  }
}

/** Reviews that need the developer float to the top, then live ones, then newest. */
function rank(review: PrReview): number {
  if (review.pendingVerdict) return 0
  if (needsAttention(review)) return 1
  if (isActiveReview(review)) return 2
  if (review.status === 'idle') return 3
  if (review.status === 'paused') return 4
  return 5
}

export default function Reviews() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { reviews, loading, error, refetch, setReviews } = useReviews()
  const engine = useReviewEngine()
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [starting, setStarting] = useState(false)
  const view = parseView(searchParams.get('view'))
  const dismissNotice = useCallback(() => setNotice(null), [])

  const setView = (next: ViewFilter) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'open') params.delete('view')
    else params.set('view', next)
    setSearchParams(params, { replace: true })
  }

  const visible = useMemo(() => {
    const search = query.trim().toLowerCase()
    return reviews
      .filter(review => matchesView(review, view))
      .filter(review => {
        if (!search) return true
        return [review.pr.title, review.pr.author, prNumberLabel(review), review.pr.url, ...(review.pr.labels ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(search)
      })
      .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }, [reviews, view, query])

  const today = new Date().toISOString().slice(0, 10)
  const stats = useMemo(() => {
    const attention = reviews.filter(needsAttention).length
    const verdicts = reviews.filter(review => review.pendingVerdict).length
    const active = reviews.filter(isActiveReview).length
    const watching = reviews.filter(review => review.status === 'idle').length
    const blockers = reviews
      .filter(review => review.status !== 'done')
      .reduce((sum, review) => sum + openFindings(review).filter(finding => finding.severity === 'blocker').length, 0)
    const spentToday = reviews.reduce((sum, review) => sum + (review.spendDay?.day === today ? review.spendDay.usd : 0), 0)
    const spentTotal = reviews.reduce((sum, review) => sum + review.totals.costUsd, 0)
    return { attention, verdicts, active, watching, blockers, spentToday, spentTotal }
  }, [reviews, today])

  const counts = useMemo(() => {
    const out = {} as Record<ViewFilter, number>
    for (const option of VIEW_FILTERS) out[option.value] = reviews.filter(review => matchesView(review, option.value)).length
    return out
  }, [reviews])

  const replaceRow = (updated: PrReview) => setReviews(rows => rows.map(row => (row.id === updated.id ? updated : row)))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reviews"
        description="Pull requests Coro reviews for you. It posts comments, holds approvals for your call, and never merges."
        actions={
          <Button onClick={() => setStarting(true)}>
            <GitPullRequestArrow />
            Review a pull request
          </Button>
        }
      />

      <EngineStatusStrip
        status={engine.status}
        error={engine.error}
        onPolled={status => {
          engine.setStatus(status)
          void refetch()
        }}
        onNotice={setNotice}
      />

      <NoticeBanner notice={notice} onDismiss={dismissNotice} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Needs you"
          value={String(stats.attention)}
          description={stats.verdicts ? `${stats.verdicts} verdict${stats.verdicts === 1 ? '' : 's'} waiting for your call` : 'Verdicts, failures, and budget holds'}
          icon={Hourglass}
          tone={stats.attention ? 'warning' : 'neutral'}
        />
        <StatCard
          label="In progress"
          value={String(stats.active)}
          description={stats.watching ? `${stats.watching} more watched for new commits` : 'Queued or reviewing right now'}
          icon={GitPullRequest}
          tone={stats.active ? 'accent' : 'neutral'}
        />
        <StatCard
          label="Open blockers"
          value={String(stats.blockers)}
          description="Across pull requests that are still open"
          icon={ShieldAlert}
          tone={stats.blockers ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Spend today"
          value={formatReviewCost(stats.spentToday)}
          description={`${formatReviewCost(stats.spentTotal)} across all reviews`}
          icon={CircleDollarSign}
        />
      </div>

      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-4 lg:flex-row lg:items-center lg:justify-between">
          <SegmentedControl<ViewFilter>
            options={VIEW_FILTERS.map(option => ({ ...option, label: `${option.label} ${counts[option.value] ?? 0}` }))}
            value={view}
            onChange={setView}
            size="sm"
            ariaLabel="Filter reviews"
          />
          <div className="relative w-full lg:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search title, repo, author, label"
              className="h-9 pl-9 text-[13px]"
            />
          </div>
        </div>

        <CardContent className="p-0">
          {error ? (
            <div className="p-4">
              <ErrorState title="Could not load reviews" message={error} />
            </div>
          ) : loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-16 w-full" />)}
            </div>
          ) : visible.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={GitPullRequest}
                title={reviews.length === 0 ? 'No reviews yet' : 'Nothing in this view'}
                description={
                  reviews.length === 0
                    ? 'Ask Coro to review a pull request, or turn reviews on so it picks up requests where you are a reviewer.'
                    : 'Try another filter or clear the search.'
                }
                action={
                  reviews.length === 0 ? (
                    <Button onClick={() => setStarting(true)}>Review a pull request</Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
                    <th className="px-4 py-3 font-medium">Pull request</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Open findings</th>
                    <th className="px-4 py-3 text-right font-medium">Rounds</th>
                    <th className="px-4 py-3 font-medium">Updated</th>
                    <th className="px-4 py-3 text-right font-medium">Cost</th>
                    <th className="px-2 py-3" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {visible.map(review => (
                    <ReviewRow
                      key={review.id}
                      review={review}
                      onUpdated={replaceRow}
                      onDeleted={() => setReviews(rows => rows.filter(row => row.id !== review.id))}
                      onNotice={setNotice}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <StartReviewDialog
        open={starting}
        onOpenChange={setStarting}
        onStarted={review => {
          void refetch()
          navigate(`${REVIEWS_PATH}/${encodeURIComponent(review.id)}`)
        }}
      />
    </div>
  )
}

interface ReviewRowProps {
  review: PrReview
  onUpdated: (review: PrReview) => void
  onDeleted: () => void
  onNotice: (notice: Notice) => void
}

function ReviewRow({ review, onUpdated, onDeleted, onNotice }: ReviewRowProps) {
  const actions = useReviewActions(
    review,
    result => (result.kind === 'updated' ? onUpdated(result.review) : onDeleted()),
    onNotice,
  )
  const meta = reviewStatusMeta(review)
  const href = `${REVIEWS_PATH}/${encodeURIComponent(review.id)}`

  return (
    <tr className="group transition-colors hover:bg-overlay/40">
      <td className="px-4 py-3">
        <Link to={href} className="block min-w-0 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-fg group-hover:text-accent-300">
              {review.pr.title || prNumberLabel(review)}
            </span>
            {review.pr.draft ? (
              <span className="rounded-md border border-line bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                Draft
              </span>
            ) : null}
          </div>
          <div className="truncate text-[12px] text-fg-subtle">
            {[prNumberLabel(review), review.pr.author ? `by ${review.pr.author}` : undefined, scmLabel(review.prRef.pluginId)]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </Link>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="space-y-1">
          <ReviewStatusBadge review={review} />
          {meta.detail ? <div className="text-[11px] text-fg-subtle">{meta.detail}</div> : null}
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <SeverityCounts counts={countBySeverity(openFindings(review))} />
      </td>
      <td className="px-4 py-3 text-right align-top tabular-nums text-fg-muted">{review.totals.rounds}</td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-[13px] text-fg-muted">{formatRelativeTime(review.updatedAt)}</td>
      <td className="whitespace-nowrap px-4 py-3 text-right align-top tabular-nums text-fg-muted">
        {formatReviewCost(review.totals.costUsd)}
      </td>
      <td className="px-2 py-2.5 align-top">
        <div className="flex items-center justify-end gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
          {review.pr.url ? (
            <Button variant="ghost" size="icon" className="size-8" asChild>
              <a href={review.pr.url} target="_blank" rel="noreferrer" aria-label={`Open ${prNumberLabel(review)} on ${scmLabel(review.prRef.pluginId)}`}>
                <ExternalLink />
              </a>
            </Button>
          ) : null}
          <ReviewActionsMenu review={review} actions={actions} />
        </div>
      </td>
    </tr>
  )
}
