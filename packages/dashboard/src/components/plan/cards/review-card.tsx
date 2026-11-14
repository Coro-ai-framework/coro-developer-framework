import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { FileCheck2, GitPullRequest, Gavel, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import CardShell from '../../activity/cards/card-shell'
import type { CardRenderProps } from '../../activity/cards/types'
import { SeverityCounts } from '../../reviews/review-badges'
import { Button } from '../../ui/button'
import { useReview } from '../../../hooks/useReviews'
import { ApiError } from '../../../lib/http'
import { normalizePrUrl, type ReviewCardData } from '../../../lib/intake-review'
import {
  countBySeverity,
  latestRound,
  openFindings,
  prNumberLabel,
  REVIEW_SETTINGS_PATH,
  reviewStatusMeta,
  scmLabel,
  startReview,
} from '../../../lib/reviews'
import { toneDotClasses } from '../../../lib/status'
import { conversationHref, findItem, parseInspector } from '../../../lib/worklist'
import { usePlanSession } from '../../../providers/plan-session'
import { useRefreshWorklist, useWorklist } from '../../../providers/worklist'
import { cn } from '../../../lib/utils'

export type { ReviewCardData }

const SHELL = 'space-y-3 rounded-2xl border border-accent-500/25 bg-accent-500/[0.06] p-4'

export default function ReviewCard({ data, itemId }: CardRenderProps<ReviewCardData>) {
  if (data.state === 'started' && data.reviewId) return <StartedReviewCard reviewId={data.reviewId} />
  return <DraftReviewCard data={data} itemId={itemId} />
}

function prLabelFromUrl(prUrl: string): string {
  const github = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(prUrl)
  if (github) return `${github[1]}#${github[2]}`
  const gitlab = /\/([^/]+\/[^/]+)\/-\/merge_requests\/(\d+)/i.exec(prUrl)
  if (gitlab) return `${gitlab[1]}!${gitlab[2]}`
  const bitbucket = /bitbucket\.org\/([^/]+\/[^/]+)\/pull-requests\/(\d+)/i.exec(prUrl)
  if (bitbucket) return `${bitbucket[1]}#${bitbucket[2]}`
  return prUrl
}

function DraftReviewCard({ data, itemId }: CardRenderProps<ReviewCardData>) {
  const session = usePlanSession()
  const sessionRef = useRef(session)
  sessionRef.current = session
  const navigate = useNavigate()
  const { worklist } = useWorklist()
  const refreshWorklist = useRefreshWorklist()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<{ message: string; settings: boolean } | null>(null)

  // The runner links a started review to its conversation. If this card did
  // not get to record the start (the developer switched away mid-request),
  // the link is still there: adopt it.
  const conversation = worklist.conversations.find(c => c.id === session.sessionId)
  const adopted = conversation
    ? worklist.reviews.find(r => conversation.reviewIds.includes(r.id) && normalizePrUrl(r.prUrl) === normalizePrUrl(data.prUrl))
    : undefined
  const adoptedId = adopted?.id
  useEffect(() => {
    if (!adoptedId || starting) return
    sessionRef.current.updateCard(itemId, { ...data, state: 'started', reviewId: adoptedId } satisfies ReviewCardData)
  }, [adoptedId, data, itemId, starting])

  async function start() {
    if (starting) return
    const conversationId = session.sessionId
    setStarting(true)
    setError(null)
    try {
      const review = await startReview(data.prUrl, conversationId)
      refreshWorklist()
      // Only act on the conversation the card belongs to; if the developer
      // moved on, the runner's link brings the card up to date on return.
      if (sessionRef.current.sessionId !== conversationId) return
      sessionRef.current.updateCard(itemId, { ...data, state: 'started', reviewId: review.id } satisfies ReviewCardData)
      await sessionRef.current.persistSnapshot()
      navigate(conversationHref(conversationId, { kind: 'review', id: review.id }))
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Could not start the review',
        settings: err instanceof ApiError && err.status === 409,
      })
      setStarting(false)
    }
  }

  return (
    <CardShell
      icon={GitPullRequest}
      title="Review"
      summary={
        <div className="space-y-0.5">
          <div className="font-mono text-[12px] text-fg">{prLabelFromUrl(data.prUrl)}</div>
          {data.note ? <div>{data.note}</div> : null}
        </div>
      }
      defaultExpanded={false}
      action={
        <div className="space-y-2">
          <Button type="button" size="lg" className="w-full" disabled={starting} onClick={() => void start()}>
            {starting ? <Loader2 className="animate-spin" /> : null}
            {starting ? 'Starting review…' : 'Start review'}
          </Button>
          {error ? (
            <p className="text-[12.5px] text-danger-300">
              {error.message}{' '}
              {error.settings ? (
                <Link to={REVIEW_SETTINGS_PATH} className="text-accent-300 underline-offset-2 hover:underline">
                  Open review settings
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
      }
    >
      <p className="text-[13px] leading-[1.6] text-fg-muted">
        Coro reviews the pull request with its review lenses and keeps watching it for new commits. What it posts, and
        whether it can approve, follows your review settings.
      </p>
      <a href={data.prUrl} target="_blank" rel="noreferrer" className="break-all text-[12.5px] text-accent-300 hover:underline">
        {data.prUrl}
      </a>
    </CardShell>
  )
}

function StartedReviewCard({ reviewId }: { reviewId: string }) {
  const session = usePlanSession()
  const location = useLocation()
  const { worklist } = useWorklist()
  // The work list already polls review status; fetch the full record once
  // and again only when that status moves, rather than polling per card.
  const { review, missing, refetch } = useReview(reviewId, 0)
  const listed = findItem(worklist, `review:${reviewId}`)
  const listedVersion = listed?.updatedAt
  useEffect(() => {
    if (listedVersion) void refetch()
  }, [listedVersion, refetch])

  const inspector = parseInspector(location.search)
  const open = inspector?.kind === 'review' && inspector.id === reviewId
  const href = open
    ? conversationHref(session.sessionId)
    : conversationHref(session.sessionId, { kind: 'review', id: reviewId })

  if (missing) {
    return (
      <div className="rounded-2xl border border-line bg-overlay/30 px-4 py-3 text-[12.5px] text-fg-muted">
        This review was removed.
      </div>
    )
  }
  if (!review) {
    return (
      <div className={SHELL}>
        <div className="flex items-center gap-2 text-[12.5px] text-fg-subtle">
          <Loader2 className="size-3.5 animate-spin" /> Loading review…
        </div>
      </div>
    )
  }

  const meta = reviewStatusMeta(review)
  const round = latestRound(review)
  const counts = countBySeverity(openFindings(review))
  const action = review.awaitingApproval
    ? { label: 'Review draft', icon: FileCheck2 }
    : review.pendingVerdict
      ? { label: 'Decide verdict', icon: Gavel }
      : { label: 'Open review', icon: PanelRightOpen }
  const ActionIcon = open ? PanelRightClose : action.icon

  return (
    <div className={SHELL}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={href} className="block truncate text-sm font-semibold text-fg underline-offset-4 hover:text-accent-300 hover:underline">
            {review.pr.title || prNumberLabel(review)}
          </Link>
          <div className="mt-0.5 truncate text-[12px] text-fg-subtle">
            {prNumberLabel(review)} · {scmLabel(review.prRef.pluginId)}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-fg-muted">
          <span className={cn('size-1.5 rounded-full', toneDotClasses(meta.tone), meta.pulse && 'animate-pulse-dot')} aria-hidden />
          {meta.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-muted">
        <SeverityCounts counts={counts} />
        <span>{review.totals.rounds} round{review.totals.rounds === 1 ? '' : 's'}</span>
      </div>

      {round?.summary ? (
        <p className="line-clamp-2 rounded-lg border border-line/70 bg-canvas/40 px-2.5 py-1.5 text-[12px] leading-5 text-fg-muted">
          {round.summary}
        </p>
      ) : null}

      <Button asChild size="lg" variant={open ? 'secondary' : 'primary'} className="w-full">
        <Link to={href}>
          <ActionIcon />
          {open ? 'Close review panel' : action.label}
        </Link>
      </Button>
    </div>
  )
}
