import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  FolderKanban,
  Inbox,
  PlayCircle,
  Settings2,
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
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { requestJson } from '../lib/http'
import { deriveJobDescription, deriveJobTitle, getRunDetailPath, isCampaignJob, sortJobsByUpdatedAt } from '../lib/jobs'
import { isTerminalStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'
import type { Job } from '../types'

interface ConfigSnapshot {
  config: {
    anthropic?: { method?: string; apiKey?: string; oauthToken?: string }
    git?: { provider?: string; username?: string; token?: string }
  } | null
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
  const { anthropic, git } = snapshot.config
  const hasAnthropicCreds = anthropic?.method === 'claudeLogin' || Boolean(anthropic?.apiKey) || Boolean(anthropic?.oauthToken)

  if (!hasAnthropicCreds) missing.push('Anthropic credentials')
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
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">{deriveJobTitle(job)}</span>
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

function SetupBanner({ setup }: { setup: SetupSummary }) {
  const isFirstRun = setup.state === 'not-configured'
  const title = isFirstRun ? 'Finish runner setup' : 'Runner setup is incomplete'
  const description = isFirstRun
    ? 'The workbench is ready, but the runner still needs authentication and git settings before it can dispatch real work.'
    : 'One or more essentials are missing. Finish configuration so jobs and campaigns can run cleanly.'

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-warning-500/25 bg-warning-500/8 p-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-warning-500/25 bg-warning-500/10 text-warning-400">
          <AlertTriangle className="size-4" />
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
      <Button asChild variant="secondary">
        <Link to="/settings">
          <Settings2 />
          Open settings
        </Link>
      </Button>
    </div>
  )
}

export default function Home() {
  const { jobs, loading, error } = useJobs()
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    void requestJson<ConfigSnapshot>('/config')
      .then(data => {
        if (!cancelled) setSnapshot(data)
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ config: null })
      })

    return () => {
      cancelled = true
    }
  }, [])

  const setup = summariseConfig(snapshot)
  const sortedJobs = useMemo(() => sortJobsByUpdatedAt(jobs), [jobs])
  const activeJobs = sortedJobs.filter(job => !isCampaignJob(job) && !isTerminalStatus(job.status))
  const activeCampaigns = sortedJobs.filter(job => isCampaignJob(job) && !isTerminalStatus(job.status))
  const awaitingInput = sortedJobs.filter(job => job.status === 'awaiting-developer-input')
  const recentHistory = sortedJobs.filter(job => isTerminalStatus(job.status)).slice(0, 5)
  const liveSpend = sortedJobs
    .filter(job => !isTerminalStatus(job.status))
    .reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="What's live, what needs you, and what just finished."
        actions={
          <Button asChild>
            <Link to="/jobs/new">
              New run
              <ArrowRight />
            </Link>
          </Button>
        }
      />

      {setup.state !== 'configured' && setup.state !== 'loading' ? (
        <SetupBanner setup={setup} />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active jobs"
          value={activeJobs.length.toString()}
          description="Non-campaign work running or parked"
          icon={PlayCircle}
          tone="accent"
        />
        <StatCard
          label="Active campaigns"
          value={activeCampaigns.length.toString()}
          description="Campaigns coordinating child jobs"
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
          description="Across non-terminal runs"
          icon={Bot}
          tone="neutral"
        />
      </div>

      {error ? (
        <ErrorState title="Could not load jobs" message={error} />
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
            title="Active jobs"
            jobs={activeJobs.slice(0, 5)}
            emptyLabel="No active jobs. Dispatch one from the New run button."
            icon={PlayCircle}
          />
          <OverviewList
            title="Campaigns in motion"
            jobs={activeCampaigns.slice(0, 5)}
            emptyLabel="No campaigns are active right now."
            icon={FolderKanban}
          />
          <OverviewList
            title="Awaiting your input"
            jobs={awaitingInput.slice(0, 5)}
            emptyLabel="Nothing parked for approval or a response."
            icon={Inbox}
          />
          <OverviewList
            title="Recently finished"
            jobs={recentHistory}
            emptyLabel="Completed and failed runs will appear here."
            icon={Bot}
          />
        </div>
      )}
    </div>
  )
}
