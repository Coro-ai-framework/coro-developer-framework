import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  RefreshCcw,
  Send,
} from 'lucide-react'
import { Link, useLocation, useParams } from 'react-router-dom'
import ApprovalBox from '../components/ApprovalBox'
import ArtifactLink from '../components/ArtifactLink'
import CampaignView from '../components/CampaignView'
import ConnectionIndicator from '../components/ConnectionIndicator'
import LogViewer from '../components/LogViewer'
import StatusBadge from '../components/StatusBadge'
import WorkflowFlow from '../components/WorkflowFlow'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Select } from '../components/ui/select'
import { Separator } from '../components/ui/separator'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { formatDateTime, formatDuration, formatPreciseCurrency, formatRelativeTime, formatTokens } from '../lib/format'
import {
  deriveJobDescription,
  deriveJobTitle,
  deriveWorkflowLabel,
  getCurrentWorkItem,
  getRepoSlug,
  getReviewers,
  getRunDetailPath,
  getRunKindLabel,
  isCampaignJob,
} from '../lib/jobs'
import { jsonRequest, requestJson } from '../lib/http'
import { useJob } from '../hooks/useJob'
import { useJobStream } from '../hooks/useJobStream'
import { useRegisterWorkspaceTab } from '../providers/workspace-tabs'
import type { Job, PhaseUsage, TokenUsage, WorkflowPhase } from '../types'

type DetailTab = 'overview' | 'activity' | 'workflow' | 'campaign' | 'artifacts' | 'usage' | 'raw'

const RESUMABLE_STATUSES = new Set([
  'failed',
  'escalated',
  'awaiting-plan-approval',
  'awaiting-pr-merge',
  'queued',
  'planning',
  'coding',
  'reviewing',
  'testing',
  'evaluating',
  'spec-writing',
  'analysis',
  'repo-setup',
  'reporting',
  'campaign-planning',
  'coordinating',
  'aggregating',
])

const NON_RUNNING_STATUSES = new Set(['complete', 'failed', 'escalated', 'awaiting-plan-approval', 'awaiting-pr-merge'])

function deriveWorkflowPhases(job: Job | null): WorkflowPhase[] {
  if (!job) return []
  if (job.workflowPhases && job.workflowPhases.length > 0) return job.workflowPhases

  const seen = new Set<string>()
  const phases: WorkflowPhase[] = []
  for (const phase of job.phaseUsage ?? []) {
    if (!seen.has(phase.phase)) {
      seen.add(phase.phase)
      phases.push({ name: phase.phase, status: phase.phase })
    }
  }
  if (!seen.has(job.phase)) {
    phases.push({ name: job.phase, status: job.phase })
  }
  return phases
}

function MetricTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-white">{value}</div>
      {detail ? <div className="mt-1 text-sm text-slate-400">{detail}</div> : null}
    </div>
  )
}

function SummaryStat({
  label,
  value,
  detail,
  mono = false,
}: {
  label: string
  value: string
  detail?: string
  mono?: boolean
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mt-1 line-clamp-2 text-sm text-white ${mono ? 'font-mono' : 'font-medium'}`}>{value}</div>
      {detail ? <div className="mt-1 line-clamp-2 text-xs text-slate-500">{detail}</div> : null}
    </div>
  )
}

function AlertCard({ title, tone, children }: { title: string; tone: 'amber' | 'rose' | 'cyan'; children: React.ReactNode }) {
  const toneClasses = {
    amber: 'border-amber-500/25 bg-amber-500/10 text-amber-50',
    rose: 'border-rose-500/25 bg-rose-500/10 text-rose-50',
    cyan: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-50',
  }

  return (
    <Card className={toneClasses[tone]}>
      <CardContent className="pt-5">
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-1 text-sm opacity-85">{children}</div>
      </CardContent>
    </Card>
  )
}

function WorkItemsCard({ job }: { job: Job }) {
  if (!job.workItems || job.workItems.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Work Items</CardTitle>
          <CardDescription>No explicit work item breakdown was posted for this run.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const toneMap: Record<string, string> = {
    pending: 'bg-slate-500',
    'in-progress': 'bg-indigo-400',
    complete: 'bg-emerald-400',
    escalated: 'bg-rose-400',
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work Items</CardTitle>
        <CardDescription>Planner-defined units of work and their current loop counts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {job.workItems.map(item => (
          <div key={item.name} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
            <span className={`size-2 rounded-full ${toneMap[item.status] ?? 'bg-slate-500'}`} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{item.name}</div>
              <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{item.status}</div>
            </div>
            <div className="text-sm text-slate-400">loop {item.loopCount}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function TokenUsagePanel({ usage }: { usage?: TokenUsage }) {
  if (!usage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>Token usage will populate once this job has run through at least one model turn.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const totalTokens = usage.inputTokens + usage.outputTokens
  const cacheBase = usage.inputTokens + usage.cacheCreationInputTokens
  const cacheHitRate = cacheBase > 0 ? (usage.cacheReadInputTokens / cacheBase) * 100 : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>Token footprint, cache efficiency, and spend for the full run.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Total Tokens" value={formatTokens(totalTokens)} detail={`${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`} />
        <MetricTile label="Cache Read" value={formatTokens(usage.cacheReadInputTokens)} detail={`${formatTokens(usage.cacheCreationInputTokens)} cache writes`} />
        <MetricTile label="Hit Rate" value={cacheHitRate > 0 ? `${cacheHitRate.toFixed(0)}%` : '—'} detail="Across cache-eligible requests" />
        <MetricTile label="Spend" value={formatPreciseCurrency(usage.totalCostUsd)} detail="USD across all turns" />
      </CardContent>
    </Card>
  )
}

function PhaseUsageTable({ phases }: { phases: PhaseUsage[] }) {
  if (!phases.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Phase Usage</CardTitle>
          <CardDescription>No phase-level usage snapshots have been recorded yet.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by Phase</CardTitle>
        <CardDescription>Per-phase token consumption, wall time, and model selection.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-white/8 text-left text-[11px] uppercase tracking-[0.16em] text-slate-500">
              <th className="px-2 py-2 font-medium">Phase</th>
              <th className="px-2 py-2 font-medium text-right">Input</th>
              <th className="px-2 py-2 font-medium text-right">Output</th>
              <th className="px-2 py-2 font-medium text-right">Duration</th>
              <th className="px-2 py-2 font-medium text-right">Turns</th>
              <th className="px-2 py-2 font-medium text-right">Cost</th>
              <th className="px-2 py-2 font-medium">Model</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/8 text-slate-200">
            {phases.map((phase, index) => (
              <tr key={`${phase.phase}-${index}`}>
                <td className="px-2 py-3 font-medium text-white">{phase.phase}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatTokens(phase.inputTokens)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatTokens(phase.outputTokens)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatDuration(phase.durationMs)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{phase.numTurns}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatPreciseCurrency(phase.costUsd)}</td>
                <td className="px-2 py-3 text-slate-400">{phase.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function PhaseFocusCard({ job, selectedPhase, phases }: { job: Job; selectedPhase: string; phases: WorkflowPhase[] }) {
  const phaseArtifacts = (job.artifacts ?? []).filter(artifact => artifact.phase === selectedPhase)
  const phaseUsage = (job.phaseUsage ?? []).find(phase => phase.phase === selectedPhase)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{selectedPhase}</CardTitle>
        <CardDescription>
          {selectedPhase === job.phase ? 'This is the active phase for the job right now.' : 'Inspect the outputs and usage attached to this phase.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {phaseUsage ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <MetricTile label="Input" value={formatTokens(phaseUsage.inputTokens)} />
            <MetricTile label="Output" value={formatTokens(phaseUsage.outputTokens)} />
            <MetricTile label="Duration" value={formatDuration(phaseUsage.durationMs)} />
            <MetricTile label="Turns" value={phaseUsage.numTurns.toString()} />
          </div>
        ) : null}

        <Separator />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-white">Artifacts</div>
            <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{phaseArtifacts.length} items</div>
          </div>
          {phaseArtifacts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-5 text-sm text-slate-500">
              No artifacts have been posted for this phase yet.
            </div>
          ) : (
            <div className="space-y-3">
              {phaseArtifacts.map(artifact => (
                <ArtifactLink key={artifact.id} jobId={job.id} artifact={artifact} />
              ))}
            </div>
          )}
        </div>

        <Separator />

        <div className="text-xs uppercase tracking-[0.14em] text-slate-500">
          {phases.length > 0 ? `${phases.findIndex(phase => phase.name === selectedPhase) + 1} of ${phases.length} phases` : 'Phase order unavailable'}
        </div>
      </CardContent>
    </Card>
  )
}

function WorkflowSnapshotCard({
  job,
  selectedPhase,
  phases,
  onSelectPhase,
}: {
  job: Job
  selectedPhase: string | null
  phases: WorkflowPhase[]
  onSelectPhase: (phase: string) => void
}) {
  return (
    <Card>
      <CardHeader className="gap-2 border-b border-white/8 pb-4">
        <CardTitle>Workflow</CardTitle>
        <CardDescription>{deriveWorkflowLabel(job.workflowPath)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Path</div>
          <div className="mt-1 break-all font-mono text-xs text-slate-400">{job.workflowPath}</div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryStat label="Current" value={job.phase} detail={`${phases.length} phases`} />
          <SummaryStat label="Selected" value={selectedPhase ?? job.phase} detail="Change focus directly from the map." />
        </div>

        <WorkflowFlow
          job={job}
          phases={phases}
          selectedPhase={selectedPhase}
          onSelectPhase={onSelectPhase}
        />
      </CardContent>
    </Card>
  )
}

function JobSignalsCard({ job }: { job: Job }) {
  const reviewers = getReviewers(job)
  const repoSlug = getRepoSlug(job)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run Context</CardTitle>
        <CardDescription>Metadata and coordination signals attached to this run.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricTile label="Type" value={getRunKindLabel(job)} detail={job.type} />
          <MetricTile label="Phase" value={job.phase} detail={formatRelativeTime(job.updatedAt)} />
        </div>

        {repoSlug ? (
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Repository</div>
            <div className="mt-1 font-medium text-white">{repoSlug}</div>
          </div>
        ) : null}

        {reviewers.length > 0 ? (
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Reviewers</div>
            <div className="mt-1 text-slate-300">{reviewers.join(', ')}</div>
          </div>
        ) : null}

        {job.campaignParentId ? (
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Parent campaign</div>
            <Link to={getRunDetailPath({ id: job.campaignParentId })} className="mt-1 inline-flex items-center gap-2 font-mono text-cyan-300 hover:text-cyan-200">
              {job.campaignParentId}
            </Link>
          </div>
        ) : null}

        {job.awaitingEvent && job.status !== 'awaiting-developer-input' ? (
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Awaiting Event</div>
            <div className="mt-1 text-slate-300">{job.awaitingEvent}</div>
          </div>
        ) : null}

        {job.escalationMessage ? (
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-rose-50">
            <div className="text-[11px] uppercase tracking-[0.16em] text-rose-200/80">Escalation</div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{job.escalationMessage}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function MessageComposer({
  value,
  onChange,
  onSend,
  sending,
  error,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => Promise<void>
  sending: boolean
  error: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Send Message</CardTitle>
        <CardDescription>Push new context or instructions into the active run without waiting for a checkpoint.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div>
        ) : null}

        <Textarea
          rows={4}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Tell the agent what changed, what to prioritize, or where to look next…"
        />
        <div className="flex justify-end">
          <Button onClick={() => void onSend()} disabled={sending || !value.trim()}>
            <Send />
            {sending ? 'Sending…' : 'Send message'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ArtifactsBoard({ job, phases }: { job: Job; phases: WorkflowPhase[] }) {
  const order = phases.map(phase => phase.name)
  const grouped = new Map<string, typeof job.artifacts>()

  for (const artifact of job.artifacts ?? []) {
    const bucket = grouped.get(artifact.phase) ?? []
    bucket.push(artifact)
    grouped.set(artifact.phase, bucket)
  }

  const orderedPhases = Array.from(new Set([...order, ...Array.from(grouped.keys())]))

  return (
    <div className="space-y-4">
      {orderedPhases.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Artifacts</CardTitle>
            <CardDescription>No artifacts have been posted to this job yet.</CardDescription>
          </CardHeader>
        </Card>
      ) : orderedPhases.map(phase => {
        const artifacts = grouped.get(phase) ?? []
        return (
          <Card key={phase}>
            <CardHeader>
              <CardTitle>{phase}</CardTitle>
              <CardDescription>{artifacts.length} artifact{artifacts.length === 1 ? '' : 's'} attached to this phase.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {artifacts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-5 text-sm text-slate-500">No artifacts in this phase.</div>
              ) : artifacts.map(artifact => <ArtifactLink key={artifact.id} jobId={job.id} artifact={artifact} />)}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function JsonPanel({ label, data, defaultOpen = false }: { label: string; data: unknown; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.03]">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-white">{label}</summary>
      <Separator />
      <pre className="max-h-[420px] overflow-auto p-4 text-xs font-mono text-slate-200 whitespace-pre-wrap break-words">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  )
}

function ActionPanel({
  job,
  workflowPhases,
  resuming,
  resumePhase,
  clearSession,
  resumeError,
  onResumePhaseChange,
  onClearSessionChange,
  onResume,
  onRefresh,
}: {
  job: Job
  workflowPhases: WorkflowPhase[]
  resuming: boolean
  resumePhase: string
  clearSession: boolean
  resumeError: string | null
  onResumePhaseChange: (value: string) => void
  onClearSessionChange: (value: boolean) => void
  onResume: (fromPhase?: string, shouldClearSession?: boolean) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const canResume = RESUMABLE_STATUSES.has(job.status)

  return (
    <Card>
      <CardHeader className="gap-2 border-b border-white/8 pb-4">
        <CardTitle>Controls</CardTitle>
        <CardDescription>Refresh or resume this run.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="secondary" className="flex-1" onClick={() => void onRefresh()}>
            <RefreshCcw />
            Refresh
          </Button>
          {canResume ? (
            <Button className="flex-1" onClick={() => void onResume(resumePhase || undefined, clearSession)} disabled={resuming}>
              {resuming ? 'Resuming…' : 'Resume'}
            </Button>
          ) : null}
        </div>

        {canResume ? (
          <div className="space-y-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div>
              <label className="mb-2 block text-[11px] uppercase tracking-[0.16em] text-slate-500">Resume from phase</label>
              <Select value={resumePhase} onChange={event => onResumePhaseChange(event.target.value)}>
                <option value="">Current phase ({job.phase})</option>
                {workflowPhases.map(phase => (
                  <option key={phase.name} value={phase.name}>{phase.name}{phase.name === job.phase ? ' (current)' : ''}</option>
                ))}
              </Select>
            </div>
            <label className="flex items-start gap-3 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={clearSession}
                onChange={event => onClearSessionChange(event.target.checked)}
                className="mt-1 rounded border-white/12 bg-white/8"
              />
              <span>
                Start with a fresh session.
                <span className="block text-xs text-slate-500">Use this when the current conversation history is no longer useful.</span>
              </span>
            </label>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-slate-500">
            This run cannot be resumed from its current state.
          </div>
        )}

        {resumeError ? (
          <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">Resume failed: {resumeError}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  const location = useLocation()
  const campaignRoute = location.pathname.startsWith('/campaigns/')

  const { job, loading, error, refetch } = useJob(jobId)
  const { lines, status: connectionStatus, lastHeartbeat } = useJobStream(jobId)

  const [activeTab, setActiveTab] = useState<DetailTab>('activity')
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null)
  const [resumePhase, setResumePhase] = useState('')
  const [clearSession, setClearSession] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('')
  const [messageError, setMessageError] = useState<string | null>(null)
  const [sendingMessage, setSendingMessage] = useState(false)

  const campaignMode = job ? isCampaignJob(job) : campaignRoute

  useRegisterWorkspaceTab(jobId
    ? {
        id: jobId,
        kind: campaignMode ? 'campaign' : 'job',
        path: location.pathname,
        title: job ? deriveJobTitle(job) : jobId,
        subtitle: job?.phase,
      }
    : null)

  useEffect(() => {
    if (!job) return
    setSelectedPhase(previous => previous === null || previous === job.phase ? job.phase : previous)
  }, [job?.id, job?.phase])

  useEffect(() => {
    if (activeTab === 'campaign' && !campaignMode) {
      setActiveTab('activity')
    }
  }, [activeTab, campaignMode])

  useEffect(() => {
    if (!job) return
    if (NON_RUNNING_STATUSES.has(job.status) && job.status !== 'awaiting-developer-input') return

    const interval = window.setInterval(() => {
      void refetch()
    }, 4_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [job, refetch])

  const workflowPhases = useMemo(() => deriveWorkflowPhases(job ?? null), [job])
  const currentPhase = selectedPhase ?? job?.phase ?? ''

  async function handleResume(fromPhase?: string, shouldClearSession = false) {
    if (!jobId) return
    setResuming(true)
    setResumeError(null)
    try {
      const body: Record<string, unknown> = {}
      if (fromPhase) body.fromPhase = fromPhase
      if (shouldClearSession) body.clearSession = true
      await requestJson(`/jobs/${jobId}/resume`, jsonRequest(body, { method: 'POST' }))
      await refetch()
    } catch (resumeIssue) {
      setResumeError(resumeIssue instanceof Error ? resumeIssue.message : 'Resume failed')
    } finally {
      setResuming(false)
    }
  }

  async function postMessage(message: string) {
    if (!jobId) throw new Error('No job id')
    await requestJson(`/jobs/${jobId}/message`, jsonRequest({ message }, { method: 'POST' }))
    await refetch()
  }

  async function handleSendMessage() {
    if (!messageText.trim()) return
    setSendingMessage(true)
    setMessageError(null)
    try {
      await postMessage(messageText.trim())
      setMessageText('')
    } catch (sendIssue) {
      setMessageError(sendIssue instanceof Error ? sendIssue.message : 'Failed to send message')
    } finally {
      setSendingMessage(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-14 w-full" />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Skeleton className="h-[540px] w-full" />
          <Skeleton className="h-[420px] w-full" />
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
          <div className="text-lg font-semibold text-white">{error ?? 'Job not found'}</div>
          <p className="text-sm text-slate-400">The run could not be loaded. It may have been deleted or the runner could not reach its backing state store.</p>
          <Button asChild variant="outline">
            <Link to="/jobs">Back to runs</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const canSendMessage = !NON_RUNNING_STATUSES.has(job.status)
  const repoSlug = getRepoSlug(job)
  const description = deriveJobDescription(job)

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="space-y-4">
            <Link to="/jobs" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
              <ArrowLeft className="size-4" />
              Back to runs
            </Link>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-2xl sm:text-[2rem]">{deriveJobTitle(job)}</CardTitle>
                <StatusBadge status={job.status} />
                <span className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-400">
                  {getRunKindLabel(job).toLowerCase()}
                </span>
                <span className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-400">
                  {job.interactive ? 'interactive' : 'autonomous'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">
                <span className="font-mono">{job.id}</span>
                {repoSlug ? <span>{repoSlug}</span> : null}
                <span>updated {formatRelativeTime(job.updatedAt)}</span>
              </div>

              {description ? <p className="max-w-3xl line-clamp-2 text-sm text-slate-500">{description}</p> : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryStat label="Workflow" value={deriveWorkflowLabel(job.workflowPath)} detail={job.workflowPath} />
            <SummaryStat label="Current Phase" value={job.phase} detail={formatDateTime(job.createdAt)} />
            <SummaryStat label="Current Focus" value={getCurrentWorkItem(job)} detail={job.awaitingEvent ?? 'Live execution context'} />
            <SummaryStat label="Spend" value={formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)} detail={`${job.prMappings?.length ?? 0} PR mappings`} />
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as DetailTab)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="workflow">Workflow</TabsTrigger>
          {campaignMode ? <TabsTrigger value="campaign">Campaign</TabsTrigger> : null}
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-5">
              <PhaseFocusCard job={job} selectedPhase={currentPhase} phases={workflowPhases} />
              <WorkItemsCard job={job} />
            </div>
            <div className="space-y-5">
              <TokenUsagePanel usage={job.tokenUsage} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="activity" className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-5">
              {job.status === 'awaiting-developer-input' ? (
                <ApprovalBox job={job} onSend={postMessage} />
              ) : null}
              {canSendMessage && job.status !== 'awaiting-developer-input' ? (
                <MessageComposer
                  value={messageText}
                  onChange={setMessageText}
                  onSend={handleSendMessage}
                  sending={sendingMessage}
                  error={messageError}
                />
              ) : null}

              <Card>
                <CardHeader className="gap-4 border-b border-white/8 pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle>Live Console</CardTitle>
                    <CardDescription>Streaming runner output, tool execution summaries, and developer interventions.</CardDescription>
                  </div>
                  <ConnectionIndicator status={connectionStatus} lastHeartbeat={lastHeartbeat} />
                </CardHeader>
                <CardContent className="pt-5">
                  <LogViewer lines={lines} />
                </CardContent>
              </Card>
            </div>

            <div className="space-y-5">
              {job.campaignParentId ? (
                <AlertCard title="Spawned by campaign" tone="cyan">
                  This job is part of campaign{' '}
                  <Link to={getRunDetailPath({ id: job.campaignParentId })} className="font-mono text-cyan-200 underline underline-offset-2">{job.campaignParentId}</Link>
                  {typeof job.params['campaignChildName'] === 'string' ? ` as child ${job.params['campaignChildName'] as string}.` : '.'}
                </AlertCard>
              ) : null}

              {job.awaitingEvent && job.status !== 'awaiting-developer-input' ? (
                <AlertCard title="Awaiting external event" tone="amber">
                  {job.awaitingEvent}{job.awaitingPrId ? ` (PR #${job.awaitingPrId})` : ''}
                </AlertCard>
              ) : null}

              {job.escalationMessage ? (
                <AlertCard title="Escalation message" tone="rose">{job.escalationMessage}</AlertCard>
              ) : null}

              <WorkflowSnapshotCard
                job={job}
                selectedPhase={selectedPhase}
                phases={workflowPhases}
                onSelectPhase={setSelectedPhase}
              />

              <ActionPanel
                job={job}
                workflowPhases={workflowPhases}
                resuming={resuming}
                resumePhase={resumePhase}
                clearSession={clearSession}
                resumeError={resumeError}
                onResumePhaseChange={setResumePhase}
                onClearSessionChange={setClearSession}
                onResume={handleResume}
                onRefresh={refetch}
              />

              <JobSignalsCard job={job} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="workflow" className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Workflow Map</CardTitle>
              <CardDescription>Select a phase to inspect its artifacts and usage without leaving the detail workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              <WorkflowFlow
                job={job}
                phases={workflowPhases}
                selectedPhase={selectedPhase}
                onSelectPhase={setSelectedPhase}
              />
            </CardContent>
          </Card>
          <PhaseFocusCard job={job} selectedPhase={currentPhase} phases={workflowPhases} />
        </TabsContent>

        {campaignMode ? (
          <TabsContent value="campaign">
            <CampaignView job={job} onMutated={() => void refetch()} />
          </TabsContent>
        ) : null}

        <TabsContent value="artifacts">
          <ArtifactsBoard job={job} phases={workflowPhases} />
        </TabsContent>

        <TabsContent value="usage" className="space-y-5">
          <TokenUsagePanel usage={job.tokenUsage} />
          <PhaseUsageTable phases={job.phaseUsage ?? []} />
        </TabsContent>

        <TabsContent value="raw" className="space-y-4">
          <JsonPanel label="Job Parameters" data={job.params} defaultOpen />
          <JsonPanel label="Full Job Object" data={job} />
          {job.insights?.length > 0 ? <JsonPanel label={`Insights (${job.insights.length})`} data={job.insights} /> : null}
          {job.prMappings?.length > 0 ? <JsonPanel label={`PR Mappings (${job.prMappings.length})`} data={job.prMappings} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}
