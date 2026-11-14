import { memo } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList, GitPullRequest, Microscope, Workflow, X, type LucideIcon } from 'lucide-react'
import {
  compactAge,
  isRetrospectiveRun,
  itemDetail,
  itemHref,
  itemKey,
  itemStatusMeta,
  type WorkGroup,
  type WorklistItem,
  type WorkThread,
} from '../../lib/worklist'
import { toneDotClasses, type Tone } from '../../lib/status'
import { cn } from '../../lib/utils'

function glyphFor(item: WorklistItem): LucideIcon {
  if (item.kind === 'conversation') return ClipboardList
  if (item.kind === 'review') return GitPullRequest
  return isRetrospectiveRun(item) ? Microscope : Workflow
}

const KIND_LABEL: Record<WorklistItem['kind'], string> = {
  conversation: 'Plan',
  run: 'Run',
  review: 'Review',
}

const GLYPH_TONE: Record<WorkGroup, string> = {
  'needs-you': 'text-warning-400 bg-warning-500/10 ring-warning-500/20',
  working: 'text-accent-300 bg-accent-500/10 ring-accent-500/20',
  waiting: 'text-fg-muted bg-overlay/70 ring-line',
  recent: 'text-fg-subtle bg-overlay/40 ring-line',
}

function labelTone(tone: Tone): string {
  if (tone === 'warning') return 'text-warning-400'
  if (tone === 'danger') return 'text-danger-400'
  if (tone === 'accent') return 'text-accent-300'
  if (tone === 'success') return 'text-success-400'
  return 'text-fg-muted'
}

export interface WorkRowProps {
  thread: WorkThread
  ancestors: WorklistItem[]
  activeKey: string | null
  unreadKeys: ReadonlySet<string>
  now: number
  onNavigate?: () => void
  onRemoveConversation?: (id: string, title: string) => void
}

function WorkRowImpl({ thread, ancestors, activeKey, unreadKeys, now, onNavigate, onRemoveConversation }: WorkRowProps) {
  const { item } = thread
  const key = itemKey(item)
  const active = key === activeKey
  const unread = unreadKeys.has(key)
  const meta = itemStatusMeta(item)
  const detail = itemDetail(item)
  const Glyph = glyphFor(item)
  const nested = ancestors.length > 0
  const removable = item.kind === 'conversation' && Boolean(onRemoveConversation)
  const childAncestors = [...ancestors, item]

  return (
    <li>
      <div className="group/row relative">
        <Link
          to={itemHref(item, ancestors)}
          onClick={onNavigate}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
            active ? 'bg-accent-500/10' : 'hover:bg-overlay/60',
          )}
        >
          {active ? <span className="absolute left-0 top-2.5 h-4 w-0.5 rounded-full bg-accent-400" aria-hidden /> : null}
          <span
            className={cn(
              'mt-0.5 flex shrink-0 items-center justify-center rounded-md ring-1',
              nested ? 'size-5' : 'size-6',
              GLYPH_TONE[item.group],
            )}
            title={KIND_LABEL[item.kind]}
          >
            <Glyph className={nested ? 'size-3' : 'size-3.5'} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate leading-5',
                  nested ? 'text-[12.5px]' : 'text-[13px]',
                  active || unread ? 'font-semibold text-fg' : 'font-medium text-fg-muted group-hover/row:text-fg',
                )}
                title={item.title}
              >
                {item.title}
              </span>
              <span
                className={cn(
                  'shrink-0 text-[10.5px] tabular-nums text-fg-subtle',
                  removable && 'group-hover/row:invisible group-focus-within/row:invisible',
                )}
              >
                {compactAge(item.updatedAt, now)}
              </span>
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4">
              <span
                className={cn('size-1.5 shrink-0 rounded-full', toneDotClasses(meta.tone), meta.pulse && 'animate-pulse-dot')}
                aria-hidden
              />
              <span className={cn('shrink-0', labelTone(meta.tone))}>{meta.label}</span>
              {detail ? <span className="min-w-0 truncate text-fg-subtle" title={detail}>· {detail}</span> : null}
              {unread ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-accent-400" aria-label="Updated" /> : null}
            </span>
          </span>
        </Link>
        {removable ? (
          <button
            type="button"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              onRemoveConversation?.(item.id, item.title)
            }}
            className="absolute right-1.5 top-1.5 rounded-md p-1 text-fg-subtle opacity-0 transition-opacity hover:bg-overlay hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100"
            aria-label={`Remove ${item.title}`}
            title="Remove conversation"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      {thread.children.length > 0 ? (
        <ul className={cn('mt-0.5 space-y-0.5 border-l border-line pl-1.5', nested ? 'ml-2.5' : 'ml-[18px]')}>
          {thread.children.map(child => (
            <WorkRow
              key={itemKey(child.item)}
              thread={child}
              ancestors={childAncestors}
              activeKey={activeKey}
              unreadKeys={unreadKeys}
              now={now}
              onNavigate={onNavigate}
              onRemoveConversation={onRemoveConversation}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

const WorkRow = memo(WorkRowImpl)
export default WorkRow
