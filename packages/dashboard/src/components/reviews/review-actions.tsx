import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Ban,
  ExternalLink,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Square,
  Trash2,
} from 'lucide-react'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import {
  availableControls,
  deleteReview,
  latestRound,
  prNumberLabel,
  reviewControl,
  scmLabel,
  type PrReview,
  type ReviewControl,
} from '../../lib/reviews'

export type ReviewActionResult = { kind: 'updated'; review: PrReview } | { kind: 'deleted' }

export interface ReviewActionHandlers {
  busy: string | null
  run: (action: ReviewControl) => Promise<void>
  remove: () => Promise<void>
}

const SUCCESS: Record<ReviewControl, string> = {
  pause: 'Paused. No new rounds start until you resume.',
  resume: 'Resumed.',
  stop: 'Stopped the round in flight and paused the review.',
  skip: 'Skipped. Coro ignores this pull request until you start it again.',
  rerun: 'A full review of the current head starts now.',
}

/**
 * The one place review controls talk to the runner, so the list row and the
 * detail page report success and failure the same way.
 */
export function useReviewActions(
  review: PrReview | null,
  onResult: (result: ReviewActionResult) => void,
  onNotice: (notice: { tone: 'success' | 'danger'; message: string }) => void,
): ReviewActionHandlers {
  const [busy, setBusy] = useState<string | null>(null)

  async function run(action: ReviewControl) {
    if (!review) return
    setBusy(action)
    try {
      const updated = await reviewControl(review.id, action)
      onResult({ kind: 'updated', review: updated })
      onNotice({ tone: 'success', message: SUCCESS[action] })
    } catch (err) {
      onNotice({ tone: 'danger', message: err instanceof Error ? err.message : `Could not ${action} the review` })
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!review) return
    setBusy('delete')
    try {
      await deleteReview(review.id)
      onResult({ kind: 'deleted' })
      onNotice({ tone: 'success', message: `Removed the review of ${prNumberLabel(review)}.` })
    } catch (err) {
      onNotice({ tone: 'danger', message: err instanceof Error ? err.message : 'Could not delete the review' })
    } finally {
      setBusy(null)
    }
  }

  return { busy, run, remove }
}

interface ConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, tone = 'danger', busy, onConfirm }: ConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(480px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={tone} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

interface ReviewActionsMenuProps {
  review: PrReview
  actions: ReviewActionHandlers
  /** The detail page shows the common controls as buttons; the menu keeps the rest. */
  compact?: boolean
  align?: 'start' | 'end'
}

export function ReviewActionsMenu({ review, actions, compact = false, align = 'end' }: ReviewActionsMenuProps) {
  const [confirm, setConfirm] = useState<'skip' | 'delete' | 'stop' | null>(null)
  const controls = availableControls(review)
  const round = latestRound(review)
  const disabled = actions.busy !== null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size={compact ? 'sm' : 'icon'} aria-label="Review actions" className={compact ? undefined : 'size-8'}>
            <MoreHorizontal />
            {compact ? 'More' : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="min-w-56">
          <DropdownMenuLabel>{prNumberLabel(review)}</DropdownMenuLabel>
          {review.pr.url ? (
            <DropdownMenuItem asChild>
              <a href={review.pr.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> Open on {scmLabel(review.prRef.pluginId)}
              </a>
            </DropdownMenuItem>
          ) : null}
          {round?.jobId ? (
            <DropdownMenuItem asChild>
              <Link to={`/jobs/${encodeURIComponent(round.jobId)}`}>
                <ScrollText className="size-4" /> Latest round's run
              </Link>
            </DropdownMenuItem>
          ) : null}
          {!compact ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!controls.rerun || disabled} onSelect={() => void actions.run('rerun')}>
                <RotateCcw className="size-4" /> {review.rounds.length ? 'Review again' : 'Review now'}
              </DropdownMenuItem>
              {controls.resume ? (
                <DropdownMenuItem disabled={disabled} onSelect={() => void actions.run('resume')}>
                  <Play className="size-4" /> Resume
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled={!controls.pause || disabled} onSelect={() => void actions.run('pause')}>
                  <Pause className="size-4" /> Pause
                </DropdownMenuItem>
              )}
            </>
          ) : null}
          <DropdownMenuItem disabled={!controls.stop || disabled} onSelect={() => setConfirm('stop')}>
            <Square className="size-4" /> Stop the running round
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!controls.skip || disabled} onSelect={() => setConfirm('skip')}>
            <Ban className="size-4" /> Skip this pull request
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-danger-400 focus:text-danger-400" disabled={disabled} onSelect={() => setConfirm('delete')}>
            <Trash2 className="size-4" /> Delete review
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirm === 'stop'}
        onOpenChange={open => setConfirm(open ? 'stop' : null)}
        title="Stop the running round?"
        description="The round's run is cancelled and the review is paused. Comments it already posted stay on the pull request."
        confirmLabel="Stop round"
        busy={disabled}
        onConfirm={() => { setConfirm(null); void actions.run('stop') }}
      />
      <ConfirmDialog
        open={confirm === 'skip'}
        onOpenChange={open => setConfirm(open ? 'skip' : null)}
        title="Skip this pull request?"
        description="Coro stops reviewing it and ignores new review requests and pushes. Start it again from here or with Review again."
        confirmLabel="Skip"
        tone="primary"
        busy={disabled}
        onConfirm={() => { setConfirm(null); void actions.run('skip') }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={open => setConfirm(open ? 'delete' : null)}
        title="Delete this review?"
        description="Coro forgets its findings, rounds, and pending verdict for this pull request. Nothing on the pull request is deleted. While you are still a requested reviewer, a restarted runner will pick it up again; skip it instead to keep Coro away."
        confirmLabel="Delete"
        busy={disabled}
        onConfirm={() => { setConfirm(null); void actions.remove() }}
      />
    </>
  )
}
