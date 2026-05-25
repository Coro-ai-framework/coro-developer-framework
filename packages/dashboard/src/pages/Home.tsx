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
import { SettingsProvider, useSettings } from './Settings/SettingsContext'
import { evaluateReadiness } from './Settings/readiness'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
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

type SetupState = 'loading' | 'not-configured' | 'partial' | 'configured'

interface SetupSummary {
  state: SetupState
  missing: string[]
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
  const { draft, pluginsCatalogue, loading: settingsLoading, firstRunCompleted } = useSettings()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [autoLaunched, setAutoLaunched] = useState(false)

  // Derive readiness from the same plugin-based logic the wizard uses
  // (`evaluateReadiness`). This replaces the legacy `config.git.*`
  // field check that diverged from the wizard's source of truth and
  // gave users a misleading "Runner is ready" pill even when only
  // legacy keys were filled.
  const setup: SetupSummary = useMemo(() => {
    if (settingsLoading) return { state: 'loading', missing: [] }
    if (!pluginsCatalogue) return { state: 'loading', missing: [] }
    const readiness = evaluateReadiness({ draft, pluginsCatalogue })
    const llmReady = readiness.byId['llm-provider'].status === 'ok'
    const scmReady = readiness.byId['source-control'].status === 'ok'
    const missing: string[] = []
    if (!llmReady) missing.push('LLM provider')
    if (!scmReady) missing.push('Source control')
    if (missing.length === 0) return { state: 'configured', missing }
    // If nothing at all is set, prefer "not-configured" so the banner
    // copy reads "Welcome to Coro — finish setup" instead of the
    // generic "incomplete" message.
    const anyConfigured =
      Object.values(draft.pluginInstalled).some(
        entry =>
          (entry.enabled !== false) && Object.keys(entry.config ?? {}).length > 0,
      ) || !!draft.llmDefaultProvider
    return {
      state: anyConfigured ? 'partial' : 'not-configured',
      missing,
    }
  }, [draft, pluginsCatalogue, settingsLoading])

  const sortedJobs = useMemo(() => sortJobsByUpdatedAt(jobs), [jobs])
  const activeRuns = sortedJobs.filter(job => !isTerminalStatus(job.status))
  const activeSoloRuns = activeRuns.filter(job => !hostsSubRuns(job))
  const activeWithSubRuns = activeRuns.filter(job => hostsSubRuns(job))
  const awaitingInput = sortedJobs.filter(job => job.status === 'awaiting-developer-input')
  const recentHistory = sortedJobs.filter(job => isTerminalStatus(job.status)).slice(0, 5)
  const liveSpend = activeRuns.reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)

  // Auto-launch the wizard on first boot when nothing is configured
  // and the user has neither completed nor dismissed it before.
  // `firstRunCompleted` is driven by the server-side
  // `config.setup.completedAt` flag with a localStorage fallback,
  // so a finish on one device suppresses the prompt on the next.
  useEffect(() => {
    if (autoLaunched) return
    if (setup.state !== 'not-configured') return
    if (firstRunCompleted) return
    if (typeof window === 'undefined') return
    const dismissed = window.localStorage.getItem('coro.firstRun.dismissed') === 'true'
    if (dismissed) return
    setWizardOpen(true)
    setAutoLaunched(true)
  }, [setup.state, autoLaunched, firstRunCompleted])

  function handleWizardOpenChange(next: boolean) {
    setWizardOpen(next)
    if (!next && typeof window !== 'undefined' && !firstRunCompleted) {
      window.localStorage.setItem('coro.firstRun.dismissed', 'true')
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
