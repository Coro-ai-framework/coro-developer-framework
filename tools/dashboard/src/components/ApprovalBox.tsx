import { useState } from 'react'
import type { Job } from '../types'

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
    <div className="rounded-xl border border-amber-800 bg-amber-950/20 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-amber-900/40 border border-amber-700 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-amber-200">
            {isMidPhase ? 'Agent paused for your input' : 'Approval needed to continue'}
          </div>
          <div className="text-xs text-amber-300/80 mt-0.5">
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handle(APPROVE_MESSAGE)}
            disabled={sending}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? 'Sending…' : '✓ Approve & continue'}
          </button>
          <span className="text-xs text-zinc-500">or ask for changes below</span>
        </div>
      )}

      <form
        onSubmit={e => { e.preventDefault(); if (message.trim()) void handle(message.trim()) }}
        className="space-y-2"
      >
        <textarea
          rows={3}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder={
            isMidPhase
              ? 'Answer the agent\'s question or provide the info it\'s waiting on…'
              : 'Request changes: "Modify the plan to include rate limiting on /api/users too"…'
          }
          disabled={sending}
          className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 disabled:opacity-50 transition-colors resize-none"
        />
        <div className="flex items-center justify-between">
          {error ? (
            <span className="text-xs text-rose-300">{error}</span>
          ) : (
            <span className="text-xs text-zinc-500">
              The agent will do the work and re-park for approval.
            </span>
          )}
          <button
            type="submit"
            disabled={sending || !message.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? 'Sending…' : 'Send message'}
          </button>
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
