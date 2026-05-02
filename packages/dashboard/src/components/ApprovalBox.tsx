import { useState } from 'react'
import { CheckCircle2, MessageSquareReply } from 'lucide-react'
import type { Job } from '../types'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'

interface ApprovalBoxProps {
  job: Job
  onSend: (message: string) => Promise<void>
}

const APPROVE_MESSAGE = 'Approved. Please continue to the next phase.'

/**
 * Developer-facing approval + rework UI shown only when a job is parked
 * awaiting developer input. One-click "Approve & continue" posts a canned
 * approval; the textarea sends free-form rework instructions.
 *
 * Both paths hit the same POST /jobs/:id/message endpoint — the dispatcher
 * decides whether to advance or rework based on the agent's reading of the
 * message.
 */
export default function ApprovalBox({ job, onSend }: ApprovalBoxProps) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isAwaiting = job.status === 'awaiting-developer-input'
  if (!isAwaiting) return null

  const reason = parseAwaitingReason(job.awaitingEvent)
  const isMidPhase = !job.awaitingNextPhase

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

  return (
    <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-amber-500/25 bg-amber-500/12 text-amber-100">
          <MessageSquareReply className="size-4.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold text-amber-50">
            {isMidPhase ? 'Agent paused for your input' : 'Approval needed to continue'}
          </div>
          <div className="text-sm text-amber-100/80 mt-1">
            {isMidPhase ? (
              <>
                Mid-phase in <span className="font-mono">{job.phase}</span>
                {reason ? <> — <span className="italic">{reason}</span></> : null}
              </>
            ) : (
              <>
                After phase <span className="font-mono">{job.phase}</span>
                {job.awaitingNextPhase && (
                  <> → next: <span className="font-mono">{job.awaitingNextPhase}</span></>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {!isMidPhase && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => void handle(APPROVE_MESSAGE)}
            disabled={sending}
            variant="success"
          >
            <CheckCircle2 />
            {sending ? 'Sending…' : '✓ Approve & continue'}
          </Button>
          <span className="text-sm text-amber-100/75">or send the agent back with changes below</span>
        </div>
      )}

      <form
        onSubmit={e => { e.preventDefault(); if (message.trim()) void handle(message.trim()) }}
        className="space-y-2"
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
          className="border-amber-500/20 bg-slate-950/70 focus-visible:ring-amber-400/70"
        />
        <div className="flex items-center justify-between">
          {error ? (
            <span className="text-sm text-rose-200">{error}</span>
          ) : (
            <span className="text-sm text-amber-100/75">
              The agent will do the work and re-park for approval.
            </span>
          )}
          <Button
            type="submit"
            disabled={sending || !message.trim()}
            variant="outline"
            className="border-amber-500/30 bg-amber-500/10 text-amber-50 hover:bg-amber-500/15"
          >
            {sending ? 'Sending…' : 'Send message'}
          </Button>
        </div>
      </form>
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
