import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Layers3, RotateCcw, SkipForward, SquareSlash } from 'lucide-react'
import type { CampaignChild, CampaignChildStatus, Job, TokenUsage } from '../types'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import Progress from './ui/progress'
import { requestJson, jsonRequest } from '../lib/http'
import { formatCompactNumber, formatPreciseCurrency, formatRelativeTime } from '../lib/format'

const CHILD_STATUS_STYLES: Record<CampaignChildStatus, { bg: string; text: string; dot: string }> = {
  pending:    { bg: 'bg-white/6',           text: 'text-slate-200',   dot: 'bg-slate-400' },
  ready:      { bg: 'bg-cyan-500/12',       text: 'text-cyan-100',    dot: 'bg-cyan-400' },
  dispatched: { bg: 'bg-indigo-500/12',     text: 'text-indigo-100',  dot: 'bg-indigo-400' },
  complete:   { bg: 'bg-emerald-500/12',    text: 'text-emerald-100', dot: 'bg-emerald-400' },
  failed:     { bg: 'bg-rose-500/12',       text: 'text-rose-100',    dot: 'bg-rose-400' },
  escalated:  { bg: 'bg-rose-500/12',       text: 'text-rose-100',    dot: 'bg-rose-400' },
  skipped:    { bg: 'bg-slate-900/60',      text: 'text-slate-400',   dot: 'bg-slate-500' },
}

const TERMINAL_CHILD: CampaignChildStatus[] = ['complete', 'failed', 'escalated', 'skipped']

function ChildStatusPill({ status }: { status: CampaignChildStatus }) {
  const s = CHILD_STATUS_STYLES[status]
  const isLive = status === 'dispatched'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-white/8 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${isLive ? 'animate-pulse-dot' : ''}`} />
      {status}
    </span>
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
        <div key={idx} className="flex items-center gap-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 w-12 shrink-0">L{idx + 1}</div>
          <div className="flex flex-wrap gap-2">
            {layer.map(c => (
              <div
                key={c.name}
                className={`px-2 py-1 rounded-md border text-xs flex items-center gap-2 ${
                  c.status === 'complete'
                    ? 'border-emerald-800 bg-emerald-950/30'
                    : c.status === 'failed' || c.status === 'escalated'
                      ? 'border-rose-800 bg-rose-950/30'
                      : c.status === 'dispatched'
                        ? 'border-indigo-700 bg-indigo-950/30'
                        : c.status === 'ready'
                          ? 'border-sky-700 bg-sky-950/30'
                          : c.status === 'skipped'
                            ? 'border-zinc-800 bg-zinc-900/40 opacity-60'
                            : 'border-zinc-800 bg-zinc-900'
                }`}
              >
                <ChildStatusPill status={c.status} />
                <span className="font-medium text-zinc-200">{c.name}</span>
                {c.dependsOn.length > 0 && (
                  <span className="text-zinc-600 text-[10px]">
                    ← {c.dependsOn.join(', ')}
                  </span>
                )}
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
      {canSkip && (
        <Button
          onClick={() => void post('skip')}
          disabled={busy !== null}
          variant="secondary"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          title="Mark as skipped — unblocks dependents"
        >
          <SkipForward className="size-3.5" />
          {busy === 'skip' ? '…' : 'Skip'}
        </Button>
      )}
      {canRerun && (
        <Button
          onClick={() => void post('rerun')}
          disabled={busy !== null}
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          title="Re-dispatch this child"
        >
          <RotateCcw className="size-3.5" />
          {busy === 'rerun' ? '…' : 'Rerun'}
        </Button>
      )}
      {canCancel && (
        <Button
          onClick={() => void post('cancel')}
          disabled={busy !== null}
          variant="danger"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          title="Cancel this child (running children finish; bookkeeping only)"
        >
          <SquareSlash className="size-3.5" />
          {busy === 'cancel' ? '…' : 'Cancel'}
        </Button>
      )}
      {error && (
        <span className="text-[11px] text-rose-300" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}

interface CampaignViewProps {
  job: Job
  onMutated: () => void
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
        <CardHeader className="border-b border-white/8 pb-4">
          <CardTitle>Campaign</CardTitle>
        </CardHeader>
        <CardContent className="pt-5 text-sm text-slate-500">
          No child jobs registered yet. The campaign planner is still defining the execution graph.
        </CardContent>
      </Card>
    )
  }

  const totalPrs = children.reduce((s, c) => s + (c.summary?.prMappings.length ?? 0), 0)
  const completedChildren = counts.complete + counts.skipped
  const progress = children.length === 0 ? 0 : (completedChildren / children.length) * 100

  return (
    <Card className="space-y-0">
      <CardHeader className="space-y-4 border-b border-white/8 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle>Campaign Children</CardTitle>
            <p className="mt-1 text-sm text-slate-400">Dependency-aware execution view with child-level control actions.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {(Object.keys(counts) as CampaignChildStatus[])
              .filter(status => counts[status] > 0)
              .map(status => (
                <span key={status} className="inline-flex items-center gap-1 text-[11px]">
                  <ChildStatusPill status={status} />
                  <span className="text-slate-400 tabular-nums">{counts[status]}</span>
                </span>
              ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Progress</div>
            <div className="mt-1 text-2xl font-semibold text-white">{completedChildren}/{children.length}</div>
            <div className="mt-3"><Progress value={progress} /></div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Tokens</div>
            <div className="mt-1 text-2xl font-semibold text-white">{formatTokens(usage.inputTokens + usage.outputTokens)}</div>
            <div className="mt-1 text-sm text-slate-400">Across all child runs</div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Cost</div>
            <div className="mt-1 text-2xl font-semibold text-white">{formatPreciseCurrency(usage.totalCostUsd)}</div>
            <div className="mt-1 text-sm text-slate-400">Aggregate child spend</div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">PRs</div>
            <div className="mt-1 text-2xl font-semibold text-white">{totalPrs}</div>
            <div className="mt-1 text-sm text-slate-400">Opened across child jobs</div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <div>
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
            <Layers3 className="size-3.5" />
            Dependency graph
          </div>
          <DependencyGraph children={children} />
        </div>

        <div className="overflow-x-auto rounded-2xl border border-white/8">
          <table className="w-full text-xs">
            <thead className="bg-slate-950/80 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-left px-3 py-2 font-medium">Phase</th>
              <th className="text-left px-3 py-2 font-medium">Tracker</th>
              <th className="text-left px-3 py-2 font-medium">Job</th>
              <th className="text-right px-3 py-2 font-medium">PRs</th>
              <th className="text-right px-3 py-2 font-medium">Tokens</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/8">
            {children.map(c => {
              const phase = c.summary?.phase ?? '—'
              const prs = c.summary?.prMappings.length ?? 0
              const tokenTotal = (c.summary?.tokenUsage?.inputTokens ?? 0) + (c.summary?.tokenUsage?.outputTokens ?? 0)
              return (
                <tr key={c.name} className="hover:bg-white/[0.035] transition-colors">
                  <td className="px-3 py-2">
                    <div className="font-medium text-white">{c.name}</div>
                    {c.description && (
                      <div className="text-[11px] text-slate-500 line-clamp-2 max-w-[280px]">{c.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2"><ChildStatusPill status={c.status} /></td>
                  <td className="px-3 py-2 text-slate-300">{phase}</td>
                  <td className="px-3 py-2">
                    {c.trackerRef ? (
                      <a
                        href={c.trackerRef.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-300 hover:text-cyan-200"
                      >
                        {c.trackerRef.key}
                      </a>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {c.jobId ? (
                      <Link to={`/jobs/${c.jobId}`} className="text-indigo-300 hover:text-indigo-200 font-mono text-[11px]">
                        {c.jobId.slice(0, 18)}…
                      </Link>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{prs}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                    {tokenTotal > 0 ? formatTokens(tokenTotal) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ChildActions jobId={job.id} child={c} onMutated={onMutated} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
        <div className="grid gap-3 border-t border-white/8 pt-4 sm:grid-cols-4 text-sm">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Tokens in/out</div>
            <div className="mt-1 font-medium text-white">{formatTokens(usage.inputTokens)} / {formatTokens(usage.outputTokens)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Cache read</div>
            <div className="mt-1 font-medium text-white">{formatTokens(usage.cacheReadInputTokens)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Latest update</div>
            <div className="mt-1 font-medium text-white">{formatRelativeTime(job.updatedAt)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Running children</div>
            <div className="mt-1 font-medium text-white">{counts.dispatched + counts.ready}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
