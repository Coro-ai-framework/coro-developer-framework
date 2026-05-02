import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Bot, FolderKanban, PlayCircle, Settings2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import StatCard from '../components/common/stat-card'
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

function OverviewList({ title, jobs, emptyLabel }: { title: string; jobs: Job[]; emptyLabel: string }) {
  return (
    <Card>
      <CardHeader className="border-b border-white/8 pb-4">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-5">
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500">{emptyLabel}</p>
        ) : (
          <div className="space-y-3">
            {jobs.map(job => {
              const detailPath = getRunDetailPath(job)

              return (
                <Link key={job.id} to={detailPath} className="flex items-start justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 transition-colors hover:border-white/14 hover:bg-white/[0.05]">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-sm font-medium text-white">{deriveJobTitle(job)}</div>
                      <StatusBadge status={job.status} />
                    </div>
                    <div className="truncate text-xs uppercase tracking-[0.16em] text-slate-500">{job.id}</div>
                    {deriveJobDescription(job) ? <div className="line-clamp-1 text-sm text-slate-400">{deriveJobDescription(job)}</div> : null}
                  </div>
                  <div className="shrink-0 text-right text-xs text-slate-500">{formatRelativeTime(job.updatedAt)}</div>
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
    <Card className="border-amber-500/25 bg-amber-500/10">
      <CardContent className="flex flex-col gap-4 pt-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-amber-500/25 bg-amber-500/12 p-3 text-amber-100">
            <AlertTriangle className="size-5" />
          </div>
          <div className="space-y-1.5">
            <div className="text-base font-semibold text-amber-50">{title}</div>
            <p className="max-w-2xl text-sm text-amber-100/80">{description}</p>
            {setup.missing.length > 0 ? (
              <div className="text-sm text-amber-100/80">Missing: {setup.missing.join(', ')}</div>
            ) : null}
          </div>
        </div>
        <Button asChild variant="outline" className="border-amber-400/30 bg-amber-400/10 text-amber-50 hover:bg-amber-400/15">
          <Link to="/settings">Open Settings</Link>
        </Button>
      </CardContent>
    </Card>
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
  const liveSpend = sortedJobs.filter(job => !isTerminalStatus(job.status)).reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operator Overview"
        title="Live workbench"
        description="What is live, what needs input, and what just finished."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/settings">
                <Settings2 />
                Settings
              </Link>
            </Button>
            <Button asChild>
              <Link to="/jobs/new">
                Dispatch run
                <ArrowRight />
              </Link>
            </Button>
          </>
        }
      />

      {setup.state !== 'configured' ? <SetupBanner setup={setup} /> : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active Jobs" value={activeJobs.length.toString()} description="Non-campaign work items currently running or parked." icon={PlayCircle} tone="indigo" />
        <StatCard label="Active Campaigns" value={activeCampaigns.length.toString()} description="Campaigns coordinating child jobs right now." icon={FolderKanban} tone="violet" />
        <StatCard label="Needs Input" value={awaitingInput.length.toString()} description="Jobs currently waiting for developer approval or answers." icon={AlertTriangle} tone="amber" />
        <StatCard label="Live Spend" value={formatPreciseCurrency(liveSpend)} description="Accumulated spend across non-terminal runs." icon={Bot} tone="cyan" />
      </div>

      {error ? (
        <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          Failed to load jobs: {error}
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-72 w-full" />)}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <OverviewList title="Active jobs" jobs={activeJobs.slice(0, 5)} emptyLabel="No active jobs. Dispatch work from the Jobs page or the quick action above." />
          <OverviewList title="Campaigns in motion" jobs={activeCampaigns.slice(0, 5)} emptyLabel="No campaigns are active right now." />
          <OverviewList title="Awaiting your input" jobs={awaitingInput.slice(0, 5)} emptyLabel="Nothing is parked for approval or a response." />
          <OverviewList title="Recent history" jobs={recentHistory} emptyLabel="Completed and failed runs will appear here once work starts flowing." />
        </div>
      )}
    </div>
  )
}
