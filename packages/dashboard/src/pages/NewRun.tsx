import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import ActivityFeed from '../components/activity/activity-feed'
import PageHeader from '../components/common/page-header'
import PlanComposer from '../components/plan/plan-composer'
import { PLAN_CARD_RENDERERS } from '../components/plan/cards'
import { Button } from '../components/ui/button'
import { requestJson } from '../lib/http'
import { cn } from '../lib/utils'
import { useJobs } from '../hooks/useJobs'
import { usePlanSession } from '../providers/plan-session'
import { useRegisterWorkspaceTab, useWorkspaceTabs } from '../providers/workspace-tabs'
import {
  FALLBACK_JOB_WORKFLOW,
  fetchLaunchableWorkflows,
  type WorkflowOption,
} from '../workflows'
import type { BriefCardData } from '../components/plan/cards/brief-card'

const GREETING =
  "Hi — tell me what you'd like Coro to work on. I'll ask a few questions if needed, then propose a run brief you can edit before dispatching."

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

function tabSubtitle(session: ReturnType<typeof usePlanSession>): string {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]
    if (item.kind === 'card' && item.card.type === 'brief') {
      const data = item.card.data as BriefCardData
      if (data.brief.serviceName.trim()) return data.brief.serviceName
    }
  }
  const firstUser = session.items.find(i => i.kind === 'message' && i.role === 'user')
  if (firstUser && firstUser.kind === 'message') {
    return firstUser.text.length > 40 ? `${firstUser.text.slice(0, 40)}…` : firstUser.text
  }
  return 'Draft'
}

export default function NewRun() {
  const navigate = useNavigate()
  const session = usePlanSession()
  const { tabs } = useWorkspaceTabs()
  const { jobs } = useJobs(30_000)
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([FALLBACK_JOB_WORKFLOW])
  const [scmWarning, setScmWarning] = useState(false)

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
  const subtitle = useMemo(() => tabSubtitle(session), [session.items, session.hasProgress])

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

  function handleNewConversation() {
    if (session.busy || session.hasProgress) {
      const ok = window.confirm(
        session.busy
          ? 'Coro is still working. Close and discard this conversation?'
          : 'Discard this conversation and start a new one?',
      )
      if (!ok) return
    }
    session.reset()
  }

  const composerBlocked = session.noLlm || session.limitReached

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
            <Button type="button" variant="ghost" onClick={handleNewConversation}>
              New conversation
            </Button>
            <Button variant="outline" onClick={() => navigate('/jobs')}>
              <ArrowLeft />
              Back
            </Button>
          </div>
        }
      />

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <ActivityFeed
          items={session.items}
          partialText={session.partialText}
          busy={session.busy}
          cardRenderers={PLAN_CARD_RENDERERS}
          emptyState={<p className="text-[13.5px] leading-[1.7] text-fg">{GREETING}</p>}
        />

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

        {session.limitReached && !session.noLlm ? (
          <div className="mb-3 rounded-xl border border-danger-500/25 bg-danger-500/8 px-3.5 py-2.5 text-[12.5px] text-danger-200">
            This conversation has reached its limit. Start a new conversation, or dispatch the brief
            you have.
          </div>
        ) : null}

        {session.noLlm ? null : <PlanComposer blocked={composerBlocked} />}
      </div>
    </div>
  )
}
