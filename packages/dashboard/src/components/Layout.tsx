import { useEffect, useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { ListTodo } from 'lucide-react'
import AttentionNotifier from './layout/attention-notifier'
import BrandMark from './layout/brand-mark'
import WorkSidebar, { WorkList } from './worklist/work-sidebar'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { useWorklist } from '../providers/worklist'
import { HOME_PATH } from '../lib/run-labels'

/** Below `lg` the work list lives in a sheet behind this bar. */
function MobileBar() {
  const { worklist } = useWorklist()
  const [open, setOpen] = useState(false)
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-canvas/85 px-4 py-3 backdrop-blur-xl lg:hidden">
      <Link to={HOME_PATH} aria-label="Coro home">
        <BrandMark />
      </Link>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border border-line bg-overlay/50 px-3 py-1.5 text-[13px] font-medium text-fg"
      >
        <ListTodo className="size-4" />
        Work
        {worklist.needsYou > 0 ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning-500/20 px-1.5 text-[11px] font-semibold tabular-nums text-warning-300">
            {worklist.needsYou}
          </span>
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[min(720px,calc(100dvh-2rem))] max-w-md flex-col gap-0">
          <DialogHeader className="shrink-0 px-5 py-4">
            <DialogTitle>Work</DialogTitle>
            <DialogDescription>Plans, runs and reviews on this runner.</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col pt-3">
            <WorkList onNavigate={() => setOpen(false)} />
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )
}

export default function Layout() {
  const { worklist } = useWorklist()

  useEffect(() => {
    document.title = worklist.needsYou > 0 ? `(${worklist.needsYou}) Coro` : 'Coro'
  }, [worklist.needsYou])

  return (
    <div className="flex h-dvh overflow-hidden">
      <AttentionNotifier />
      <WorkSidebar className="hidden lg:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
