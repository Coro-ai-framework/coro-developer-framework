import type { ReactNode } from 'react'
import { ArrowDownToLine, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import ActivityDeck from './activity-deck'
import CardHost from './cards/registry'
import type { CardRendererMap } from './cards/types'
import MessageBlock from './message-block'
import type { ActivityItem } from './types'
import { useStickToBottom } from './use-stick-to-bottom'

interface ActivityFeedProps {
  items: ActivityItem[]
  /** In-flight assistant text, rendered as a trailing streaming message. */
  partialText?: string
  /** True while a turn is in flight — drives the Thinking state and the caret. */
  busy?: boolean
  /** Card type → renderer. Injected, never imported. See activity layer Rule 2. */
  cardRenderers: CardRendererMap
  /** Rendered when items is empty. */
  emptyState?: ReactNode
  className?: string
}

function lastItemIsRunningDeck(items: ActivityItem[]): boolean {
  const last = items[items.length - 1]
  return last?.kind === 'activity' && last.entries.some(e => e.status === 'running')
}

function NoticeBlock({ item }: { item: Extract<ActivityItem, { kind: 'notice' }> }) {
  const toneClass =
    item.tone === 'error'
      ? 'border-danger-500/25 bg-danger-500/8 text-danger-200'
      : item.tone === 'warning'
        ? 'border-warning-500/25 bg-warning-500/8 text-warning-200'
        : 'border-accent-500/25 bg-accent-500/8 text-fg-muted'

  return (
    <div className={cn('rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-[1.6]', toneClass)}>
      <span>{item.text}</span>
      {item.action ? (
        <Link to={item.action.to} className="ml-2 text-accent-300 underline-offset-2 hover:underline">
          {item.action.label}
        </Link>
      ) : null}
    </div>
  )
}

export default function ActivityFeed({
  items,
  partialText,
  busy = false,
  cardRenderers,
  emptyState,
  className,
}: ActivityFeedProps) {
  const stick = useStickToBottom<HTMLDivElement>([items.length, partialText, busy])
  const showThinking = busy && !partialText && !lastItemIsRunningDeck(items)
  const empty = items.length === 0 && !partialText && !busy

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div ref={stick.ref} onScroll={stick.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-1 py-4 pr-2">
          {empty ? emptyState : null}
          {items.map(item => {
            if (item.kind === 'message') {
              return <MessageBlock key={item.id} role={item.role} text={item.text} />
            }
            if (item.kind === 'activity') {
              return <ActivityDeck key={item.id} group={item.group} entries={item.entries} />
            }
            if (item.kind === 'card') {
              return <CardHost key={item.id} itemId={item.id} card={item.card} cardRenderers={cardRenderers} />
            }
            return <NoticeBlock key={item.id} item={item} />
          })}
          {partialText ? <MessageBlock role="assistant" text={partialText} streaming /> : null}
          {showThinking ? (
            <div className="flex items-center gap-2 font-mono text-[10px] leading-[1.5] text-fg-subtle">
              <Loader2 className="size-3 animate-spin" />
              Thinking…
            </div>
          ) : null}
        </div>
      </div>
      {!stick.stuck ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2"
          onClick={stick.scrollToBottom}
        >
          <ArrowDownToLine />
          Jump to latest
        </Button>
      ) : null}
    </div>
  )
}
