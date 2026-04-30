import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CampaignChild, CampaignChildStatus, Job, TokenUsage } from '../types'

const CHILD_STATUS_STYLES: Record<CampaignChildStatus, { bg: string; text: string; dot: string }> = {
  pending:    { bg: 'bg-zinc-800',    text: 'text-zinc-300',    dot: 'bg-zinc-400' },
  ready:      { bg: 'bg-sky-950',     text: 'text-sky-300',     dot: 'bg-sky-400' },
  dispatched: { bg: 'bg-indigo-950',  text: 'text-indigo-300',  dot: 'bg-indigo-400' },
  complete:   { bg: 'bg-emerald-950', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  failed:     { bg: 'bg-rose-950',    text: 'text-rose-300',    dot: 'bg-rose-400' },
  escalated:  { bg: 'bg-rose-950',    text: 'text-rose-300',    dot: 'bg-rose-400' },
  skipped:    { bg: 'bg-zinc-900',    text: 'text-zinc-500',    dot: 'bg-zinc-600' },
}

const TERMINAL_CHILD: CampaignChildStatus[] = ['complete', 'failed', 'escalated', 'skipped']

function ChildStatusPill({ status }: { status: CampaignChildStatus }) {
  const s = CHILD_STATUS_STYLES[status]
  const isLive = status === 'dispatched'
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${isLive ? 'animate-pulse-dot' : ''}`} />
      {status}
    </span>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
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
      const res = await fetch(`/jobs/${jobId}/children/${encodeURIComponent(child.name)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
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
        <button
          onClick={() => void post('skip')}
          disabled={busy !== null}
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          title="Mark as skipped — unblocks dependents"
        >
          {busy === 'skip' ? '…' : 'Skip'}
        </button>
      )}
      {canRerun && (
        <button
          onClick={() => void post('rerun')}
          disabled={busy !== null}
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-indigo-900/60 text-indigo-200 hover:bg-indigo-800 disabled:opacity-50"
          title="Re-dispatch this child"
        >
          {busy === 'rerun' ? '…' : 'Rerun'}
        </button>
      )}
      {canCancel && (
        <button
          onClick={() => void post('cancel')}
          disabled={busy !== null}
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-900/60 text-rose-200 hover:bg-rose-800 disabled:opacity-50"
          title="Cancel this child (running children finish; bookkeeping only)"
        >
          {busy === 'cancel' ? '…' : 'Cancel'}
        </button>
      )}
      {error && (
        <span className="text-[10px] text-rose-400" title={error}>
          ⚠
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
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-5">
        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Campaign</h3>
        <p className="text-xs text-zinc-500 italic">
          No children registered yet — the campaign-planner is still planning.
        </p>
      </div>
    )
  }

  const totalPrs = children.reduce((s, c) => s + (c.summary?.prMappings.length ?? 0), 0)

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Campaign children ({children.length})
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          {(Object.keys(counts) as CampaignChildStatus[])
            .filter(s => counts[s] > 0)
            .map(s => (
              <span key={s} className="inline-flex items-center gap-1 text-[11px]">
                <ChildStatusPill status={s} />
                <span className="text-zinc-400 tabular-nums">{counts[s]}</span>
              </span>
            ))}
        </div>
      </div>

      <DependencyGraph children={children} />

      <div className="rounded-lg border border-zinc-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-zinc-950 text-zinc-500">
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
          <tbody className="divide-y divide-zinc-800/50">
            {children.map(c => {
              const phase = c.summary?.phase ?? '—'
              const prs = c.summary?.prMappings.length ?? 0
              const tokenTotal = (c.summary?.tokenUsage?.inputTokens ?? 0) + (c.summary?.tokenUsage?.outputTokens ?? 0)
              return (
                <tr key={c.name} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-200">{c.name}</div>
                    {c.description && (
                      <div className="text-[11px] text-zinc-500 line-clamp-2 max-w-[280px]">{c.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2"><ChildStatusPill status={c.status} /></td>
                  <td className="px-3 py-2 text-zinc-400">{phase}</td>
                  <td className="px-3 py-2">
                    {c.trackerRef ? (
                      <a
                        href={c.trackerRef.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:text-sky-300"
                      >
                        {c.trackerRef.key}
                      </a>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {c.jobId ? (
                      <Link to={`/jobs/${c.jobId}`} className="text-indigo-400 hover:text-indigo-300 font-mono text-[11px]">
                        {c.jobId.slice(0, 18)}…
                      </Link>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{prs}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-zinc-800">
        <div>
          <div className="text-xs text-zinc-500">Tokens (in/out)</div>
          <div className="text-sm text-zinc-200 tabular-nums">
            {formatTokens(usage.inputTokens)} / {formatTokens(usage.outputTokens)}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Cache read</div>
          <div className="text-sm text-zinc-200 tabular-nums">{formatTokens(usage.cacheReadInputTokens)}</div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Total cost</div>
          <div className="text-sm text-zinc-200 tabular-nums">${usage.totalCostUsd.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">PRs across children</div>
          <div className="text-sm text-zinc-200 tabular-nums">{totalPrs}</div>
        </div>
      </div>
    </div>
  )
}
