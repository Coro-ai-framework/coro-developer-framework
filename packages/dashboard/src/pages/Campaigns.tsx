import { useMemo, useState } from 'react'
import { ArrowRight, FolderKanban, Layers3, PlayCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import StatCard from '../components/common/stat-card'
import EmptyState from '../components/common/empty-state'
import StatusBadge from '../components/StatusBadge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import Progress from '../components/ui/progress'
import { Skeleton } from '../components/ui/skeleton'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { deriveJobDescription, deriveJobTitle, isCampaignJob, sortJobsByUpdatedAt } from '../lib/jobs'
import { isTerminalStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'
import type { CampaignChildStatus, Job } from '../types'

interface CampaignProgress {
  total: number
  done: number
  active: number
  blocked: number
}

function getCampaignProgress(job: Job): CampaignProgress {
  const children = job.campaignChildren ?? []

  return children.reduce<CampaignProgress>((acc, child) => {
    acc.total += 1
    if (child.status === 'complete' || child.status === 'skipped') acc.done += 1
    if (child.status === 'dispatched' || child.status === 'ready') acc.active += 1
    if (child.status === 'failed' || child.status === 'escalated') acc.blocked += 1
    return acc
  }, { total: 0, done: 0, active: 0, blocked: 0 })
}

function statusCounts(job: Job) {
  return (job.campaignChildren ?? []).reduce<Record<CampaignChildStatus, number>>((acc, child) => {
    acc[child.status] += 1
    return acc
  }, { pending: 0, ready: 0, dispatched: 0, complete: 0, failed: 0, escalated: 0, skipped: 0 })
}

export default function Campaigns() {
  const { jobs, loading, error } = useJobs()
  const [query, setQuery] = useState('')

  const campaigns = useMemo(() => sortJobsByUpdatedAt(jobs.filter(isCampaignJob)), [jobs])
  const visibleCampaigns = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return campaigns

    return campaigns.filter(job => {
      const haystack = [job.id, deriveJobTitle(job), deriveJobDescription(job), job.phase]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(search)
    })
  }, [campaigns, query])

  const activeCount = campaigns.filter(job => !isTerminalStatus(job.status)).length
  const blockedCount = campaigns.filter(job => job.status === 'failed' || job.status === 'escalated').length
  const childTotal = campaigns.reduce((sum, campaign) => sum + (campaign.campaignChildren?.length ?? 0), 0)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Campaign Control"
        title="Campaigns"
        description="Track multi-work-item campaigns, dependency progress, and child execution without leaving the operator workspace."
        actions={
          <Button asChild>
            <Link to="/jobs/new">
              Launch Campaign Seed
              <ArrowRight />
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Campaigns" value={campaigns.length.toString()} description="All campaigns visible to this runner." icon={FolderKanban} tone="violet" />
        <StatCard label="Running" value={activeCount.toString()} description="Campaigns currently coordinating work." icon={PlayCircle} tone="cyan" />
        <StatCard label="Child Jobs" value={childTotal.toString()} description={`${blockedCount} campaigns currently blocked or escalated.`} icon={Layers3} tone="amber" />
      </div>

      <Card>
        <CardHeader className="gap-4 border-b border-white/8 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>Campaign Registry</CardTitle>
            <p className="text-sm text-slate-400">Each campaign is still a job under the hood, but this view surfaces campaign-specific progress first.</p>
          </div>
          <div className="w-full sm:w-80">
            <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search campaigns by name, id, or phase" />
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          {error ? (
            <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              Failed to load campaigns: {error}
            </div>
          ) : loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-28 w-full" />
              ))}
            </div>
          ) : visibleCampaigns.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title="No campaigns yet"
              description="Campaign jobs will appear here once the planner converts work into a campaign workflow."
              action={<Button asChild><Link to="/jobs/new">Create work</Link></Button>}
            />
          ) : (
            <div className="space-y-4">
              {visibleCampaigns.map(campaign => {
                const progress = getCampaignProgress(campaign)
                const counts = statusCounts(campaign)
                const completedRatio = progress.total === 0 ? 0 : (progress.done / progress.total) * 100

                return (
                  <Link
                    key={campaign.id}
                    to={`/campaigns/${campaign.id}`}
                    className="block rounded-2xl border border-white/8 bg-white/[0.03] p-4 transition-colors hover:border-indigo-400/30 hover:bg-white/[0.045]"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 flex-1 space-y-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="truncate text-lg font-semibold text-white">{deriveJobTitle(campaign)}</h2>
                            <StatusBadge status={campaign.status} />
                          </div>
                          <div className="text-xs uppercase tracking-[0.16em] text-slate-500">{campaign.id}</div>
                          {deriveJobDescription(campaign) ? <p className="text-sm text-slate-400">{deriveJobDescription(campaign)}</p> : null}
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-slate-500">
                            <span>Child progress</span>
                            <span>{progress.done}/{progress.total || 0} done</span>
                          </div>
                          <Progress value={completedRatio} />
                        </div>

                        <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                          {counts.ready > 0 ? <span>{counts.ready} ready</span> : null}
                          {counts.dispatched > 0 ? <span>{counts.dispatched} running</span> : null}
                          {counts.pending > 0 ? <span>{counts.pending} pending</span> : null}
                          {counts.failed > 0 ? <span>{counts.failed} failed</span> : null}
                          {counts.escalated > 0 ? <span>{counts.escalated} escalated</span> : null}
                        </div>
                      </div>

                      <div className="grid shrink-0 grid-cols-2 gap-4 text-sm lg:min-w-[260px]">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Phase</div>
                          <div className="font-medium text-slate-100">{campaign.phase}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Updated</div>
                          <div className="font-medium text-slate-100">{formatRelativeTime(campaign.updatedAt)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Child jobs</div>
                          <div className="font-medium text-slate-100">{progress.total}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Cost</div>
                          <div className="font-medium text-slate-100">{formatPreciseCurrency(campaign.tokenUsage?.totalCostUsd ?? 0)}</div>
                        </div>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}