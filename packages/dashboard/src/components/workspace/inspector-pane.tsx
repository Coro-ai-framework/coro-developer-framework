import { memo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, GitPullRequest, Workflow, X } from 'lucide-react'
import RunView from '../run/run-view'
import ReviewView from '../reviews/review-view'
import { useWorklist } from '../../providers/worklist'
import {
  findItem,
  itemStatusMeta,
  reviewPagePath,
  runPagePath,
  type InspectorTarget,
} from '../../lib/worklist'
import { toneDotClasses } from '../../lib/status'
import { cn } from '../../lib/utils'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Pane 3: a run or review opened beside the conversation that started it.
 * Closing it gives the conversation the full width back. Escape closes it
 * unless focus is in a field or a dialog.
 */
function InspectorPane({ target, onClose }: { target: InspectorTarget; onClose: () => void }) {
  const { worklist } = useWorklist()
  const item = findItem(worklist, `${target.kind}:${target.id}`)
  const meta = item ? itemStatusMeta(item) : null
  const fullPage = target.kind === 'run' ? runPagePath(target.id) : reviewPagePath(target.id)
  const Glyph = target.kind === 'run' ? Workflow : GitPullRequest

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <section
      aria-label={target.kind === 'run' ? 'Run' : 'Review'}
      className="flex min-w-0 flex-1 animate-fade-in flex-col border-l border-line bg-panel/30"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 lg:px-4">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-fg-muted transition-colors hover:bg-overlay hover:text-fg lg:hidden"
        >
          <ArrowLeft className="size-3.5" />
          Conversation
        </button>
        <span className="hidden size-6 shrink-0 items-center justify-center rounded-md bg-overlay/70 text-fg-muted ring-1 ring-line lg:flex">
          <Glyph className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-fg" title={item?.title ?? target.id}>
          {item?.title ?? target.id}
        </span>
        {meta ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-fg-muted">
            <span className={cn('size-1.5 rounded-full', toneDotClasses(meta.tone), meta.pulse && 'animate-pulse-dot')} aria-hidden />
            {meta.label}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <Link
            to={fullPage}
            className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg"
            title="Open full page"
            aria-label="Open full page"
          >
            <ArrowUpRight className="size-4" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="hidden rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg lg:inline-flex"
            title="Close panel (Esc)"
            aria-label="Close panel"
          >
            <X className="size-4" />
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-5">
        {target.kind === 'run' ? (
          <RunView jobId={target.id} variant="panel" />
        ) : (
          <ReviewView id={target.id} variant="panel" onClose={onClose} />
        )}
      </div>
    </section>
  )
}

/** Memoized: the conversation beside it re-renders on every streamed token. */
export default memo(InspectorPane)
