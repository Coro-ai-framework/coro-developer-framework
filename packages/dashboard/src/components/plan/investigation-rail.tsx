import { InvestigationList } from './investigation-list'
import { usePlanSession } from '../../providers/plan-session'
import { cn } from '../../lib/utils'

export default function InvestigationRail({
  className,
  onSelect,
}: {
  className?: string
  onSelect?: () => void
}) {
  const session = usePlanSession()

  async function handleSelect(id: string) {
    if (id === session.sessionId) {
      onSelect?.()
      return
    }
    if (session.busy) {
      const ok = window.confirm(
        'Coro is still working. Switch conversations? The current one stays in history.',
      )
      if (!ok) return
    }
    await session.openInvestigation(id)
    onSelect?.()
  }

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 w-[248px] shrink-0 flex-col border-r border-line bg-panel/40 pr-3',
        className,
      )}
    >
      <div className="mb-3 px-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          Investigations
        </div>
        <p className="mt-1 text-[12px] leading-4 text-fg-muted">
          Last conversations on this runner.
        </p>
      </div>
      <InvestigationList
        rows={session.investigations}
        currentId={session.sessionId}
        loading={session.investigationsLoading && !session.hydrated}
        loadingMore={session.investigationsLoadingMore}
        total={session.investigationsTotal}
        busy={session.busy}
        onSelect={id => void handleSelect(id)}
        onRemove={id => session.removeInvestigation(id)}
        onLoadMore={() => void session.loadMoreInvestigations()}
      />
    </aside>
  )
}
