import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Briefcase,
  Bug,
  ChevronDown,
  Clock3,
  GitPullRequest,
  Send,
} from 'lucide-react'
import { Link, useLocation, useParams } from 'react-router-dom'
import ApprovalBox from '../components/ApprovalBox'
import ArtifactLink from '../components/ArtifactLink'
import CampaignView from '../components/CampaignView'
import ConnectionIndicator from '../components/ConnectionIndicator'
import JobControlBar from '../components/JobControlBar'
import LogViewer from '../components/LogViewer'
import StatusBadge from '../components/StatusBadge'
import WorkflowFlow from '../components/WorkflowFlow'
import ErrorState from '../components/common/error-state'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Separator } from '../components/ui/separator'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { Badge } from '../components/ui/badge'
import { cn } from '../lib/utils'
import { formatDateTime, formatDuration, formatPreciseCurrency, formatRelativeTime, formatTokens } from '../lib/format'
import {
  deriveJobDescription,
  deriveJobTitle,
  deriveWorkflowLabel,
  getCurrentWorkItem,
  getRepoSlug,
  getReviewers,
  getRunDetailPath,
  isCampaignJob,
} from '../lib/jobs'
import {
  PAGE_TITLES,
  RUN_NOUN,
  RUNS_LIST_PATH,
  SUB_RUN_NOUN,
  getParentRunBreadcrumbLabel,
  getParentRunId,
  getRunWorkflowTag,
  hostsSubRuns,
} from '../lib/run-labels'
import { jsonRequest, requestJson } from '../lib/http'
import { useJob } from '../hooks/useJob'
import { useJobStream } from '../hooks/useJobStream'
import { useRegisterWorkspaceTab } from '../providers/workspace-tabs'
import type { Job, PhaseUsage, TokenUsage, WorkflowPhase } from '../types'
import type { Tone } from '../lib/status'
import { isRunningStatus, isTerminalStatus, isWaitingStatus } from '../lib/status'

type DetailTab = 'activity' | 'work' | 'diagnostics'

interface PendingOutgoingMessage {
  id: string
  text: string
  queuedAt: number
}

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

/* ─── Header ─────────────────────────────────────────────────────────────── */

function HeaderSummary({ job }: { job: Job }) {
  const repoSlug = getRepoSlug(job)
  const description = deriveJobDescription(job)
  const parentRunId = getParentRunId(job)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link
          to={RUNS_LIST_PATH}
          className="inline-flex items-center gap-1.5 text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="size-4" />
          {PAGE_TITLES.backToRuns}
        </Link>
        {parentRunId ? (
          <Link
            to={getRunDetailPath({ id: parentRunId })}
            className="inline-flex items-center gap-1.5 text-fg-muted transition-colors hover:text-fg"
          >
            <ArrowLeft className="size-4 opacity-60" />
            {getParentRunBreadcrumbLabel()}{' '}
            <span className="font-mono text-[12px]">{parentRunId}</span>
          </Link>
        ) : null}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[1.75rem] font-semibold tracking-tight text-fg sm:text-[2rem]">
            {deriveJobTitle(job)}
          </h1>
          <StatusBadge status={job.status} />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-subtle">
          <span
            className="rounded-md border border-line bg-overlay px-1.5 py-0.5 uppercase tracking-[0.14em]"
            title="Workflow"
          >
            {getRunWorkflowTag(job)}
          </span>
          {hostsSubRuns(job) ? (
            <span
              className="rounded-md border border-line bg-overlay px-1.5 py-0.5 uppercase tracking-[0.14em]"
              title={`Hosts ${SUB_RUN_NOUN.pluralLower}`}
            >
              {SUB_RUN_NOUN.pluralLower}
            </span>
          ) : null}
          <span className="font-mono">{job.id}</span>
          {repoSlug ? <span>· {repoSlug}</span> : null}
          <span>· updated {formatRelativeTime(job.updatedAt)}</span>
        </div>

        {description ? <ExpandableDescription description={description} /> : null}
      </div>
    </div>
  )
}

function ExpandableDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false)
  const canToggle = description.length > 140 || description.includes('\n')

  if (!canToggle) {
    return <p className="max-w-3xl text-sm text-fg-muted whitespace-pre-wrap break-words">{description}</p>
  }

  return (
    <div className="max-w-3xl text-sm text-fg-muted">
      <div className={cn('relative pr-9', !expanded && 'line-clamp-2')}>
        <span className="whitespace-pre-wrap break-words">{description}</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse description' : 'Expand description'}
          onClick={() => setExpanded(current => !current)}
          className="absolute right-0 bottom-0 inline-flex size-6 items-center justify-center rounded-md border border-line bg-panel/95 text-fg-subtle shadow-[var(--shadow-card)] transition-[color,transform,background-color] hover:bg-panel-raised hover:text-fg"
        >
          <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>
    </div>
  )
}

function HeaderMetricStrip({ job }: { job: Job }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
      <HeaderMetric label="Workflow" value={deriveWorkflowLabel(job.workflowPath)} detail={job.workflowPath} mono />
      <HeaderMetric label="Phase" value={job.phase} detail={`Started ${formatDateTime(job.createdAt)}`} />
      <HeaderMetric
        label="Working on"
        value={getCurrentWorkItem(job)}
        detail={job.awaitingEvent ?? 'Live execution'}
      />
      <HeaderMetric
        label="Spend"
        value={formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)}
        detail={`${job.prMappings?.length ?? 0} PR mappings`}
      />
    </div>
  )
}

function HeaderMetric({
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
    <div className="bg-panel p-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className={cn('mt-1 line-clamp-2 text-sm text-fg', mono ? 'font-mono' : 'font-medium')}>
        {value}
      </div>
      {detail ? <div className="mt-1 line-clamp-2 text-[11px] text-fg-subtle">{detail}</div> : null}
    </div>
  )
}

/* ─── Tab content blocks ─────────────────────────────────────────────────── */

function MetricTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-line bg-overlay/40 p-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className="mt-1 text-xl font-semibold text-fg">{value}</div>
      {detail ? <div className="mt-1 text-[12px] text-fg-muted">{detail}</div> : null}
    </div>
  )
}

function AlertCard({
  title,
  tone,
  children,
}: {
  title: string
  tone: Tone
  children: React.ReactNode
}) {
  const toneMap: Record<Tone, string> = {
    neutral: 'border-line bg-overlay/40 text-fg',
    accent: 'border-accent-500/25 bg-accent-500/8 text-fg',
    success: 'border-success-500/25 bg-success-500/8 text-fg',
    warning: 'border-warning-500/25 bg-warning-500/8 text-fg',
    danger: 'border-danger-500/25 bg-danger-500/8 text-fg',
  }

  return (
    <div className={cn('rounded-2xl border p-4', toneMap[tone])}>
      <div className="text-sm font-semibold text-fg">{title}</div>
      <div className="mt-1 text-sm text-fg-muted">{children}</div>
    </div>
  )
}

function WorkItemsCard({ job }: { job: Job }) {
  if (!job.workItems || job.workItems.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Work items</CardTitle>
          <CardDescription>No explicit work item breakdown was posted for this run.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const toneFor = (status: string): Tone => {
    if (status === 'complete') return 'success'
    if (status === 'in-progress') return 'accent'
    if (status === 'escalated') return 'danger'
    return 'neutral'
  }
  const dotFor = (tone: Tone): string => ({
    neutral: 'bg-fg-subtle',
    accent: 'bg-accent-400',
    success: 'bg-success-400',
    warning: 'bg-warning-400',
    danger: 'bg-danger-400',
  }[tone])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work items</CardTitle>
        <CardDescription>Planner-defined units of work and their loop counts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {job.workItems.map(item => {
          const tone = toneFor(item.status)
          return (
            <div
              key={item.name}
              className="flex items-center gap-3 rounded-xl border border-line bg-overlay/40 px-4 py-2.5"
            >
              <span className={cn('size-2 rounded-full', dotFor(tone), item.status === 'in-progress' && 'animate-pulse-dot')} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{item.name}</div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{item.status}</div>
              </div>
              <div className="text-[12px] text-fg-muted">loop {item.loopCount}</div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function TokenUsagePanel({ usage }: { usage?: TokenUsage }) {
  if (!usage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Token usage</CardTitle>
          <CardDescription>
            Token usage will populate once this job has run through at least one model turn.
          </CardDescription>
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
        <CardTitle>Token usage</CardTitle>
        <CardDescription>Token footprint, cache efficiency, and spend for the full run.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Total"
          value={formatTokens(totalTokens)}
          detail={`${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`}
        />
        <MetricTile
          label="Cache read"
          value={formatTokens(usage.cacheReadInputTokens)}
          detail={`${formatTokens(usage.cacheCreationInputTokens)} cache writes`}
        />
        <MetricTile
          label="Hit rate"
          value={cacheHitRate > 0 ? `${cacheHitRate.toFixed(0)}%` : '—'}
          detail="Across cache-eligible requests"
        />
        <MetricTile
          label="Spend"
          value={formatPreciseCurrency(usage.totalCostUsd)}
          detail="USD across all turns"
        />
      </CardContent>
    </Card>
  )
}

function PhaseUsageTable({ phases }: { phases: PhaseUsage[] }) {
  if (!phases.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage by phase</CardTitle>
          <CardDescription>No phase-level usage snapshots have been recorded yet.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by phase</CardTitle>
        <CardDescription>Per-phase token consumption, wall time, and model selection.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
              <th className="px-2 py-2 font-medium">Phase</th>
              <th className="px-2 py-2 text-right font-medium">Input</th>
              <th className="px-2 py-2 text-right font-medium">Output</th>
              <th className="px-2 py-2 text-right font-medium">Duration</th>
              <th className="px-2 py-2 text-right font-medium">Turns</th>
              <th className="px-2 py-2 text-right font-medium">Cost</th>
              <th className="px-2 py-2 font-medium">Model</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line text-fg">
            {phases.map((phase, index) => (
              <tr key={`${phase.phase}-${index}`}>
                <td className="px-2 py-3 font-medium text-fg">{phase.phase}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatTokens(phase.inputTokens)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatTokens(phase.outputTokens)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatDuration(phase.durationMs)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{phase.numTurns}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatPreciseCurrency(phase.costUsd)}</td>
                <td className="px-2 py-3 text-fg-muted">{phase.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function JobAlerts({ job }: { job: Job }) {
  const parentRunId = getParentRunId(job)

  if (!parentRunId && !job.awaitingEvent && !job.escalationMessage) {
    return null
  }

  return (
    <div className="space-y-3">
      {parentRunId ? (
        <AlertCard title={`Dispatched as a ${SUB_RUN_NOUN.singularLower}`} tone="accent">
          {`This ${RUN_NOUN.singularLower} runs as a ${SUB_RUN_NOUN.singularLower} of `}
          <Link
            to={getRunDetailPath({ id: parentRunId })}
            className="font-mono text-accent-300 underline underline-offset-2"
          >
            {parentRunId}
          </Link>
          {typeof job.params['campaignChildName'] === 'string'
            ? ` (named ${job.params['campaignChildName'] as string}).`
            : '.'}
        </AlertCard>
      ) : null}

      {job.awaitingEvent && job.status !== 'awaiting-developer-input' ? (
        <AlertCard title="Awaiting external event" tone="warning">
          {job.awaitingEvent}
          {job.awaitingPrId ? ` (PR #${job.awaitingPrId})` : ''}
        </AlertCard>
      ) : null}

      {job.escalationMessage ? (
        <AlertCard title="Escalation message" tone="danger">
          {job.escalationMessage}
        </AlertCard>
      ) : null}
    </div>
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
  const selectedPhaseName = selectedPhase ?? job.phase
  const selectedPhaseArtifacts = (job.artifacts ?? []).filter(artifact => artifact.phase === selectedPhaseName)
  const phaseUsage = (job.phaseUsage ?? []).find(phase => phase.phase === selectedPhaseName)

  return (
    <Card>
      <CardHeader className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>{deriveWorkflowLabel(job.workflowPath)}</CardTitle>
            <CardDescription>{phases.length} phases · click any to inspect</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            <span>current</span>
            <Badge variant="neutral" className="border-line bg-overlay text-fg">
              {job.phase}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        <WorkflowFlow
          job={job}
          phases={phases}
          selectedPhase={selectedPhase}
          onSelectPhase={onSelectPhase}
        />

        <div className="rounded-2xl border border-line bg-overlay/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
                Selected phase
              </div>
              <div className="text-base font-semibold text-fg">{selectedPhaseName}</div>
            </div>
            {phaseUsage ? (
              <div className="flex flex-wrap gap-4 text-[12px] text-fg-muted">
                <span><span className="text-fg-subtle">in</span> <span className="tabular-nums text-fg">{formatTokens(phaseUsage.inputTokens)}</span></span>
                <span><span className="text-fg-subtle">out</span> <span className="tabular-nums text-fg">{formatTokens(phaseUsage.outputTokens)}</span></span>
                <span><span className="text-fg-subtle">turns</span> <span className="tabular-nums text-fg">{phaseUsage.numTurns}</span></span>
                <span><span className="text-fg-subtle">duration</span> <span className="tabular-nums text-fg">{formatDuration(phaseUsage.durationMs)}</span></span>
              </div>
            ) : null}
          </div>

          <div className="mt-3">
            <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
              Phase artifacts
            </div>
            {selectedPhaseArtifacts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-3 text-[13px] text-fg-subtle">
                No artifacts have been posted for this phase yet.
              </div>
            ) : (
              <div className="grid gap-2 xl:grid-cols-2">
                {selectedPhaseArtifacts.map(artifact => (
                  <ArtifactLink key={artifact.id} jobId={job.id} artifact={artifact} />
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function MessageComposer({
  title = 'Send message',
  description = 'Send additional guidance into the live run. Multiple messages are allowed.',
  submitLabel = 'Send message',
  value,
  onChange,
  onSend,
  error,
}: {
  title?: string
  description?: string
  submitLabel?: string
  value: string
  onChange: (value: string) => void
  onSend: () => Promise<void>
  error: string | null
}) {
  return (
    <Card>
      <CardHeader className="gap-1.5 pb-4">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5 pt-0">
        {error ? <ErrorState message={error} /> : null}
        <Textarea
          rows={3}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Tell the agent what changed, what to prioritize, or where to look next…"
          className="min-h-24"
        />
        <div className="flex justify-end">
          <Button onClick={() => void onSend()} disabled={!value.trim()} size="sm">
            <Send />
            {submitLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function PendingOutgoingMessages({ messages }: { messages: PendingOutgoingMessage[] }) {
  if (messages.length === 0) return null

  return (
    <div className="border-t border-line pt-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
        <Clock3 className="size-3.5" />
        Pending messages
      </div>

      <div className="space-y-2">
        {messages.map((message, index) => (
          <div key={message.id} className="rounded-xl border border-line bg-overlay/35 px-3 py-2.5">
            <div className="flex items-start gap-2.5">
              <Clock3 className="mt-0.5 size-3.5 shrink-0 text-warning-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-fg whitespace-pre-wrap break-words">{message.text}</div>
                <div className="mt-1 text-[11px] text-fg-subtle">
                  {index === 0
                    ? `Waiting for the next safe point. Queued ${formatRelativeTime(message.queuedAt)}.`
                    : `Queued behind ${index} earlier message${index === 1 ? '' : 's'} since ${formatRelativeTime(message.queuedAt)}.`}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
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

  if (orderedPhases.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Artifacts</CardTitle>
          <CardDescription>No artifacts have been posted to this job yet.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="border-b border-line pb-4">
        <CardTitle>Artifacts</CardTitle>
        <CardDescription>All artifacts grouped by their workflow phase.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        {orderedPhases.map(phase => {
          const artifacts = grouped.get(phase) ?? []
          return (
            <div key={phase} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{phase}</div>
                <div className="text-[11px] text-fg-subtle">
                  {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}
                </div>
              </div>
              {artifacts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-4 py-3 text-[13px] text-fg-subtle">
                  No artifacts in this phase.
                </div>
              ) : (
                <div className="grid gap-2 xl:grid-cols-2">
                  {artifacts.map(artifact => (
                    <ArtifactLink key={artifact.id} jobId={job.id} artifact={artifact} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function JsonPanel({ label, data, defaultOpen = false }: { label: string; data: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-overlay/30">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-overlay/60"
      >
        <span className="text-sm font-medium text-fg">{label}</span>
        <ChevronDown className={cn('size-4 text-fg-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <pre className="max-h-[420px] overflow-auto border-t border-line p-4 font-mono text-[12px] text-fg whitespace-pre-wrap break-words">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function ContextPanel({ job }: { job: Job }) {
  const reviewers = getReviewers(job)
  const repoSlug = getRepoSlug(job)
  const parentRunId = getParentRunId(job)

  const rows: Array<{ label: string; value: React.ReactNode }> = []
  rows.push({ label: 'Workflow', value: getRunWorkflowTag(job) })
  rows.push({ label: 'Phase', value: job.phase })
  if (repoSlug) rows.push({ label: 'Repository', value: repoSlug })
  if (reviewers.length > 0) rows.push({ label: 'Reviewers', value: reviewers.join(', ') })
  if (parentRunId) {
    rows.push({
      label: getParentRunBreadcrumbLabel(),
      value: (
        <Link
          to={getRunDetailPath({ id: parentRunId })}
          className="font-mono text-accent-300 hover:text-accent-400"
        >
          {parentRunId}
        </Link>
      ),
    })
  }
  if (job.prMappings && job.prMappings.length > 0) {
    rows.push({
      label: 'Pull requests',
      value: (
        <div className="flex items-center gap-1.5 text-fg-muted">
          <GitPullRequest className="size-3.5" />
          {job.prMappings.length} mapping{job.prMappings.length === 1 ? '' : 's'}
        </div>
      ),
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Context</CardTitle>
        <CardDescription>{`${RUN_NOUN.singular} metadata and coordination signals.`}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{row.label}</span>
            <span className="text-right text-fg">{row.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  const location = useLocation()

  const { job, loading, error, refetch } = useJob(jobId)
  const shouldStream = job ? !isTerminalStatus(job.status) : true
  const { lines, status: connectionStatus, lastHeartbeat } = useJobStream(jobId, shouldStream)

  /** Last `job.phase` from the server — used to detect "following" vs user-pinned phase inspection. */
  const prevServerPhaseRef = useRef<string | undefined>(undefined)
  /** How many stream lines we've already scanned for phase events (per job). */
  const streamLinesProcessedRef = useRef(0)

  const [activeTab, setActiveTab] = useState<DetailTab>('activity')
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null)
  const [resumePhase, setResumePhase] = useState('')
  const [clearSession, setClearSession] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [pausing, setPausing] = useState(false)
  const [pauseError, setPauseError] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('')
  const [messageError, setMessageError] = useState<string | null>(null)
  const [pendingOutgoingMessages, setPendingOutgoingMessages] = useState<PendingOutgoingMessage[]>([])
  const [refreshing, setRefreshing] = useState(false)
  /** Optimistic override for `job.interactive` while a PATCH is in flight.
   *  Cleared once the server-side value catches up. */
  const [interactiveOverride, setInteractiveOverride] = useState<boolean | undefined>(undefined)
  const pendingOutgoingMessagesRef = useRef<PendingOutgoingMessage[]>([])
  const drainingOutgoingQueueRef = useRef(false)
  const outgoingQueueTokenRef = useRef(0)

  const carriesSubRuns = job ? isCampaignJob(job) : false

  useRegisterWorkspaceTab(jobId
    ? {
        id: jobId,
        kind: 'run',
        path: location.pathname,
        title: job ? deriveJobTitle(job) : jobId,
        subtitle: job?.phase,
      }
    : null)

  useEffect(() => {
    prevServerPhaseRef.current = undefined
    streamLinesProcessedRef.current = 0
    setSelectedPhase(null)
    outgoingQueueTokenRef.current += 1
    pendingOutgoingMessagesRef.current = []
    drainingOutgoingQueueRef.current = false
    setPendingOutgoingMessages([])
  }, [jobId])

  useEffect(() => {
    if (!job) return
    const prevServer = prevServerPhaseRef.current
    prevServerPhaseRef.current = job.phase

    setSelectedPhase(userSelection => {
      if (userSelection === null) return job.phase

      // First REST snapshot after load / navigation: align with server
      if (prevServer === undefined) return job.phase

      // Selection tracked the phase the server reported on the prior tick → keep following progress
      if (userSelection === prevServer) return job.phase

      // User pinned a different phase than the active one for inspection → keep pinned
      return userSelection
    })
  }, [job?.id, job?.phase])

  // Refetch promptly when logs report a phase boundary (SSE is ahead of polling).
  useEffect(() => {
    if (lines.length <= streamLinesProcessedRef.current) {
      streamLinesProcessedRef.current = lines.length
      return
    }
    const batch = lines.slice(streamLinesProcessedRef.current)
    streamLinesProcessedRef.current = lines.length
    if (batch.some(line => line.lineType === 'phase')) {
      void refetch()
    }
  }, [lines, refetch])

  useEffect(() => {
    if (!job) return
    if (isTerminalStatus(job.status)) return

    const interval = window.setInterval(() => {
      void refetch()
    }, 4_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [job?.id, job?.status, refetch])

  const workflowPhases = useMemo(() => deriveWorkflowPhases(job ?? null), [job])

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

  async function handleCancel() {
    if (!jobId) return
    if (!window.confirm('Cancel this run? It will stop at the next safe boundary and will not auto-resume.')) {
      return
    }

    setCancelling(true)
    setCancelError(null)
    try {
      await requestJson(`/jobs/${jobId}/cancel`, jsonRequest({}, { method: 'POST' }))
      await refetch()
    } catch (cancelIssue) {
      setCancelError(cancelIssue instanceof Error ? cancelIssue.message : 'Cancel failed')
    } finally {
      setCancelling(false)
    }
  }

  async function handlePause() {
    if (!jobId) return
    setPausing(true)
    setPauseError(null)
    try {
      await requestJson(`/jobs/${jobId}/pause`, jsonRequest({}, { method: 'POST' }))
      await refetch()
    } catch (pauseIssue) {
      setPauseError(pauseIssue instanceof Error ? pauseIssue.message : 'Pause failed')
    } finally {
      setPausing(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }

  // Drop the optimistic override once the server-side value matches.
  useEffect(() => {
    if (!job) return
    if (interactiveOverride !== undefined && interactiveOverride === job.interactive) {
      setInteractiveOverride(undefined)
    }
  }, [job?.interactive, interactiveOverride])

  function updatePendingOutgoingMessages(
    updater: (messages: PendingOutgoingMessage[]) => PendingOutgoingMessage[],
  ) {
    setPendingOutgoingMessages(current => {
      const next = updater(current)
      pendingOutgoingMessagesRef.current = next
      return next
    })
  }

  async function postMessage(message: string) {
    if (!jobId) throw new Error('No job id')
    await requestJson(`/jobs/${jobId}/message`, jsonRequest({ message }, { method: 'POST' }))
    void refetch()
  }

  async function drainPendingOutgoingMessages() {
    if (drainingOutgoingQueueRef.current) return

    drainingOutgoingQueueRef.current = true
    const queueToken = outgoingQueueTokenRef.current

    try {
      while (outgoingQueueTokenRef.current === queueToken) {
        const next = pendingOutgoingMessagesRef.current[0]
        if (!next) break

        try {
          await postMessage(next.text)
          if (outgoingQueueTokenRef.current !== queueToken) return
          setMessageError(null)
        } catch (sendIssue) {
          if (outgoingQueueTokenRef.current !== queueToken) return
          setMessageError(sendIssue instanceof Error ? sendIssue.message : 'Failed to send message')
        } finally {
          if (outgoingQueueTokenRef.current !== queueToken) return
          updatePendingOutgoingMessages(messages => messages.filter(message => message.id !== next.id))
        }
      }
    } finally {
      if (outgoingQueueTokenRef.current === queueToken) {
        drainingOutgoingQueueRef.current = false
      }
    }
  }

  async function handleSendMessage() {
    const text = messageText.trim()
    if (!text) return

    setMessageError(null)
    setMessageText('')

    updatePendingOutgoingMessages(messages => [
      ...messages,
      {
        id: crypto.randomUUID(),
        text,
        queuedAt: Date.now(),
      },
    ])

    void drainPendingOutgoingMessages()
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Skeleton className="h-[520px] w-full" />
          <Skeleton className="h-[420px] w-full" />
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
          <div className="text-lg font-semibold text-fg">
            {error ?? `${RUN_NOUN.singular} not found`}
          </div>
          <p className="max-w-md text-sm text-fg-muted">
            {`The ${RUN_NOUN.singularLower} could not be loaded. It may have been deleted or the runner could not reach its backing state store.`}
          </p>
          <Button asChild variant="secondary">
            <Link to={RUNS_LIST_PATH}>{PAGE_TITLES.backToRuns}</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  // The composer accepts messages whenever the agent could plausibly
  // act on them — while running, AND while parked on any waiting
  // status (awaiting-pr-merge, awaiting-plan-approval,
  // awaiting-developer-input, awaiting-children). The dispatcher
  // routes parked-message sends through the resume path, so a
  // developer can steer / cancel the wait / add context without
  // having to wait for a webhook.
  const canSendLiveMessage =
    (isRunningStatus(job.status) && connectionStatus !== 'disconnected')
    || isWaitingStatus(job.status)
  const canReplyToEscalation = job.status === 'escalated'

  return (
    <div className="space-y-6">
      <HeaderSummary job={job} />

      <JobAlerts job={job} />

      <JobControlBar
        job={job}
        workflowPhases={workflowPhases}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        cancelling={cancelling}
        cancelError={cancelError}
        onCancel={handleCancel}
        pausing={pausing}
        pauseError={pauseError}
        onPause={handlePause}
        resuming={resuming}
        resumeError={resumeError}
        resumePhase={resumePhase}
        clearSession={clearSession}
        onResumePhaseChange={setResumePhase}
        onClearSessionChange={setClearSession}
        onResume={handleResume}
        interactiveOverride={interactiveOverride}
        onInteractiveChange={setInteractiveOverride}
      />

      <HeaderMetricStrip job={job} />

      <WorkflowSnapshotCard
        job={job}
        selectedPhase={selectedPhase}
        phases={workflowPhases}
        onSelectPhase={setSelectedPhase}
      />

      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as DetailTab)}>
        <TabsList>
          <TabsTrigger value="activity" className="gap-1.5">
            <Activity className="size-3.5 shrink-0" aria-hidden="true" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="work" className="gap-1.5">
            <Briefcase className="size-3.5 shrink-0" aria-hidden="true" />
            Work
          </TabsTrigger>
          <TabsTrigger value="diagnostics" className="gap-1.5">
            <Bug className="size-3.5 shrink-0" aria-hidden="true" />
            Diagnostics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              {job.status === 'awaiting-developer-input' ? (
                <ApprovalBox job={job} onSend={postMessage} />
              ) : null}

              {canReplyToEscalation ? (
                <MessageComposer
                  title="Reply to escalation"
                  description="Send guidance back into the parked run. Your reply will resume the current phase in the existing job."
                  submitLabel="Send reply"
                  value={messageText}
                  onChange={setMessageText}
                  onSend={handleSendMessage}
                  error={messageError}
                />
              ) : null}

              <Card>
                <CardHeader className="gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle>Live console</CardTitle>
                    <CardDescription>
                      Streaming runner output, tool execution summaries, and developer interventions.
                    </CardDescription>
                  </div>
                  <ConnectionIndicator status={connectionStatus} lastHeartbeat={lastHeartbeat} />
                </CardHeader>
                <CardContent className="space-y-4 pt-5">
                  <LogViewer lines={lines} />
                  <PendingOutgoingMessages messages={pendingOutgoingMessages} />
                </CardContent>
              </Card>

              {canSendLiveMessage ? (
                <MessageComposer
                  value={messageText}
                  onChange={setMessageText}
                  onSend={handleSendMessage}
                  error={messageError}
                />
              ) : null}
            </div>

            <div className="space-y-4">
              <ContextPanel job={job} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="work" className="space-y-5">
          <WorkItemsCard job={job} />
          {carriesSubRuns ? <CampaignView job={job} onMutated={() => void refetch()} /> : null}
          <ArtifactsBoard job={job} phases={workflowPhases} />
        </TabsContent>

        <TabsContent value="diagnostics" className="space-y-5">
          <TokenUsagePanel usage={job.tokenUsage} />
          <PhaseUsageTable phases={job.phaseUsage ?? []} />

          <Card>
            <CardHeader className="border-b border-line pb-4">
              <CardTitle>Raw state</CardTitle>
              <CardDescription>
                Inspect the underlying job object, parameters, insights, and PR mappings.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 pt-5">
              <JsonPanel label="Job parameters" data={job.params} defaultOpen />
              <JsonPanel label="Full job object" data={job} />
              {job.insights?.length > 0 ? (
                <JsonPanel label={`Insights (${job.insights.length})`} data={job.insights} />
              ) : null}
              {job.prMappings?.length > 0 ? (
                <JsonPanel label={`PR mappings (${job.prMappings.length})`} data={job.prMappings} />
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Separator className="opacity-0" />
    </div>
  )
}
