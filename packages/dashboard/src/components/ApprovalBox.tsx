import { useState } from 'react'
import { CheckCircle2, MessageSquareReply } from 'lucide-react'
import type { Job } from '../types'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import ArtifactReviewPanel from './artifact-review-panel'

interface ApprovalBoxProps {
  job: Job
  onSend: (message: string) => Promise<void>
  onCancel?: () => Promise<void>
  /** Jump to the Changes tab so the developer can review the diff before approving. */
  onViewChanges?: () => void
}

const APPROVE_MESSAGE = 'Approved. Please continue to the next phase.'

/**
 * Developer-facing approval + rework UI shown only when a job is parked
 * awaiting developer input.
 */
export default function ApprovalBox({ job, onSend, onCancel, onViewChanges }: ApprovalBoxProps) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isAwaiting = job.status === 'awaiting-developer-input'
  if (!isAwaiting) return null

  const currentPhase = job.workflowPhases?.find(p => p.name === job.phase)
  if (currentPhase && currentPhase.agent === null) return null

  const phaseArtifacts = (job.artifacts ?? []).filter(a => a.phase === job.phase)
  const hasReviewableArtifacts = phaseArtifacts.length > 0

  const reason = parseAwaitingReason(job.awaitingEvent)
  const isMidPhase = !job.awaitingNextPhase

  // The artifact approve / request-changes panel is *only* the right
  // affordance at a phase-boundary approval checkpoint (the runner sets
  // `awaitingNextPhase` for those). When the agent paused mid-phase to ask
  // for input or surface a blocker it cannot resolve, "Approve & continue"
  // is meaningless — the developer needs to send guidance back. Fall
  // through to the message composer in that case, even if the phase
  // happens to carry reviewable artifacts (e.g. PR links from coding).
  const showArtifactReview = hasReviewableArtifacts && !isMidPhase

  const handle = async (text: string) => {
    setSending(true)
    setError(null)
    try {
      await onSend(text)
      setMessage('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const handleCancel = async () => {
    if (!onCancel) return
    setSending(true)
    setError(null)
    try {
      await onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-warning-500/25 bg-warning-500/8 p-5">
      {showArtifactReview ? (
        <ArtifactReviewPanel
          jobId={job.id}
          artifacts={phaseArtifacts}
          phaseLabel={job.phase}
          sending={sending}
          onApprove={() => void handle(APPROVE_MESSAGE)}
          onRequestChanges={text => void handle(text)}
          onCancel={() => void handleCancel()}
          onViewChanges={onViewChanges}
        />
      ) : (
        <>
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-warning-500/25 bg-warning-500/10 text-warning-400">
              <MessageSquareReply className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-fg">
                {isMidPhase ? 'Agent paused for your input' : 'Approval needed to continue'}
              </div>
              <div className="mt-0.5 text-sm text-fg-muted">
                {isMidPhase ? (
                  <>
                    Mid-phase in <span className="font-mono text-fg">{job.phase}</span>
                    {reason ? <> — <span className="italic">{reason}</span></> : null}
                  </>
                ) : (
                  <>
                    After phase <span className="font-mono text-fg">{job.phase}</span>
                    {job.awaitingNextPhase ? (
                      <> → next: <span className="font-mono text-fg">{job.awaitingNextPhase}</span></>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>

          {!isMidPhase ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={() => void handle(APPROVE_MESSAGE)}
                disabled={sending}
                variant="success"
                size="sm"
              >
                <CheckCircle2 />
                {sending ? 'Sending…' : 'Approve & continue'}
              </Button>
              <span className="text-sm text-fg-muted">or send the agent back with changes below</span>
            </div>
          ) : null}

          <form
            onSubmit={e => { e.preventDefault(); if (message.trim()) void handle(message.trim()) }}
            className="space-y-3"
          >
            <Textarea
              rows={4}
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={
                isMidPhase
                  ? 'Answer the agent or provide the missing detail it asked for…'
                  : 'Request changes, clarify the plan, or send additional guidance…'
              }
              disabled={sending}
              className="border-warning-500/20 focus-visible:ring-warning-500/40"
            />
            <div className="flex items-center justify-between gap-3">
              {error ? (
                <span className="text-sm text-danger-400">{error}</span>
              ) : (
                <span className="text-xs text-fg-muted">
                  The agent will do the work and re-park for approval.
                </span>
              )}
              <Button
                type="submit"
                disabled={sending || !message.trim()}
                variant="secondary"
                size="sm"
              >
                {sending ? 'Sending…' : 'Send message'}
              </Button>
            </div>
          </form>
        </>
      )}

      {showArtifactReview && error ? (
        <div className="text-sm text-danger-400">{error}</div>
      ) : null}
    </div>
  )
}

function parseAwaitingReason(evt: string | undefined): string | null {
  if (!evt) return null
  if (evt.startsWith('developer-input:')) {
    const reason = evt.slice('developer-input:'.length).trim()
    if (reason.startsWith('approval after ')) return null
    return reason || null
  }
  return null
}
