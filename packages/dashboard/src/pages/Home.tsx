import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  FolderKanban,
  Inbox,
  PlayCircle,
  Settings2,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import StatCard from '../components/common/stat-card'
import ErrorState from '../components/common/error-state'
import StatusBadge from '../components/StatusBadge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import SetupWizard from '../components/wizard/SetupWizard'
import { SettingsProvider } from './Settings/SettingsContext'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { requestJson } from '../lib/http'
import { deriveJobDescription, deriveJobTitle, getRunDetailPath, sortJobsByUpdatedAt } from '../lib/jobs'
import {
  PAGE_TITLES,
  RUN_LIST_LABELS,
  RUN_NOUN,
  SUB_RUN_NOUN,
  getRunWorkflowTag,
  hostsSubRuns,
} from '../lib/run-labels'
import { isTerminalStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'
import type { Job } from '../types'

interface ConfigSnapshot {
  config: {
    llm?: { defaultProvider?: string }
    git?: { provider?: string; username?: string; token?: string }
  } | null
  /** Result of the live healthcheck for the configured default LLM provider. */
  llmHealthy?: boolean
}

type SetupState = 'loading' | 'not-configured' | 'partial' | 'configured'

interface SetupSummary {
  state: SetupState
  missing: string[]
}

function summariseConfig(snapshot: ConfigSnapshot | null): SetupSummary {
  if (snapshot === null) return { state: 'loading', missing: [] }
  if (snapshot.config === null) return { state: 'not-configured', missing: [] }

  const missing: string[] = []
  const { llm, git } = snapshot.config
  // Treat the LLM as ready only when the runner can actually talk to
  // the configured default provider. The defaultProvider field on its
  // own only proves the user picked a name; healthcheck proves the
  // credentials work.
  if (!llm?.defaultProvider || snapshot.llmHealthy !== true) missing.push('LLM provider')
  if (!git?.provider) missing.push('Git provider')
  if (!git?.username || !git?.token) missing.push('Git credentials')

  return missing.length === 0 ? { state: 'configured', missing } : { state: 'partial', missing }
}

interface OverviewListProps {
  title: string
  jobs: Job[]
  emptyLabel: string
  icon: LucideIcon
}

function OverviewList({ title, jobs, emptyLabel, icon: Icon }: OverviewListProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b border-line pb-4">
        <CardTitle>{title}</CardTitle>
        <span className="rounded-md border border-line bg-overlay px-2 py-0.5 text-[11px] tabular-nums text-fg-muted">
          {jobs.length}
        </span>
      </CardHeader>
      <CardContent className="pt-3">
        {jobs.length === 0 ? (
          <div className="flex items-center gap-3 px-1 py-6 text-sm text-fg-subtle">
            <Icon className="size-4 shrink-0" />
            <span>{emptyLabel}</span>
          </div>
        ) : (
          <div className="-mx-1">
            {jobs.map(job => {
              const detailPath = getRunDetailPath(job)
              return (
                <Link
                  key={job.id}
                  to={detailPath}
                  className="group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-overlay/60"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">{deriveJobTitle(job)}</span>
                      <span className="inline-flex items-center rounded-md border border-line bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-fg-muted">
                        {getRunWorkflowTag(job)}
                      </span>
                      <StatusBadge status={job.status} />
                    </div>
                    {deriveJobDescription(job) ? (
                      <div className="line-clamp-1 text-[13px] text-fg-muted">
                        {deriveJobDescription(job)}
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 pt-1 text-[11px] text-fg-subtle">
                    {formatRelativeTime(job.updatedAt)}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SetupBanner({ setup, onLaunchWizard }: { setup: SetupSummary; onLaunchWizard: () => void }) {
  const isFirstRun = setup.state === 'not-configured'
  const title = isFirstRun ? 'Welcome to Coro — finish setup' : 'Runner setup is incomplete'
  const description = isFirstRun
    ? 'Connect your model and code host. The setup wizard walks through each step.'
    : `One or more essentials are missing. Finish configuration so ${RUN_NOUN.pluralLower} can run cleanly.`

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-warning-500/25 bg-warning-500/8 p-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-warning-500/25 bg-warning-500/10 text-warning-400">
          {isFirstRun ? <Sparkles className="size-4" /> : <AlertTriangle className="size-4" />}
        </div>
        <div className="space-y-1">
          <div className="text-[15px] font-semibold text-fg">{title}</div>
          <p className="max-w-2xl text-sm text-fg-muted">{description}</p>
          {setup.missing.length > 0 ? (
            <div className="text-sm text-fg-muted">
              Missing: <span className="text-fg">{setup.missing.join(', ')}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onLaunchWizard}>
          <Sparkles />
          Run setup wizard
        </Button>
        <Button asChild variant="outline">
          <Link to="/settings">
            <Settings2 />
            Open settings
          </Link>
        </Button>
      </div>
    </div>
  )
}

function ReadyChip() {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-success-500/30 bg-success-500/8 px-4 py-2.5 text-sm text-success-300">
      <CheckCircle2 className="size-4" />
      Runner is ready. New jobs will dispatch immediately.
    </div>
  )
}

export default function Home() {
  return (
    <SettingsProvider>
      <HomeInner />
    </SettingsProvider>
  )
}

function HomeInner() {
  const { jobs, loading, error } = useJobs()
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [autoLaunched, setAutoLaunched] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await requestJson<ConfigSnapshot>('/config')
        // Probe the configured default executor's healthcheck so the
        // banner reflects "can the runner actually reach the model?"
        // rather than "did the user fill out the form?".
        const providerId = data.config?.llm?.defaultProvider
        let llmHealthy: boolean | undefined
        if (providerId) {
          try {
            const result = await requestJson<{ ok?: boolean }>(
              `/plugins/${encodeURIComponent(providerId)}/healthcheck`,
              { method: 'POST' },
            )
            llmHealthy = result.ok === true
          } catch {
            llmHealthy = false
          }
        }
        if (!cancelled) setSnapshot({ ...data, llmHealthy })
      } catch {
        if (!cancelled) setSnapshot({ config: null })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const setup = summariseConfig(snapshot)
  const sortedJobs = useMemo(() => sortJobsByUpdatedAt(jobs), [jobs])
  const activeRuns = sortedJobs.filter(job => !isTerminalStatus(job.status))
  const activeSoloRuns = activeRuns.filter(job => !hostsSubRuns(job))
  const activeWithSubRuns = activeRuns.filter(job => hostsSubRuns(job))
  const awaitingInput = sortedJobs.filter(job => job.status === 'awaiting-developer-input')
  const recentHistory = sortedJobs.filter(job => isTerminalStatus(job.status)).slice(0, 5)
  const liveSpend = activeRuns.reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)

  // Auto-launch the wizard on first boot when nothing is configured and the
  // user has not dismissed it before. The localStorage flag is also set when
  // the wizard's "Open dashboard" button is clicked, so re-loads stay quiet.
  useEffect(() => {
    if (autoLaunched) return
    if (setup.state !== 'not-configured') return
    if (typeof window === 'undefined') return
    const completed = window.localStorage.getItem('coro.firstRun.completed') === 'true'
    const dismissed = window.localStorage.getItem('coro.firstRun.dismissed') === 'true'
    if (completed || dismissed) return
    setWizardOpen(true)
    setAutoLaunched(true)
  }, [setup.state, autoLaunched])

  function handleWizardOpenChange(next: boolean) {
    setWizardOpen(next)
    // If the user closed the wizard without finishing, suppress auto-launch
    // for the rest of the browser session so it does not nag.
    if (!next && typeof window !== 'undefined') {
      const completed = window.localStorage.getItem('coro.firstRun.completed') === 'true'
      if (!completed) window.localStorage.setItem('coro.firstRun.dismissed', 'true')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={PAGE_TITLES.overview}
        description="What's live, what needs you, and what just finished."
        actions={
          <Button asChild>
            <Link to="/jobs/new">
              {PAGE_TITLES.newRun}
              <ArrowRight />
            </Link>
          </Button>
        }
      />

      {setup.state !== 'configured' && setup.state !== 'loading' ? (
        <SetupBanner setup={setup} onLaunchWizard={() => setWizardOpen(true)} />
      ) : null}
      {setup.state === 'configured' ? <ReadyChip /> : null}

      <SetupWizard open={wizardOpen} onOpenChange={handleWizardOpenChange} />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`Active ${RUN_NOUN.pluralLower}`}
          value={activeRuns.length.toString()}
          description={`Across all workflows`}
          icon={PlayCircle}
          tone="accent"
        />
        <StatCard
          label={`Hosting ${SUB_RUN_NOUN.pluralLower}`}
          value={activeWithSubRuns.length.toString()}
          description={`${RUN_NOUN.plural} coordinating ${SUB_RUN_NOUN.pluralLower}`}
          icon={FolderKanban}
          tone="accent"
        />
        <StatCard
          label="Needs input"
          value={awaitingInput.length.toString()}
          description="Waiting on developer approval"
          icon={AlertTriangle}
          tone={awaitingInput.length > 0 ? 'warning' : 'neutral'}
        />
        <StatCard
          label="Live spend"
          value={formatPreciseCurrency(liveSpend)}
          description={`Across non-terminal ${RUN_NOUN.pluralLower}`}
          icon={Bot}
          tone="neutral"
        />
      </div>

      {error ? (
        <ErrorState title={`Could not load ${RUN_NOUN.pluralLower}`} message={error} />
      ) : null}

      {loading ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-72 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <OverviewList
            title={RUN_LIST_LABELS.activeRuns}
            jobs={activeSoloRuns.slice(0, 5)}
            emptyLabel={RUN_LIST_LABELS.emptyActive}
            icon={PlayCircle}
          />
          <OverviewList
            title={RUN_LIST_LABELS.activeWithSubRuns}
            jobs={activeWithSubRuns.slice(0, 5)}
            emptyLabel={RUN_LIST_LABELS.emptyWithSubRuns}
            icon={FolderKanban}
          />
          <OverviewList
            title={RUN_LIST_LABELS.awaitingInput}
            jobs={awaitingInput.slice(0, 5)}
            emptyLabel={RUN_LIST_LABELS.emptyAwaiting}
            icon={Inbox}
          />
          <OverviewList
            title={RUN_LIST_LABELS.recentlyFinished}
            jobs={recentHistory}
            emptyLabel={RUN_LIST_LABELS.emptyHistory}
            icon={Bot}
          />
        </div>
      )}
    </div>
  )
}
