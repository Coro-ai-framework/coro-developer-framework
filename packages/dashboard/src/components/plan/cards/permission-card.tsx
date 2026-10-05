import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Globe, Plug, Terminal } from 'lucide-react'
import type { CardRenderProps } from '../../activity/cards/types'
import type { PermissionCardData } from '../../activity/adapters/intake'
import { Button } from '../../ui/button'
import { Textarea } from '../../ui/textarea'
import { cn } from '../../../lib/utils'
import { usePlanSession } from '../../../providers/plan-session'
import type { IntakePermissionRequest } from '../../../lib/intake-investigation'

export type { PermissionCardData }

function iconFor(request: IntakePermissionRequest) {
  if (request.capability === 'shell' || request.toolName === 'Bash' || request.toolName === 'shell') return Terminal
  if (request.capability === 'web') return Globe
  if (request.capability.startsWith('mcp:')) return Plug
  return FileText
}

function remainingLabel(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now)
  const total = Math.ceil(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export default function PermissionCard({ data }: CardRenderProps<PermissionCardData>) {
  const session = usePlanSession()
  const { request, status, by } = data
  const [now, setNow] = useState(() => Date.now())
  const [denyOpen, setDenyOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const Icon = iconFor(request)

  useEffect(() => {
    if (status !== 'pending') return
    primaryRef.current?.focus()
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [status])

  const countdown = useMemo(() => remainingLabel(request.expiresAt, now), [request.expiresAt, now])

  async function choose(decision: 'once' | 'conversation' | 'always' | 'deny', extra?: { mode?: 'ask' | 'allow'; message?: string }) {
    if (sending) return
    setSending(true)
    try {
      await session.respondToPermission(request.requestId, {
        decision,
        ...(request.suggestedRule && (decision === 'conversation' || decision === 'always') ? { rule: request.suggestedRule } : {}),
        ...(extra?.mode ? { mode: extra.mode } : {}),
        ...(extra?.message ? { message: extra.message } : {}),
      })
    } finally {
      setSending(false)
    }
  }

  if (status !== 'pending') {
    const verb = status === 'allowed' ? 'Allowed' : status === 'expired' || by === 'timeout' ? 'No response' : 'Denied'
    return (
      <div className="rounded-xl border border-line bg-overlay/40 px-3 py-2 text-[12px] text-fg-subtle">
        {verb}{request.subject ? ` · ${request.subject}` : ''}
      </div>
    )
  }

  const isCapability = request.kind === 'capability'
  const onceLabel = request.capability === 'web' ? 'Fetch once' : 'Run once'

  return (
    <div
      className="rounded-xl border border-line bg-panel px-3 py-3"
      onKeyDown={event => {
        if (event.key === 'Enter' && !denyOpen && !event.shiftKey) {
          event.preventDefault()
          if (isCapability) void choose('conversation', { mode: 'ask' })
          else if (request.allowedDecisions.includes('once')) void choose('once')
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (!denyOpen) setDenyOpen(true)
          else void choose('deny')
        }
      }}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-fg">
        <Icon className="size-4 text-fg-muted" />
        {request.title}
      </div>
      {request.subject ? (
        isCapability ? (
          <p className="mt-2 text-[13px] text-fg-muted">“{request.subject}”</p>
        ) : (
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-overlay/70 p-2 font-mono text-[12px] text-fg">{request.subject}</pre>
        )
      ) : null}
      {!isCapability && request.detail !== undefined ? <Details detail={request.detail} /> : null}
      {request.risk === 'mutating' ? (
        <p className="mt-2 text-[12px] text-warning-400">
          This can change things outside the scratch directory (push code, call an API, deploy). It can only be approved once.
        </p>
      ) : null}
      {request.risk === 'outside-scratch' ? (
        <p className="mt-2 text-[12px] text-warning-400">
          This reads a path outside this conversation's scratch directory.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isCapability ? (
          <>
            <Button ref={primaryRef} size="sm" disabled={sending} onClick={() => void choose('conversation', { mode: 'ask' })}>
              Enable · ask each time
            </Button>
            <Button size="sm" variant="secondary" disabled={sending} onClick={() => void choose('conversation', { mode: 'allow' })}>
              Enable · allow
            </Button>
            <Button size="sm" variant="ghost" disabled={sending} onClick={() => setDenyOpen(true)}>
              Not now
            </Button>
          </>
        ) : (
          <>
            {request.allowedDecisions.includes('once') ? (
              <Button ref={primaryRef} size="sm" disabled={sending} onClick={() => void choose('once')}>
                {onceLabel}
              </Button>
            ) : null}
            {request.allowedDecisions.includes('conversation') && request.suggestedRule ? (
              <Button size="sm" variant="secondary" disabled={sending} onClick={() => void choose('conversation')}>
                Allow {request.suggestedRule} here
              </Button>
            ) : null}
            {request.allowedDecisions.includes('always') && request.suggestedRule ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={sending}
                title="Saved to ~/.coro/config.json"
                onClick={() => void choose('always')}
              >
                Always allow
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={sending} onClick={() => setDenyOpen(open => !open)}>
              Deny
            </Button>
          </>
        )}
        <span className="ml-auto text-[11px] text-fg-subtle">Auto-declines in {countdown}</span>
      </div>
      {denyOpen ? (
        <div className="mt-2 space-y-2">
          <Textarea
            value={message}
            onChange={event => setMessage(event.target.value)}
            placeholder="Tell plan mode what to do instead (optional)"
            rows={2}
          />
          <Button size="sm" variant="danger" disabled={sending} onClick={() => void choose('deny', { message })}>
            Send
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Details({ detail }: { detail: unknown }) {
  const [open, setOpen] = useState(false)
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
  return (
    <div className="mt-2">
      <button type="button" className={cn('text-[11px] text-fg-subtle hover:text-fg-muted')} onClick={() => setOpen(value => !value)}>
        {open ? 'Hide details' : 'Details'}
      </button>
      {open ? <pre className="mt-1 max-h-48 overflow-auto font-mono text-[11px] text-fg-muted">{text}</pre> : null}
    </div>
  )
}
