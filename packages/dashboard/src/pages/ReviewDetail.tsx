import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ExternalLink,
  FileCode2,
  GitCommitHorizontal,
  GitPullRequest,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Send,
  Settings2,
  TriangleAlert,
} from 'lucide-react'
import EmptyState from '../components/common/empty-state'
import ErrorState from '../components/common/error-state'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import SegmentedControl from '../components/ui/segmented-control'
import { Skeleton } from '../components/ui/skeleton'
import { Textarea } from '../components/ui/textarea'
import NoticeBanner, { type Notice } from '../components/reviews/notice-banner'
import { ReviewStatusBadge, SeverityBadge, SeverityCounts, ToneBadge } from '../components/reviews/review-badges'
import { ConfirmDialog, ReviewActionsMenu, useReviewActions } from '../components/reviews/review-actions'
import { useReview } from '../hooks/useReviews'
import { formatDateTime, formatDuration, formatRelativeTime, formatTokens } from '../lib/format'
import {
  REVIEWS_PATH,
  REVIEW_SETTINGS_PATH,
  SEVERITY_ORDER,
  VERDICT_LABEL,
  availableControls,
  commitHref,
  countBySeverity,
  formatReviewCost,
  findingHref,
  openFindings,
  pauseReasonLabel,
  prNumberLabel,
  reviewStatusMeta,
  roundDurationMs,
  roundKindLabel,
  roundOutcomeMeta,
  scmLabel,
  sendVerdict,
  shortCircuitLabel,
  shortSha,
  updateFinding,
  type FindingStatus,
  type PrReview,
  type ReviewFinding,
  type ReviewRound,
  type ReviewVerdict,
} from '../lib/reviews'
import { cn } from '../lib/utils'

export default function ReviewDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { review, loading, error, missing, setReview } = useReview(id)
  const [notice, setNotice] = useState<Notice | null>(null)
  const dismissNotice = useCallback(() => setNotice(null), [])
  const actions = useReviewActions(
    review,
    result => {
      if (result.kind === 'updated') setReview(result.review)
      else navigate(REVIEWS_PATH)
    },
    setNotice,
  )

  if (loading && !review) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (missing) {
    return (
      <EmptyState
        icon={GitPullRequest}
        title="This review no longer exists"
        description="It may have been deleted. Reviews are listed on the Reviews page."
        action={<Button asChild><Link to={REVIEWS_PATH}>Back to reviews</Link></Button>}
      />
    )
  }
  if (!review) return <ErrorState title="Could not load the review" message={error ?? 'Unknown error'} />

  const controls = availableControls(review)
  const scm = scmLabel(review.prRef.pluginId)

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-3 text-fg-subtle">
          <Link to={REVIEWS_PATH}><ArrowLeft /> Reviews</Link>
        </Button>

        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
              {prNumberLabel(review)} · {scm}
            </div>
            <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-fg sm:text-[1.85rem]">
              {review.pr.title || prNumberLabel(review)}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <ReviewStatusBadge review={review} />
              <PrStateBadge review={review} />
              {review.pr.labels?.map(label => (
                <span key={label} className="rounded-full border border-line bg-overlay px-2 py-0.5 text-[11px] text-fg-muted">
                  {label}
                </span>
              ))}
            </div>
            <p className="text-[13px] text-fg-muted">
              {[
                review.pr.author ? `Opened by ${review.pr.author}` : undefined,
                review.pr.changedFiles !== undefined ? `${review.pr.changedFiles} file${review.pr.changedFiles === 1 ? '' : 's'}` : undefined,
                `Reviewing as @${review.reviewer.login}${review.reviewer.mode === 'bot' ? ' (bot)' : ''}`,
              ].filter(Boolean).join(' · ')}
              {review.pr.additions !== undefined ? (
                <span className="ml-2 tabular-nums">
                  <span className="text-success-400">+{review.pr.additions}</span>{' '}
                  <span className="text-danger-400">−{review.pr.deletions ?? 0}</span>
                </span>
              ) : null}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {review.pr.url ? (
              <Button variant="secondary" asChild>
                <a href={review.pr.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open on {scm}
                </a>
              </Button>
            ) : null}
            {controls.resume ? (
              <Button variant="secondary" disabled={actions.busy !== null} onClick={() => void actions.run('resume')}>
                <Play /> Resume
              </Button>
            ) : (
              <Button variant="secondary" disabled={!controls.pause || actions.busy !== null} onClick={() => void actions.run('pause')}>
                <Pause /> Pause
              </Button>
            )}
            <Button disabled={!controls.rerun || actions.busy !== null} onClick={() => void actions.run('rerun')}>
              <RotateCcw className={cn(actions.busy === 'rerun' && 'animate-spin')} />
              {review.rounds.length ? 'Review again' : 'Review now'}
            </Button>
            <ReviewActionsMenu review={review} actions={actions} compact />
          </div>
        </div>
      </div>

      <NoticeBanner notice={notice} onDismiss={dismissNotice} />
      <StateBanner review={review} onResume={() => void actions.run('resume')} onRerun={() => void actions.run('rerun')} busy={actions.busy !== null} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {review.pendingVerdict ? <VerdictCard review={review} onUpdated={setReview} onNotice={setNotice} /> : null}
          <FindingsCard review={review} onUpdated={setReview} onNotice={setNotice} />
          <RoundsCard review={review} />
        </div>
        <aside className="space-y-6">
          <SummaryCard review={review} />
          <PullRequestCard review={review} />
          <UpNextCard review={review} />
        </aside>
      </div>
    </div>
  )
}

function PrStateBadge({ review }: { review: PrReview }) {
  if (review.pr.state === 'merged') return <ToneBadge tone="accent" label="Merged" />
  if (review.pr.state === 'declined') return <ToneBadge tone="neutral" label="Closed" />
  return <ToneBadge tone={review.pr.draft ? 'neutral' : 'success'} label={review.pr.draft ? 'Draft' : 'Open'} />
}

function StateBanner({ review, onResume, onRerun, busy }: { review: PrReview; onResume: () => void; onRerun: () => void; busy: boolean }) {
  if (review.status === 'failed' || review.lastError) {
    return (
      <ErrorState
        title={review.status === 'failed' ? 'The last round failed' : 'The last round had a problem'}
        message={review.lastError ?? 'Open the round’s run for details.'}
        action={<Button size="sm" variant="secondary" disabled={busy} onClick={onRerun}><RotateCcw /> Try again</Button>}
      />
    )
  }
  if (review.status === 'paused' && review.pauseReason && review.pauseReason !== 'user') {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-warning-500/25 bg-warning-500/8 px-4 py-3 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-400" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-warning-400">{pauseReasonLabel(review.pauseReason)}</div>
          <p className="text-fg-muted">
            {review.pauseReason === 'budget' || review.pauseReason === 'max-rounds'
              ? 'Coro stopped scheduling rounds for this pull request. Raise the limit in Settings, or resume to allow one more round.'
              : 'Coro holds rounds until the pull request is ready for review again.'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" asChild><Link to={REVIEW_SETTINGS_PATH}><Settings2 /> Limits</Link></Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onResume}><Play /> Resume</Button>
        </div>
      </div>
    )
  }
  if (review.status === 'skipped') {
    return (
      <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3 text-sm text-fg-muted">
        Skipped. Coro ignores new requests and pushes on this pull request. Use <span className="text-fg">Review again</span> to start it back up.
      </div>
    )
  }
  return null
}

/** What is already on the pull request depends on how the provider holds a draft. */
function heldVerdictCopy(pending: NonNullable<PrReview['pendingVerdict']>): string {
  const held = pending.heldComments?.length ?? 0
  if (held > 0) return `Nothing is posted yet. Submitting posts the summary and ${held} inline comment${held === 1 ? '' : 's'}.`
  if (pending.pendingReviewId) return "Coro's comments sit in a draft review only you can see. Submitting publishes them with this verdict."
  return 'Inline comments are already on the pull request. Only the verdict waits for you.'
}

function VerdictCard({ review, onUpdated, onNotice }: { review: PrReview; onUpdated: (review: PrReview) => void; onNotice: (notice: Notice) => void }) {
  const pending = review.pendingVerdict!
  const [body, setBody] = useState(pending.body)
  const [event, setEvent] = useState<ReviewVerdict>(pending.verdict)
  const [busy, setBusy] = useState<'submit' | 'edit' | 'discard' | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  useEffect(() => {
    setBody(pending.body)
    setEvent(pending.verdict)
  }, [pending.heldAt, pending.body, pending.verdict])

  const dirty = body !== pending.body || event !== pending.verdict
  const scm = scmLabel(review.prRef.pluginId)

  async function act(action: 'submit' | 'edit' | 'discard') {
    setBusy(action)
    try {
      const updated = await sendVerdict(review.id, action, action === 'discard' ? undefined : { body, event })
      onUpdated(updated)
      onNotice({
        tone: 'success',
        message: action === 'submit'
          ? `${VERDICT_LABEL[event]} posted on ${scm}.`
          : action === 'edit' ? 'Draft saved.' : 'Recommendation discarded. Nothing was posted.',
      })
    } catch (err) {
      onNotice({ tone: 'danger', message: err instanceof Error ? err.message : 'Could not update the verdict' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="border-warning-500/30">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Coro recommends: {VERDICT_LABEL[pending.verdict]}</CardTitle>
          <span className="text-[12px] text-fg-subtle">Held {formatRelativeTime(pending.heldAt)}</span>
        </div>
        <CardDescription>{heldVerdictCopy(pending)} Edit the summary or change the verdict first if you disagree.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <SegmentedControl<ReviewVerdict>
          options={[
            { value: 'approve', label: 'Approve' },
            { value: 'request_changes', label: 'Request changes' },
            { value: 'comment', label: 'Comment only' },
          ]}
          value={event}
          onChange={setEvent}
          size="sm"
          ariaLabel="Verdict"
        />
        <Textarea value={body} onChange={eventTarget => setBody(eventTarget.target.value)} rows={8} className="font-mono text-[13px]" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] text-fg-subtle">
            Posts as @{review.reviewer.login}{review.reviewer.mode === 'self' ? ', which is your account' : ''}.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>Discard</Button>
            <Button variant="secondary" disabled={!dirty || busy !== null} onClick={() => void act('edit')}>Save draft</Button>
            <Button variant={event === 'approve' ? 'success' : 'primary'} disabled={busy !== null || !body.trim()} onClick={() => void act('submit')}>
              <Send /> {busy === 'submit' ? 'Posting…' : `${VERDICT_LABEL[event]} on ${scm}`}
            </Button>
          </div>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this recommendation?"
        description="Coro drops the held verdict. The comments it already posted stay. A later round may recommend again."
        confirmLabel="Discard"
        onConfirm={() => { setConfirmDiscard(false); void act('discard') }}
      />
    </Card>
  )
}

type FindingView = 'open' | 'resolved' | 'dismissed' | 'all'

const FINDING_VIEW_MATCH: Record<FindingView, (finding: ReviewFinding) => boolean> = {
  open: finding => finding.status === 'open',
  resolved: finding => finding.status === 'addressed' || finding.status === 'outdated',
  dismissed: finding => finding.status === 'declined' || finding.status === 'withdrawn',
  all: () => true,
}

const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Open',
  addressed: 'Addressed',
  outdated: 'Outdated',
  declined: 'Dismissed',
  withdrawn: 'Withdrawn',
}

function FindingsCard({ review, onUpdated, onNotice }: { review: PrReview; onUpdated: (review: PrReview) => void; onNotice: (notice: Notice) => void }) {
  const [view, setView] = useState<FindingView>('open')
  const findings = review.ledger.findings
  const counts = useMemo(() => ({
    open: findings.filter(FINDING_VIEW_MATCH.open).length,
    resolved: findings.filter(FINDING_VIEW_MATCH.resolved).length,
    dismissed: findings.filter(FINDING_VIEW_MATCH.dismissed).length,
    all: findings.length,
  }), [findings])
  const visible = findings.filter(FINDING_VIEW_MATCH[view])

  async function setStatus(finding: ReviewFinding, status: FindingStatus) {
    try {
      onUpdated(await updateFinding(review.id, finding.id, status))
    } catch (err) {
      onNotice({ tone: 'danger', message: err instanceof Error ? err.message : 'Could not update the finding' })
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">Findings</CardTitle>
          <CardDescription>Changing a status here updates Coro's ledger. It does not edit the comment on the pull request.</CardDescription>
        </div>
        <SegmentedControl<FindingView>
          className="self-start whitespace-nowrap"
          options={[
            { value: 'open', label: `Open ${counts.open}` },
            { value: 'resolved', label: `Resolved ${counts.resolved}` },
            { value: 'dismissed', label: `Dismissed ${counts.dismissed}` },
            { value: 'all', label: `All ${counts.all}` },
          ]}
          value={view}
          onChange={setView}
          size="sm"
          ariaLabel="Filter findings"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-fg-subtle">
            {findings.length === 0
              ? review.rounds.length === 0 ? 'Findings appear here after the first round.' : 'Coro has not raised anything on this pull request.'
              : 'Nothing in this view.'}
          </p>
        ) : (
          SEVERITY_ORDER.map(severity => {
            const group = visible.filter(finding => finding.severity === severity)
            if (group.length === 0) return null
            return (
              <section key={severity} className="space-y-2">
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
                  <SeverityBadge severity={severity} /> {group.length}
                </div>
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {group.map(finding => (
                    <FindingRow key={finding.id} review={review} finding={finding} onStatus={status => void setStatus(finding, status)} />
                  ))}
                </ul>
              </section>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

function FindingRow({ review, finding, onStatus }: { review: PrReview; finding: ReviewFinding; onStatus: (status: FindingStatus) => void }) {
  const [expanded, setExpanded] = useState(false)
  const href = findingHref(review, finding)
  const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}` : undefined
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <li className={cn('bg-panel/40', finding.status !== 'open' && 'opacity-70')}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-overlay hover:text-fg disabled:opacity-30"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          disabled={!finding.body}
        >
          <Chevron className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className={cn('text-sm font-medium text-fg', finding.status !== 'open' && 'line-through decoration-fg-subtle/60')}>
            {finding.title}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-subtle">
            {location ? (
              href ? (
                <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-fg-muted hover:text-accent-300">
                  <FileCode2 className="size-3" /> {location}
                </a>
              ) : (
                <span className="font-mono">{location}</span>
              )
            ) : null}
            <span>{finding.lens} lens</span>
            {finding.category && finding.category !== finding.lens ? <span>{finding.category}</span> : null}
            <span>round {finding.raisedInRound}</span>
            {finding.status !== 'open' ? <span className="text-fg-muted">{FINDING_STATUS_LABEL[finding.status]}</span> : null}
          </div>
          {expanded && finding.body ? (
            <p className="whitespace-pre-wrap pt-1 text-[13px] leading-5 text-fg-muted">{finding.body}</p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Finding actions"><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {finding.status === 'open' ? (
              <>
                <DropdownMenuItem onSelect={() => onStatus('addressed')}>Mark addressed</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onStatus('declined')}>Dismiss, won't fix</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onStatus('withdrawn')}>Withdraw, Coro was wrong</DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onSelect={() => onStatus('open')}>Reopen</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

function RoundsCard({ review }: { review: PrReview }) {
  const rounds = [...review.rounds].reverse()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rounds</CardTitle>
        <CardDescription>Each round is a separate run. Rounds that needed no model are free.</CardDescription>
      </CardHeader>
      <CardContent>
        {rounds.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-fg-subtle">No rounds yet.</p>
        ) : (
          <ol className="relative space-y-4 border-l border-line pl-5">
            {rounds.map(round => <RoundItem key={`${round.round}-${round.jobId}-${round.startedAt}`} review={review} round={round} />)}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

function RoundItem({ review, round }: { review: PrReview; round: ReviewRound }) {
  const outcome = roundOutcomeMeta(round)
  const short = shortCircuitLabel(round)
  const duration = roundDurationMs(round)
  const lenses = Object.entries(round.lensCosts ?? {})
  const commit = commitHref(review, round.headSha)

  return (
    <li className="relative">
      <span
        className={cn(
          'absolute -left-[26px] top-1.5 size-2.5 rounded-full border-2 border-panel',
          outcome.tone === 'danger' ? 'bg-danger-400' : outcome.tone === 'success' ? 'bg-success-400' : outcome.tone === 'warning' ? 'bg-warning-400' : outcome.tone === 'accent' ? 'bg-accent-400' : 'bg-fg-subtle',
          outcome.pulse && 'animate-pulse-dot',
        )}
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">Round {round.round}</span>
        <span className="text-[12px] text-fg-muted">{roundKindLabel(round.kind)}</span>
        <ToneBadge tone={outcome.tone} label={outcome.label} pulse={outcome.pulse} />
        {round.verdict ? <Badge variant="neutral">{VERDICT_LABEL[round.verdict]}</Badge> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-subtle">
        <span title={formatDateTime(round.startedAt)}>{formatRelativeTime(round.startedAt)}</span>
        {duration !== null && duration > 0 ? <span>{formatDuration(duration)}</span> : null}
        <span className="tabular-nums">{formatReviewCost(round.costUsd)}</span>
        {round.headSha ? (
          commit ? (
            <a href={commit} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono hover:text-accent-300">
              <GitCommitHorizontal className="size-3" />{shortSha(round.headSha)}
            </a>
          ) : (
            <span className="font-mono">{shortSha(round.headSha)}</span>
          )
        ) : null}
        {round.jobId ? (
          <Link to={`/jobs/${encodeURIComponent(round.jobId)}`} className="inline-flex items-center gap-1 text-fg-muted hover:text-accent-300">
            <ScrollText className="size-3" /> Open run
          </Link>
        ) : null}
      </div>
      {short ? <p className="mt-1.5 text-[13px] text-fg-muted">{short}.</p> : null}
      {round.summary ? <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-5 text-fg-muted">{round.summary}</p> : null}
      {lenses.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {lenses.map(([lens, cost]) => (
            <span
              key={lens}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-overlay px-2 py-0.5 text-[11px] text-fg-muted"
              title={`${formatTokens(cost.inputTokens)} in · ${formatTokens(cost.outputTokens)} out`}
            >
              <span className="font-medium text-fg">{lens}</span>
              <span className="tabular-nums">{formatReviewCost(cost.costUsd)}</span>
              <span>· {cost.findings} found</span>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  )
}

function SummaryCard({ review }: { review: PrReview }) {
  const open = openFindings(review)
  const today = new Date().toISOString().slice(0, 10)
  const spentToday = review.spendDay?.day === today ? review.spendDay.usd : 0
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">At a glance</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">Open findings</div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums text-fg">{open.length}</span>
            <SeverityCounts counts={countBySeverity(open)} />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Fact label="Rounds" value={String(review.totals.rounds)} />
          <Fact label="Spend" value={formatReviewCost(review.totals.costUsd)} icon={CircleDollarSign} />
          <Fact label="Today" value={formatReviewCost(spentToday)} />
          <Fact label="Tokens" value={`${formatTokens(review.totals.inputTokens)} / ${formatTokens(review.totals.outputTokens)}`} title="Input / output" />
        </dl>
      </CardContent>
    </Card>
  )
}

function Fact({ label, value, icon: Icon, title }: { label: string; value: string; icon?: typeof CircleDollarSign; title?: string }) {
  return (
    <div className="space-y-0.5" title={title}>
      <dt className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{label}</dt>
      <dd className="flex items-center gap-1 font-medium tabular-nums text-fg">
        {Icon ? <Icon className="size-3.5 text-fg-subtle" /> : null}
        {value}
      </dd>
    </div>
  )
}

function PullRequestCard({ review }: { review: PrReview }) {
  const reviewed = review.ledger.lastReviewedSha
  const behind = reviewed && review.pr.headSha && reviewed !== review.pr.headSha
  const row = (label: string, sha: string | undefined) => {
    const href = sha ? commitHref(review, sha) : undefined
    return (
      <div className="flex items-center justify-between gap-3">
        <dt className="text-fg-subtle">{label}</dt>
        <dd className="font-mono text-[12px] text-fg-muted">
          {href ? <a href={href} target="_blank" rel="noreferrer" className="hover:text-accent-300">{shortSha(sha)}</a> : shortSha(sha)}
        </dd>
      </div>
    )
  }
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Pull request</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-[13px]">
        <dl className="space-y-2">
          {row('Head', review.pr.headSha)}
          {row('Base', review.pr.baseSha)}
          {row('Last reviewed', reviewed)}
        </dl>
        {behind ? (
          <p className="rounded-lg border border-accent-500/25 bg-accent-500/8 px-3 py-2 text-[12px] text-fg-muted">
            The head moved since the last review. The next round covers the new commits.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {review.pr.url ? (
            <Button variant="outline" size="sm" asChild>
              <a href={`${review.pr.url}${review.prRef.pluginId === 'github' ? '/files' : ''}`} target="_blank" rel="noreferrer">
                <FileCode2 /> Changed files
              </a>
            </Button>
          ) : null}
        </div>
        <p className="text-[12px] text-fg-subtle">Review started {formatRelativeTime(review.createdAt)}.</p>
      </CardContent>
    </Card>
  )
}

function upNext(review: PrReview): string {
  const meta = reviewStatusMeta(review)
  switch (review.status) {
    case 'queued':
      return `The next round ${meta.detail?.replace(/^Starts /, 'starts ') ?? 'starts soon'}.`
    case 'running':
      return 'A round is running. Stop it from More if it is not needed.'
    case 'idle':
      return 'Watching for new commits, comments, and review requests.'
    case 'awaiting-verdict':
      return 'Waiting for your verdict. New commits still start a round.'
    case 'paused':
      return `${meta.detail ?? 'Paused'}. No rounds start until you resume.`
    case 'skipped':
      return 'Nothing. Coro ignores this pull request until you review it again.'
    case 'failed':
      return 'Nothing until you try again or new activity arrives.'
    case 'done':
      return `Nothing. The pull request is ${review.pr.state === 'merged' ? 'merged' : 'closed'}.`
  }
}

function UpNextCard({ review }: { review: PrReview }) {
  const events = review.pendingEvents
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Up next</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-[13px] text-fg-muted">
        <p>{upNext(review)}</p>
        {events.length > 0 ? (
          <ul className="space-y-1">
            {events.slice(-6).map((event, index) => (
              <li key={`${event.kind}-${event.at}-${index}`} className="flex items-center justify-between gap-2 text-[12px]">
                <span>{event.kind.replace(/-/g, ' ')}{event.actor ? ` by ${event.actor}` : ''}</span>
                <span className="text-fg-subtle">{formatRelativeTime(event.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-fg-subtle">No new activity waiting for a round.</p>
        )}
      </CardContent>
    </Card>
  )
}
