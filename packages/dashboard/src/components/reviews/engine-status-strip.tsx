import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox, RefreshCw, Settings2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { cn } from '../../lib/utils'
import { formatRelativeTime } from '../../lib/format'
import { REVIEW_SETTINGS_PATH, pollInbox, scmLabel, type ReviewEngineStatus } from '../../lib/reviews'

interface EngineStatusStripProps {
  status: ReviewEngineStatus | null
  error: string | null
  onPolled: (status: ReviewEngineStatus) => void
  onNotice: (notice: { tone: 'success' | 'danger'; message: string }) => void
}

function describe(status: ReviewEngineStatus | null, error: string | null) {
  if (!status) {
    return {
      tone: 'neutral' as const,
      title: error ? 'Review engine status unavailable' : 'Checking the review engine…',
      detail: error ? 'This runner does not report review status. Restart it to pick up the latest version.' : undefined,
    }
  }
  if (!status.enabled) {
    return {
      tone: 'neutral' as const,
      title: 'Reviews are off',
      detail: 'Turn them on in Settings and Coro picks up pull requests where you are a requested reviewer.',
    }
  }
  if (!status.running) {
    return {
      tone: 'warning' as const,
      title: 'Reviews are on, but the engine is not running',
      detail: 'Save the PR review settings again or restart the runner.',
    }
  }
  const who = status.login ? `@${status.login}` : 'your account'
  const where = status.scms.length ? status.scms.map(scmLabel).join(', ') : 'no SCM'
  const source = status.eventSource === 'webhook' ? 'webhooks' : status.eventSource === 'both' ? 'polling and webhooks' : 'polling'
  if (status.inbox?.lastError) {
    return { tone: 'danger' as const, title: `Inbox check failed for ${who}`, detail: status.inbox.lastError }
  }
  const polled = status.inbox?.lastPollAt ? `checked ${formatRelativeTime(status.inbox.lastPollAt)}` : 'first check pending'
  const open = status.inbox ? `${status.inbox.openRequests} open request${status.inbox.openRequests === 1 ? '' : 's'}` : undefined
  return {
    tone: 'success' as const,
    title: `Watching review requests for ${who}`,
    detail: [`${where} via ${source}`, status.eventSource !== 'webhook' ? polled : undefined, open].filter(Boolean).join(' · '),
  }
}

const DOT: Record<string, string> = {
  neutral: 'bg-fg-subtle',
  warning: 'bg-warning-400',
  danger: 'bg-danger-400',
  success: 'bg-success-400 animate-pulse-dot',
}

export default function EngineStatusStrip({ status, error, onPolled, onNotice }: EngineStatusStripProps) {
  const [polling, setPolling] = useState(false)
  const view = describe(status, error)
  const canPoll = Boolean(status?.running && status.eventSource !== 'webhook')

  async function poll() {
    setPolling(true)
    try {
      const next = await pollInbox()
      onPolled(next)
      onNotice({ tone: 'success', message: `Inbox checked. ${next.inbox?.openRequests ?? 0} open review request(s).` })
    } catch (err) {
      onNotice({ tone: 'danger', message: err instanceof Error ? err.message : 'Could not check the inbox' })
    } finally {
      setPolling(false)
    }
  }

  return (
    <Card className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-overlay text-fg-muted">
          <Inbox className="size-4" />
        </div>
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <span className={cn('size-2 shrink-0 rounded-full', DOT[view.tone])} aria-hidden />
            <span className="truncate">{view.title}</span>
          </div>
          {view.detail ? <p className="text-[12px] leading-4 text-fg-subtle">{view.detail}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canPoll ? (
          <Button variant="secondary" size="sm" disabled={polling} onClick={() => void poll()}>
            <RefreshCw className={cn(polling && 'animate-spin')} />
            {polling ? 'Checking…' : 'Check inbox now'}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" asChild>
          <Link to={REVIEW_SETTINGS_PATH}>
            <Settings2 />
            Settings
          </Link>
        </Button>
      </div>
    </Card>
  )
}
