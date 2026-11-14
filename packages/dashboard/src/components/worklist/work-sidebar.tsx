import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  ChevronRight,
  ClipboardList,
  GitPullRequestArrow,
  Layers,
  Microscope,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  type LucideIcon,
} from 'lucide-react'
import BrandMark from '../layout/brand-mark'
import StartReviewDialog from '../reviews/start-review-dialog'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import WorkRow from './work-row'
import { useLocalStorage } from '../../hooks/use-local-storage'
import { usePlanSessionActions } from '../../providers/plan-session'
import { useWorklist } from '../../providers/worklist'
import { useUnread } from '../../hooks/use-unread'
import {
  activeItemKey,
  buildThreads,
  countInGroup,
  filterThreads,
  groupThreads,
  itemKey,
  reviewPagePath,
  WORK_GROUP_LABEL,
  WORK_GROUPS,
  type KindFilter,
  type WorkGroup,
  type WorklistItem,
} from '../../lib/worklist'
import { HOME_PATH, RUNS_LIST_PATH } from '../../lib/run-labels'
import { REVIEWS_PATH } from '../../lib/reviews'
import { cn } from '../../lib/utils'

const KIND_FILTERS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'conversation', label: 'Plans' },
  { value: 'run', label: 'Runs' },
  { value: 'review', label: 'Reviews' },
]

const NO_ANCESTORS: WorklistItem[] = []

/** Finished threads shown before "Show more". */
const RECENT_VISIBLE = 8

interface FooterLink {
  label: string
  to: string
  icon: LucideIcon
}

const FOOTER_LINKS: FooterLink[] = [
  { label: 'Intelligence', to: '/intelligence', icon: Layers },
  { label: 'Retrospective', to: '/retrospectives', icon: Microscope },
  { label: 'Settings', to: '/settings', icon: Settings2 },
]

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function NewMenu({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate()
  const [reviewOpen, setReviewOpen] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent-500 text-[12.5px] font-medium text-white shadow-[0_10px_24px_-20px_rgba(97,114,255,0.85)] transition-colors hover:bg-accent-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
              compact ? 'size-8' : 'h-8 px-2.5',
            )}
            aria-label="New"
            title="New"
          >
            <Plus className="size-4" />
            {compact ? null : 'New'}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={compact ? 'start' : 'end'} side={compact ? 'right' : 'bottom'} className="w-60">
          <DropdownMenuItem onSelect={() => navigate(HOME_PATH)}>
            <ClipboardList className="size-4" />
            New conversation
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setReviewOpen(true)}>
            <GitPullRequestArrow className="size-4" />
            Review a pull request
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/retrospectives')}>
            <Microscope className="size-4" />
            Run a retrospective
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <StartReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onStarted={review => navigate(reviewPagePath(review.id))}
      />
    </>
  )
}

function GroupHeader({
  group,
  count,
  collapsed,
  onToggle,
}: {
  group: WorkGroup
  count: number
  collapsed: boolean
  onToggle: () => void
}) {
  const attention = group === 'needs-you'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="group/header flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
    >
      <ChevronRight
        className={cn('size-3 text-fg-subtle transition-transform group-hover/header:text-fg-muted', !collapsed && 'rotate-90')}
        aria-hidden
      />
      <span
        className={cn(
          'text-[10.5px] font-medium uppercase tracking-[0.18em]',
          attention ? 'text-warning-400' : 'text-fg-subtle group-hover/header:text-fg-muted',
        )}
      >
        {WORK_GROUP_LABEL[group]}
      </span>
      {group !== 'recent' ? (
        <span
          className={cn(
            'ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
            attention ? 'bg-warning-500/20 text-warning-300' : 'bg-overlay text-fg-muted',
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  )
}

export interface WorkListProps {
  /** Called after any navigation, so a sheet can close itself. */
  onNavigate?: () => void
  /** Focus the search box on mount (mobile sheet). */
  autoFocusSearch?: boolean
  searchRef?: React.RefObject<HTMLInputElement | null>
}

/** Search, kind filter, and the grouped threads. Shared by the sidebar and the mobile sheet. */
export function WorkList({ onNavigate, autoFocusSearch, searchRef }: WorkListProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { removeInvestigation } = usePlanSessionActions()
  const { worklist, loading, error, refresh } = useWorklist()
  const now = useMinuteClock()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useLocalStorage<KindFilter>('coro.worklist.kind', 'all')
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<Partial<Record<WorkGroup, boolean>>>(
    'coro.worklist.collapsed',
    {},
  )
  const [showAllRecent, setShowAllRecent] = useState(false)

  const activeKey = activeItemKey(location.pathname, location.search)
  const conversationMatch = /^\/plans\/([^/]+)/.exec(location.pathname)
  const openConversationId = conversationMatch ? decodeURIComponent(conversationMatch[1]!) : null

  const visibleKeys = useMemo(() => {
    const keys = new Set<string>()
    if (activeKey) keys.add(activeKey)
    if (openConversationId) keys.add(`conversation:${openConversationId}`)
    return keys
  }, [activeKey, openConversationId])
  const unread = useUnread(worklist, visibleKeys, loading)

  const threads = useMemo(() => buildThreads(worklist), [worklist])
  const filtered = useMemo(() => filterThreads(threads, kind, query), [threads, kind, query])
  const grouped = useMemo(() => groupThreads(filtered), [filtered])
  const empty = !loading && threads.length === 0
  const filteredEmpty = !empty && filtered.length === 0

  const removeConversation = useCallback(
    async (id: string, title: string) => {
      if (!window.confirm(`Remove “${title || 'this conversation'}”? Runs it started are kept.`)) return
      await removeInvestigation(id)
      if (openConversationId === id) navigate(HOME_PATH)
      refresh()
    },
    [navigate, openConversationId, refresh, removeInvestigation],
  )

  const onRemoveConversation = useCallback(
    (id: string, title: string) => void removeConversation(id, title),
    [removeConversation],
  )

  const toggleGroup = (group: WorkGroup) =>
    setCollapsedGroups(previous => ({ ...previous, [group]: !previous[group] }))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input
            ref={searchRef}
            autoFocus={autoFocusSearch}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setQuery('')
                event.currentTarget.blur()
              }
            }}
            placeholder="Search work"
            aria-label="Search work"
            className="h-8 rounded-lg pl-8 text-[12.5px]"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1 font-mono text-[10px] text-fg-subtle lg:inline">
            ⌘K
          </kbd>
        </div>
        <div role="radiogroup" aria-label="Show" className="grid grid-cols-4 gap-0.5 rounded-lg border border-line bg-overlay/50 p-0.5">
          {KIND_FILTERS.map(option => {
            const active = kind === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setKind(option.value)}
                className={cn(
                  'rounded-md py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
                  active ? 'bg-fg/12 text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]' : 'text-fg-muted hover:text-fg',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {error && threads.length === 0 ? (
          <p className="mx-2 mt-2 rounded-lg border border-warning-500/25 bg-warning-500/8 px-3 py-2 text-[12px] leading-5 text-warning-200">
            Can’t reach the runner. Retrying…
          </p>
        ) : null}
        {loading && !error ? (
          <div className="space-y-2 px-1 pt-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : null}
        {empty && !error ? (
          <p className="px-2 pt-3 text-[12.5px] leading-5 text-fg-muted">
            Nothing here yet. Describe some work to plan it, or review a pull request from <span className="text-fg">New</span>.
          </p>
        ) : null}
        {filteredEmpty ? <p className="px-2 pt-3 text-[12.5px] text-fg-muted">Nothing matches.</p> : null}

        {WORK_GROUPS.map(group => {
          const items = grouped[group]
          if (items.length === 0) return null
          const collapsed = Boolean(collapsedGroups[group]) && !query
          const visible = group === 'recent' && !showAllRecent && !query ? items.slice(0, RECENT_VISIBLE) : items
          return (
            <section key={group} className="pt-2" aria-label={WORK_GROUP_LABEL[group]}>
              <GroupHeader group={group} count={countInGroup(items, group)} collapsed={collapsed} onToggle={() => toggleGroup(group)} />
              {collapsed ? null : (
                <>
                  <ul className="mt-0.5 space-y-0.5">
                    {visible.map(t => (
                      <WorkRow
                        key={itemKey(t.item)}
                        thread={t}
                        ancestors={NO_ANCESTORS}
                        activeKey={activeKey}
                        unreadKeys={unread}
                        now={now}
                        onNavigate={onNavigate}
                        onRemoveConversation={onRemoveConversation}
                      />
                    ))}
                  </ul>
                  {group === 'recent' ? (
                    <div className="flex items-center gap-3 px-2 pt-1.5 text-[11.5px]">
                      {items.length > RECENT_VISIBLE && !query ? (
                        <button
                          type="button"
                          onClick={() => setShowAllRecent(value => !value)}
                          className="text-fg-subtle transition-colors hover:text-fg"
                        >
                          {showAllRecent ? 'Show less' : `Show ${items.length - RECENT_VISIBLE} more`}
                        </button>
                      ) : null}
                      <span className="ml-auto flex items-center gap-3">
                        <Link to={RUNS_LIST_PATH} onClick={onNavigate} className="text-fg-subtle transition-colors hover:text-accent-300">
                          All runs
                        </Link>
                        <Link to={REVIEWS_PATH} onClick={onNavigate} className="text-fg-subtle transition-colors hover:text-accent-300">
                          All reviews
                        </Link>
                      </span>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function FooterNav({ compact, onNavigate }: { compact: boolean; onNavigate?: () => void }) {
  return (
    <nav className={cn('border-t border-line px-2 py-2', compact ? 'flex flex-col items-center gap-1' : 'space-y-0.5')}>
      {FOOTER_LINKS.map(link => (
        <NavLink
          key={link.to}
          to={link.to}
          onClick={onNavigate}
          title={compact ? link.label : undefined}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-lg text-[12.5px] font-medium transition-colors',
              compact ? 'size-9 justify-center' : 'px-2 py-1.5',
              isActive ? 'bg-overlay text-fg' : 'text-fg-muted hover:bg-overlay/60 hover:text-fg',
            )
          }
        >
          <link.icon className="size-4 shrink-0" />
          {compact ? null : link.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** Pane 1: everything on the runner, grouped by what it needs from you. */
export default function WorkSidebar({ className }: { className?: string }) {
  const [collapsed, setCollapsed] = useLocalStorage('coro.sidebar.collapsed', false)
  const { worklist } = useWorklist()
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (collapsed) {
          pendingFocus.current = true
          setCollapsed(false)
        } else {
          searchRef.current?.focus()
          searchRef.current?.select()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapsed, setCollapsed])

  useEffect(() => {
    if (!collapsed && pendingFocus.current) {
      pendingFocus.current = false
      searchRef.current?.focus()
    }
  }, [collapsed])

  if (collapsed) {
    return (
      <aside className={cn('h-full w-14 shrink-0 flex-col items-center border-r border-line bg-panel/60 py-4 backdrop-blur-xl', className)}>
        <Link to={HOME_PATH} aria-label="Coro home">
          <BrandMark iconOnly />
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="mt-4 rounded-lg p-2 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="size-4" />
        </button>
        <div className="mt-2">
          <NewMenu compact />
        </div>
        {worklist.needsYou > 0 ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="mt-3 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-warning-500/20 px-1.5 text-[11px] font-semibold tabular-nums text-warning-300 ring-1 ring-warning-500/30"
            title={`${worklist.needsYou} need${worklist.needsYou === 1 ? 's' : ''} you`}
            aria-label={`${worklist.needsYou} items need you`}
          >
            {worklist.needsYou}
          </button>
        ) : null}
        <div className="mt-auto w-full">
          <FooterNav compact />
        </div>
      </aside>
    )
  }

  return (
    <aside className={cn('h-full w-[300px] shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur-xl', className)}>
      <header className="flex items-center gap-2 px-4 pb-3 pt-4">
        <Link to={HOME_PATH} className="mr-auto" aria-label="Coro home">
          <BrandMark />
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="rounded-lg p-2 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="size-4" />
        </button>
        <NewMenu />
      </header>
      <WorkList searchRef={searchRef} />
      <FooterNav compact={false} />
    </aside>
  )
}
