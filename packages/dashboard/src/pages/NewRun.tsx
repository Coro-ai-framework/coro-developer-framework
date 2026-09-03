import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, History } from 'lucide-react'
import ActivityFeed from '../components/activity/activity-feed'
import PageHeader from '../components/common/page-header'
import PlanComposer from '../components/plan/plan-composer'
import { PLAN_CARD_RENDERERS } from '../components/plan/cards'
import InvestigationRail from '../components/plan/investigation-rail'
import { InvestigationList } from '../components/plan/investigation-list'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { requestJson } from '../lib/http'
import { investigationTitleFromItems } from '../lib/intake-investigation'
import { cn } from '../lib/utils'
import { useJobs } from '../hooks/useJobs'
import { usePlanSession } from '../providers/plan-session'
import { useRegisterWorkspaceTab, useWorkspaceTabs } from '../providers/workspace-tabs'
import {
  FALLBACK_JOB_WORKFLOW,
  fetchLaunchableWorkflows,
  type WorkflowOption,
} from '../workflows'

const GREETING =
  "Hi — tell me what you'd like Coro to work on. I'll dig into the repo and the ticket, ask whatever I need to, and tell you what I find. When the work is genuinely clear, we'll turn it into a run — and if it turns out nothing needs building, I'll say that instead."

interface PluginManifest {
  id: string
  kind: string
}

interface PluginEntry {
  manifest: PluginManifest
  installed?: boolean
  configured?: boolean
  active?: boolean
}

interface PluginsResponse {
  plugins: PluginEntry[]
}

export default function NewRun() {
  const navigate = useNavigate()
  const session = usePlanSession()
  const { tabs } = useWorkspaceTabs()
  const { jobs } = useJobs(30_000)
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([FALLBACK_JOB_WORKFLOW])
  const [scmWarning, setScmWarning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    void fetchLaunchableWorkflows()
      .then(list => {
        if (list.length > 0) setWorkflows(list)
      })
      .catch(() => {
        // Discovery is non-fatal
      })
  }, [])

  useEffect(() => {
    session.setKnownWorkflows(workflows)
  }, [workflows, session.setKnownWorkflows])

  useEffect(() => {
    session.setJobs(jobs)
  }, [jobs, session.setJobs])

  useEffect(() => {
    void requestJson<PluginsResponse>('/plugins')
      .then(data => {
        const isActive = (e: PluginEntry) => e.active ?? e.configured ?? e.installed ?? false
        const hasScm = data.plugins.some(p => p.manifest.kind === 'scm' && isActive(p))
        session.setScmConnected(hasScm)
        setScmWarning(!hasScm)
      })
      .catch(() => {
        // Plugin discovery is non-fatal
      })
  }, [session.setScmConnected])

  const hasProgress = session.hasProgress
  const subtitle = useMemo(
    () => investigationTitleFromItems(session.items),
    [session.items],
  )

  useRegisterWorkspaceTab(
    hasProgress
      ? {
          id: 'new-run',
          kind: 'run',
          path: '/jobs/new',
          title: 'New run',
          subtitle,
        }
      : null,
  )

  async function handleNewConversation() {
    if (session.busy || session.hasProgress) {
      const ok = window.confirm(
        session.busy
          ? 'Coro is still working. Start a new conversation? This one stays in history.'
          : 'Start a new conversation? This one stays in history.',
      )
      if (!ok) return
    }
    await session.startNewConversation()
  }

  async function handleSelectHistory(id: string) {
    if (id === session.sessionId) {
      setHistoryOpen(false)
      return
    }
    if (session.busy) {
      const ok = window.confirm(
        'Coro is still working. Switch conversations? The current one stays in history.',
      )
      if (!ok) return
    }
    await session.openInvestigation(id)
    setHistoryOpen(false)
  }

  const composerBlocked = session.noLlm
  const showFeedSkeleton = !session.hydrated

  return (
    <div
      className={cn(
        'flex flex-col',
        tabs.length > 0 ? 'h-[calc(100vh-7.5rem)]' : 'h-[calc(100vh-5rem)]',
        'min-h-[520px]',
      )}
    >
      <PageHeader
        title="New run"
        className="shrink-0"
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className="lg:hidden"
              onClick={() => setHistoryOpen(true)}
            >
              <History />
              History
            </Button>
            <Button type="button" variant="ghost" onClick={() => void handleNewConversation()}>
              New conversation
            </Button>
            <Button variant="outline" onClick={() => navigate('/jobs')}>
              <ArrowLeft />
              Back
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        <InvestigationRail className="hidden lg:flex" />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showFeedSkeleton ? (
            <div className="mx-auto w-full max-w-3xl space-y-3 px-1 py-4">
              <Skeleton className="h-16 w-3/4" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-2/3" />
            </div>
          ) : (
            <ActivityFeed
              items={session.items}
              partialText={session.partialText}
              partialThinking={session.partialThinking}
              busy={session.busy}
              cardRenderers={PLAN_CARD_RENDERERS}
              emptyState={<p className="text-[13.5px] leading-[1.7] text-fg">{GREETING}</p>}
            />
          )}

          <div className="mx-auto w-full max-w-3xl">
            {scmWarning ? (
              <div className="mb-2 rounded-xl border border-warning-500/25 bg-warning-500/8 px-3.5 py-2.5 text-[12.5px] leading-[1.6] text-warning-200">
                No source-control provider is connected. Coro can plan, but it cannot start a run until
                you connect one.{' '}
                <Link to="/settings#source-control" className="text-accent-300 underline-offset-2 hover:underline">
                  Open settings
                </Link>
              </div>
            ) : null}

            {session.noLlm ? (
              <div className="mb-3 rounded-2xl border border-danger-500/25 bg-danger-500/8 p-4">
                <div className="text-sm font-semibold text-fg">Plan mode needs an LLM provider.</div>
                <p className="mt-1 text-[13px] text-fg-muted">
                  Connect one in Settings, then come back and describe your run.
                </p>
                <Button asChild className="mt-3">
                  <Link to="/settings#llm-provider">Open settings</Link>
                </Button>
              </div>
            ) : null}

            {session.noLlm ? null : <PlanComposer blocked={composerBlocked} />}
          </div>
        </div>
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="flex max-w-md flex-col gap-0 min-h-[28rem] max-h-[min(720px,calc(100vh-2rem))]">
          <DialogHeader className="shrink-0">
            <DialogTitle>Investigations</DialogTitle>
            <DialogDescription>Open a previous conversation on this runner.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex min-h-0 flex-1 flex-col">
            <InvestigationList
              rows={session.investigations}
              currentId={session.sessionId}
              loading={session.investigationsLoading && !session.hydrated}
              loadingMore={session.investigationsLoadingMore}
              total={session.investigationsTotal}
              busy={session.busy}
              revealRemoveOnHover={false}
              onSelect={id => void handleSelectHistory(id)}
              onRemove={id => session.removeInvestigation(id)}
              onLoadMore={() => void session.loadMoreInvestigations()}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}
