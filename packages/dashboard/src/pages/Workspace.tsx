import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { RotateCcw } from 'lucide-react'
import ActivityFeed from '../components/activity/activity-feed'
import PlanComposer from '../components/plan/plan-composer'
import { PLAN_CARD_RENDERERS } from '../components/plan/cards'
import RunnerSetupAlerts from '../components/setup/runner-setup-alerts'
import InspectorPane from '../components/workspace/inspector-pane'
import NeedsYouSummary from '../components/workspace/needs-you-summary'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { requestJson } from '../lib/http'
import { investigationTitleFromItems } from '../lib/intake-investigation'
import { getReadinessMeta, toneDotClasses } from '../lib/status'
import { parseInspector, withInspector } from '../lib/worklist'
import { cn } from '../lib/utils'
import { useJobs } from '../hooks/useJobs'
import { usePlanSession } from '../providers/plan-session'
import {
  FALLBACK_JOB_WORKFLOW,
  fetchLaunchableWorkflows,
  type WorkflowOption,
} from '../workflows'

const GREETING =
  "Hi — tell me what you'd like Coro to work on. I'll dig into the repo and the ticket, ask whatever I need to, and tell you what I find. When the work is genuinely clear, we'll turn it into a run — and if it turns out nothing needs building, I'll say that instead."

interface PluginsResponse {
  plugins: Array<{
    manifest: { id: string; kind: string }
    installed?: boolean
    configured?: boolean
    active?: boolean
  }>
}

/** Workflows and connected plugins only change from Settings; load them once per tab. */
function useWorkspaceContext() {
  const session = usePlanSession()
  const [scmWarning, setScmWarning] = useState(false)
  const { setKnownWorkflows, setScmConnected, setJobs } = session
  // The job list feeds run-history hints and links a run card to its job.
  const { jobs } = useJobs(30_000)

  useEffect(() => {
    let cancelled = false
    void fetchLaunchableWorkflows()
      .then(list => {
        if (!cancelled) setKnownWorkflows(list.length > 0 ? list : [FALLBACK_JOB_WORKFLOW])
      })
      .catch(() => {
        if (!cancelled) setKnownWorkflows([FALLBACK_JOB_WORKFLOW] as WorkflowOption[])
      })
    void requestJson<PluginsResponse>('/plugins')
      .then(data => {
        if (cancelled) return
        const isActive = (entry: PluginsResponse['plugins'][number]) =>
          entry.active ?? entry.configured ?? entry.installed ?? false
        const hasScm = data.plugins.some(p => p.manifest.kind === 'scm' && isActive(p))
        setScmConnected(hasScm)
        setScmWarning(!hasScm)
      })
      .catch(() => {
        // Plugin discovery is non-fatal.
      })
    return () => {
      cancelled = true
    }
  }, [setKnownWorkflows, setScmConnected])

  useEffect(() => {
    setJobs(jobs)
  }, [jobs, setJobs])

  return { scmWarning }
}

function ConversationHeader() {
  const session = usePlanSession()
  const title = session.hasProgress ? investigationTitleFromItems(session.items) : 'New conversation'
  const readiness = session.hasProgress && session.readiness ? getReadinessMeta(session.readiness.state) : null
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4 lg:px-6">
      <h1 className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-fg" title={title}>
        {title}
      </h1>
      {session.busy ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-accent-300">
          <span className="size-1.5 animate-pulse-dot rounded-full bg-accent-400" aria-hidden />
          Working
        </span>
      ) : readiness ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-fg-muted">
          <span className={cn('size-1.5 rounded-full', toneDotClasses(readiness.tone))} aria-hidden />
          {readiness.label}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Plan mode: the conversation (pane 2) and, when a run or review is open
 * beside it, the inspector (pane 3). The URL is the only state — which
 * conversation, and what is open next to it.
 */
export default function Workspace() {
  const { conversationId } = useParams<{ conversationId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const session = usePlanSession()
  const { scmWarning } = useWorkspaceContext()
  const target = useMemo(() => parseInspector(location.search), [location.search])

  // The provider's identity changes every render; the switch must only run
  // when the URL names a different conversation.
  const sessionRef = useRef(session)
  sessionRef.current = session
  useEffect(() => {
    if (!conversationId) return
    void sessionRef.current.openInvestigation(conversationId)
  }, [conversationId])

  const search = location.search
  const closeInspector = useCallback(
    () => navigate({ search: withInspector(search, null) }),
    [navigate, search],
  )

  const loadingConversation = !session.hydrated || session.switching || (conversationId !== session.sessionId && !session.openError)
  const failed = session.openError && session.openError.id === conversationId ? session.openError : null

  return (
    <div className="flex h-full min-w-0 flex-1">
      <section
        aria-label="Conversation"
        className={cn(
          '@container/conversation flex min-w-0 flex-col',
          target ? 'hidden lg:flex lg:w-[420px] lg:shrink-0 xl:w-[460px]' : 'flex-1',
        )}
      >
        <ConversationHeader />
        <div className="flex min-h-0 flex-1 flex-col px-4 lg:px-6">
          <div className="shrink-0 pt-3 empty:hidden">
            <RunnerSetupAlerts />
          </div>

          {failed ? (
            <div className="mx-auto mt-10 w-full max-w-md rounded-2xl border border-danger-500/25 bg-danger-500/8 p-5">
              <div className="text-sm font-semibold text-fg">This conversation could not be loaded.</div>
              <p className="mt-1 text-[13px] text-fg-muted">{failed.message}</p>
              <Button
                className="mt-4"
                variant="secondary"
                onClick={() => conversationId && void session.openInvestigation(conversationId)}
              >
                <RotateCcw /> Try again
              </Button>
            </div>
          ) : loadingConversation ? (
            <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 px-1 py-4">
              <Skeleton className="h-16 w-3/4" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-2/3" />
            </div>
          ) : (
            <ActivityFeed
              items={session.hasProgress ? session.items : []}
              partialText={session.hasProgress ? session.partialText : ''}
              partialThinking={session.hasProgress ? session.partialThinking : ''}
              busy={session.hasProgress && session.busy}
              cardRenderers={PLAN_CARD_RENDERERS}
              emptyState={
                <div className="space-y-6">
                  <p className="text-[13.5px] leading-[1.7] text-fg">{GREETING}</p>
                  <NeedsYouSummary />
                </div>
              }
            />
          )}

          {failed ? null : (
            <div className="mx-auto w-full max-w-3xl pb-3">
              {scmWarning ? (
                <div className="mb-2 rounded-xl border border-warning-500/25 bg-warning-500/8 px-3.5 py-2.5 text-[12.5px] leading-[1.6] text-warning-200">
                  No source-control provider is connected. Coro can plan, but it cannot start a run until you connect one.{' '}
                  <Link to="/settings#source-control" className="text-accent-300 underline-offset-2 hover:underline">
                    Open settings
                  </Link>
                </div>
              ) : null}

              {session.noLlm ? (
                <div className="mb-3 rounded-2xl border border-danger-500/25 bg-danger-500/8 p-4">
                  <div className="text-sm font-semibold text-fg">Plan mode needs an LLM provider.</div>
                  <p className="mt-1 text-[13px] text-fg-muted">Connect one in Settings, then come back and describe your run.</p>
                  <Button asChild className="mt-3">
                    <Link to="/settings#llm-provider">Open settings</Link>
                  </Button>
                </div>
              ) : (
                <PlanComposer blocked={loadingConversation} />
              )}
            </div>
          )}
        </div>
      </section>

      {target ? <InspectorPane key={`${target.kind}:${target.id}`} target={target} onClose={closeInspector} /> : null}
    </div>
  )
}
