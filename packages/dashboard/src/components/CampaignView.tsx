import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Layers3, RotateCcw, SkipForward, SquareSlash } from 'lucide-react'
import type { CampaignChild, CampaignChildStatus, Job, TokenUsage } from '../types'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import Progress from './ui/progress'
import { Badge } from './ui/badge'
import { requestJson, jsonRequest } from '../lib/http'
import { formatCompactNumber, formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { cn } from '../lib/utils'
import { toneClasses, toneDotClasses, type Tone } from '../lib/status'

const CHILD_TONE: Record<CampaignChildStatus, Tone> = {
  pending: 'neutral',
  ready: 'accent',
  dispatched: 'accent',
  complete: 'success',
  failed: 'danger',
  escalated: 'danger',
  skipped: 'neutral',
}

const TERMINAL_CHILD: CampaignChildStatus[] = ['complete', 'failed', 'escalated', 'skipped']

function ChildStatusPill({ status }: { status: CampaignChildStatus }) {
  const tone = CHILD_TONE[status]
  const isLive = status === 'dispatched'
  return (
    <Badge variant="neutral" className={toneClasses(tone)}>
      <span className={cn('size-1.5 rounded-full', toneDotClasses(tone), isLive && 'animate-pulse-dot')} />
      {status}
    </Badge>
  )
}

function formatTokens(n: number): string {
  return formatCompactNumber(n)
}

function aggregateUsage(children: CampaignChild[]): TokenUsage & { totalDurationMs: number } {
  const sum = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
  }
  for (const c of children) {
    const u = c.summary?.tokenUsage
    if (u) {
      sum.inputTokens += u.inputTokens ?? 0
      sum.outputTokens += u.outputTokens ?? 0
      sum.cacheReadInputTokens += u.cacheReadInputTokens ?? 0
      sum.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0
      sum.totalCostUsd += u.totalCostUsd ?? 0
    }
    if (c.startedAt && c.completedAt) {
      sum.totalDurationMs += new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime()
    }
  }
  return sum
}

interface DependencyGraphProps {
  children: CampaignChild[]
}

/**
 * Render the dependency DAG as a layered text graph. We use the same
 * Kahn-style topological pass that the runner uses to identify ready
 * children — this keeps the visual ordering consistent with execution
 * order without dragging in a graph-layout dependency.
 */
function DependencyGraph({ children }: DependencyGraphProps) {
  const layers = useMemo(() => {
    const remaining = new Map<string, CampaignChild>()
    for (const c of children) remaining.set(c.name, c)
    const layered: CampaignChild[][] = []
    const placed = new Set<string>()
    let safety = 0

    while (remaining.size > 0 && safety < 50) {
      const layer: CampaignChild[] = []
      for (const c of remaining.values()) {
        if (c.dependsOn.every(d => placed.has(d) || !remaining.has(d))) {
          layer.push(c)
        }
      }
      if (layer.length === 0) {
        layered.push(Array.from(remaining.values()))
        break
      }
      for (const c of layer) {
        placed.add(c.name)
        remaining.delete(c.name)
      }
      layered.push(layer)
      safety++
    }
    return layered
  }, [children])

  if (layers.length === 0) return null

  return (
    <div className="flex flex-col gap-3 overflow-x-auto">
      {layers.map((layer, idx) => (
        <div key={idx} className="flex items-center gap-3">
          <div className="w-10 shrink-0 text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
            L{idx + 1}
          </div>
          <div className="flex flex-wrap gap-2">
            {layer.map(c => (
              <div
                key={c.name}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
                  toneClasses(CHILD_TONE[c.status]),
                )}
              >
                <ChildStatusPill status={c.status} />
                <span className="font-medium">{c.name}</span>
                {c.dependsOn.length > 0 ? (
                  <span className="text-[10px] text-fg-subtle">
                    ← {c.dependsOn.join(', ')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

interface ChildActionsProps {
  jobId: string
  child: CampaignChild
  onMutated: () => void
}

function ChildActions({ jobId, child, onMutated }: ChildActionsProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const post = async (action: 'skip' | 'rerun' | 'cancel', reason?: string) => {
    setBusy(action)
    setError(null)
    try {
      await requestJson(`/jobs/${jobId}/children/${encodeURIComponent(child.name)}/${action}`, jsonRequest(reason ? { reason } : {}, { method: 'POST' }))
      onMutated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  const isTerminal = TERMINAL_CHILD.includes(child.status)
  const canSkip = !isTerminal
  const canRerun = isTerminal && child.status !== 'complete'
  const canCancel = child.status === 'dispatched' || child.status === 'ready'

  return (
    <div className="flex items-center gap-1.5">
      {canSkip ? (
        <Button
          onClick={() => void post('skip')}
          disabled={busy !== null}
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          title="Mark as skipped — unblocks dependents"
        >
          <SkipForward className="size-3.5" />
          {busy === 'skip' ? '…' : 'Skip'}
        </Button>
      ) : null}
      {canRerun ? (
        <Button
          onClick={() => void post('rerun')}
          disabled={busy !== null}
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          title="Re-dispatch this child"
        >
          <RotateCcw className="size-3.5" />
          {busy === 'rerun' ? '…' : 'Rerun'}
        </Button>
      ) : null}
      {canCancel ? (
        <Button
          onClick={() => void post('cancel')}
          disabled={busy !== null}
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] text-danger-400 hover:bg-danger-500/10 hover:text-danger-400"
          title="Cancel this child"
        >
          <SquareSlash className="size-3.5" />
          {busy === 'cancel' ? '…' : 'Cancel'}
        </Button>
      ) : null}
      {error ? (
        <span className="text-[11px] text-danger-400" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  )
}

interface CampaignViewProps {
  job: Job
  onMutated: () => void
}

function MetricCell({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-line bg-overlay/40 p-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-fg">{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-fg-muted">{detail}</div> : null}
    </div>
  )
}

export default function CampaignView({ job, onMutated }: CampaignViewProps) {
  const children = job.campaignChildren ?? []
  const usage = aggregateUsage(children)

  const counts = children.reduce<Record<CampaignChildStatus, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1
    return acc
  }, { pending: 0, ready: 0, dispatched: 0, complete: 0, failed: 0, escalated: 0, skipped: 0 })

  if (children.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Campaign children</CardTitle>
          <CardDescription>
            No child jobs registered yet. The campaign planner is still defining the execution graph.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const totalPrs = children.reduce((s, c) => s + (c.summary?.prMappings.length ?? 0), 0)
  const completedChildren = counts.complete + counts.skipped
  const progress = children.length === 0 ? 0 : (completedChildren / children.length) * 100

  return (
    <Card>
      <CardHeader className="gap-4 border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Campaign children</CardTitle>
            <CardDescription>Dependency-aware execution view with child-level controls.</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(counts) as CampaignChildStatus[])
              .filter(status => counts[status] > 0)
              .map(status => (
                <span key={status} className="inline-flex items-center gap-1.5 text-[11px]">
                  <ChildStatusPill status={status} />
                  <span className="tabular-nums text-fg-muted">{counts[status]}</span>
                </span>
              ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <MetricCell
            label="Progress"
            value={`${completedChildren}/${children.length}`}
            detail={`${Math.round(progress)}% complete`}
          />
          <MetricCell
            label="Tokens"
            value={formatTokens(usage.inputTokens + usage.outputTokens)}
            detail="Across all children"
          />
          <MetricCell
            label="Cost"
            value={formatPreciseCurrency(usage.totalCostUsd)}
            detail="Aggregate child spend"
          />
          <MetricCell
            label="Pull requests"
            value={totalPrs.toString()}
            detail="Opened across children"
          />
        </div>

        <Progress value={progress} />
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <div>
          <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
            <Layers3 className="size-3.5" />
            Dependency graph
          </div>
          <DependencyGraph children={children} />
        </div>

        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-xs">
            <thead className="bg-overlay/40 text-fg-subtle">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Phase</th>
                <th className="px-3 py-2 text-left font-medium">Tracker</th>
                <th className="px-3 py-2 text-left font-medium">Job</th>
                <th className="px-3 py-2 text-right font-medium">PRs</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {children.map(c => {
                const phase = c.summary?.phase ?? '—'
                const prs = c.summary?.prMappings.length ?? 0
                const tokenTotal = (c.summary?.tokenUsage?.inputTokens ?? 0) + (c.summary?.tokenUsage?.outputTokens ?? 0)
                return (
                  <tr key={c.name} className="transition-colors hover:bg-overlay/40">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-fg">{c.name}</div>
                      {c.description ? (
                        <div className="line-clamp-2 max-w-[280px] text-[11px] text-fg-subtle">{c.description}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5"><ChildStatusPill status={c.status} /></td>
                    <td className="px-3 py-2.5 text-fg-muted">{phase}</td>
                    <td className="px-3 py-2.5">
                      {c.trackerRef ? (
                        <a
                          href={c.trackerRef.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-300 hover:text-accent-400"
                        >
                          {c.trackerRef.key}
                        </a>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.jobId ? (
                        <Link to={`/jobs/${c.jobId}`} className="font-mono text-[11px] text-accent-300 hover:text-accent-400">
                          {c.jobId.slice(0, 18)}…
                        </Link>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{prs}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">
                      {tokenTotal > 0 ? formatTokens(tokenTotal) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ChildActions jobId={job.id} child={c} onMutated={onMutated} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-4">
          <Stat label="Tokens in / out" value={`${formatTokens(usage.inputTokens)} / ${formatTokens(usage.outputTokens)}`} />
          <Stat label="Cache read" value={formatTokens(usage.cacheReadInputTokens)} />
          <Stat label="Latest update" value={formatRelativeTime(job.updatedAt)} />
          <Stat label="Running children" value={(counts.dispatched + counts.ready).toString()} />
        </div>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className="mt-1 font-medium text-fg">{value}</div>
    </div>
  )
}
