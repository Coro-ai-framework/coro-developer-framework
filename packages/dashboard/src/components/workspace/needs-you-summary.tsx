import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import WorkRow from '../worklist/work-row'
import { useWorklist } from '../../providers/worklist'
import { activeItemKey, buildThreads, groupThreads, itemKey } from '../../lib/worklist'

const EMPTY = new Set<string>()

/** On a blank conversation, what is already waiting for the developer. */
export default function NeedsYouSummary() {
  const { worklist } = useWorklist()
  const location = useLocation()
  const threads = useMemo(() => groupThreads(buildThreads(worklist))['needs-you'], [worklist])
  if (threads.length === 0) return null
  const activeKey = activeItemKey(location.pathname, location.search)
  const now = Date.now()
  return (
    <section aria-label="Needs you" className="rounded-2xl border border-warning-500/20 bg-warning-500/[0.04] p-3">
      <div className="mb-1.5 flex items-center gap-2 px-2">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-warning-400">Needs you</span>
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning-500/20 px-1 text-[10px] font-semibold tabular-nums text-warning-300">
          {worklist.needsYou}
        </span>
      </div>
      <ul className="space-y-0.5">
        {threads.map(thread => (
          <WorkRow key={itemKey(thread.item)} thread={thread} ancestors={[]} activeKey={activeKey} unreadKeys={EMPTY} now={now} />
        ))}
      </ul>
    </section>
  )
}
