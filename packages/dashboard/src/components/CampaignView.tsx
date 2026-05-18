import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Layers3, MoreHorizontal, Play, RotateCcw, SquareSlash } from 'lucide-react'
import type { CampaignChild, CampaignChildStatus, Job, TokenUsage } from '../types'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import Progress from './ui/progress'
import { Badge } from './ui/badge'
import { Switch } from './ui/switch'
import { requestJson, jsonRequest } from '../lib/http'
import { formatCompactNumber, formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { cn } from '../lib/utils'
import { SUB_RUN_NOUN } from '../lib/run-labels'
import { getStatusMeta, toneClasses, toneDotClasses } from '../lib/status'

/**
 * The status surfaced to the user for a campaign child should reflect
 * what the child Job is actually doing right now — not the
 * coordinator's dispatch-tracking enum, which only flips on terminal
 * transitions and would otherwise leave a child stuck at e.g. `failed`
 * after the user has already resumed it into a rate-limit park.
 *
 * Returns the live `summary.status` when present; otherwise falls back
 * to the coordinator status so undispatched / pruned children still
 * render something meaningful.
 */
function effectiveStatus(child: CampaignChild): string {
  return child.summary?.status ?? child.status
}

function isHaltedStatus(status: string): boolean {
  return status === 'failed' || status === 'escalated'
}

function ChildStatusPill({
  status,
  rateLimitInfo,
}: {
  status: string
  rateLimitInfo?: NonNullable<CampaignChild['summary']>['rateLimitInfo']
}) {
  const meta = getStatusMeta(status)
  const countdown = useRateLimitCountdown(
    status === 'awaiting-rate-limit' ? rateLimitInfo?.resumeAt : undefined,
  )
  return (
    <Badge variant="neutral" className={toneClasses(meta.tone)}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          toneDotClasses(meta.tone),
          meta.pulse && 'animate-pulse-dot',
        )}
      />
      {meta.label}
      {countdown ? (
        <span className="ml-1 font-mono tabular-nums text-[10px] opacity-80">{countdown}</span>
      ) : null}
    </Badge>
  )
}

/**
 * Ticks once per second until `resumeAt` passes, returning a
 * `hh:mm:ss` string for the remaining wait. Returns `null` when the
 * target is not set, which is the common case for non-rate-limited
 * children and lets the pill render without a tail.
 */
function useRateLimitCountdown(resumeAt: number | undefined): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (resumeAt == null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [resumeAt])
  if (resumeAt == null) return null
  const remainingSec = Math.max(0, Math.ceil((resumeAt - now) / 1000))
  const hh = Math.floor(remainingSec / 3600)
  const mm = Math.floor((remainingSec % 3600) / 60)
  const ss = remainingSec % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
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
            {layer.map(c => {
              const liveStatus = effectiveStatus(c)
              const meta = getStatusMeta(liveStatus)
              return (
                <div
                  key={c.name}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
                    toneClasses(meta.tone),
                  )}
                >
                  <ChildStatusPill status={liveStatus} rateLimitInfo={c.summary?.rateLimitInfo} />
                  <span className="font-medium">{c.name}</span>
                  {c.dependsOn.length > 0 ? (
                    <span className="text-[10px] text-fg-subtle">
                      ← {c.dependsOn.join(', ')}
                    </span>
                  ) : null}
                </div>
              )
            })}
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

// Per-row action set, redesigned around a "pit of success":
//
//   ready                                       →  Start + Abandon
//     - Start manually dispatches a child whose deps are satisfied but
//       which the auto-coordinator hasn't picked up yet (parallelism cap
//       full, or campaign halted by a sibling failure). Always safe.
//
//   non-terminal (pending / dispatched)         →  Abandon
//     - one button; Skip and Cancel had identical downstream semantics
//       (both unblock dependents), so a single label avoids the choice tax.
//
//   failed / escalated                          →  Resume (primary) + Abandon + ⋯
//     - Resume re-enters the EXISTING child Job at its last phase and is
//       what you almost always want. Optional inline note becomes a framed
//       developer-input message for the agent's next turn.
//     - ⋯ menu hides the destructive "Start fresh job" (the old `rerun`)
//       behind a confirm so it can't be hit by accident.
//
//   complete / skipped / cancelled              →  no actions
//     - Terminal-accepted states are immutable from the dashboard. Status
//       pill alone communicates everything; extra buttons just create
//       footguns.
function ChildActions({ jobId, child, onMutated }: ChildActionsProps) {
  const [busy, setBusy] = useState<'resume' | 'abandon' | 'rerun' | 'start' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLTextAreaElement | null>(null)

  const post = async (
    action: 'abandon' | 'resume' | 'rerun' | 'start',
    body: Record<string, string> | undefined,
    busyKey: 'resume' | 'abandon' | 'rerun' | 'start',
  ) => {
    setBusy(busyKey)
    setError(null)
    try {
      await requestJson(
        `/jobs/${jobId}/children/${encodeURIComponent(child.name)}/${action}`,
        jsonRequest(body ?? {}, { method: 'POST' }),
      )
      setNoteOpen(false)
      setNote('')
      onMutated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  // Halt detection runs against the live child Job status, not the
  // coordinator's dispatch-tracking enum. A child that was previously
  // marked `failed` and has since been resumed into a rate-limit park
  // is not halted from the user's perspective — the runner will
  // auto-resume when the cooldown elapses.
  const liveStatus = effectiveStatus(child)
  const isHalted = isHaltedStatus(liveStatus)
  const isAcceptedTerminal =
    child.status === 'complete' || child.status === 'skipped' || child.status === 'cancelled'

  if (isAcceptedTerminal) {
    return null
  }

  const onResumeClick = () => {
    if (!noteOpen) {
      setNoteOpen(true)
      // Microtask: let the textarea mount, then focus.
      queueMicrotask(() => noteRef.current?.focus())
      return
    }
    void post('resume', note.trim() ? { note: note.trim() } : undefined, 'resume')
  }

  const onStartFreshClick = () => {
    const ok = window.confirm(
      `Start a fresh job for "${child.name}"?\n\n` +
        `This DROPS the existing child Job (transcript, partial work, any open PR ` +
        `will be orphaned) and dispatches a brand-new Job from the original spec. ` +
        `Use "Resume" instead unless the current Job is genuinely unrecoverable.`,
    )
    if (!ok) return
    void post('rerun', undefined, 'rerun')
  }

  const isReady = child.status === 'ready'

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        {isReady ? (
          <Button
            onClick={() => void post('start', undefined, 'start')}
            disabled={busy !== null}
            size="sm"
            className="h-7 px-2 text-[11px]"
            title={
              'Start this child now. Dependencies are satisfied; this bypasses the ' +
              'parallelism cap and any halt-on-failure pause.'
            }
          >
            <Play className="size-3.5" />
            {busy === 'start' ? '…' : 'Start'}
          </Button>
        ) : null}
        {isHalted ? (
          <Button
            onClick={onResumeClick}
            disabled={busy !== null}
            size="sm"
            className="h-7 px-2 text-[11px]"
            title={
              noteOpen
                ? 'Resume the existing child Job — optionally with the note as developer guidance'
                : 'Resume the existing child Job at its last phase'
            }
          >
            <Play className="size-3.5" />
            {busy === 'resume' ? '…' : noteOpen ? 'Resume' : 'Resume'}
          </Button>
        ) : null}
        <Button
          onClick={() => void post('abandon', undefined, 'abandon')}
          disabled={busy !== null}
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] text-danger-400 hover:bg-danger-500/10 hover:text-danger-400"
          title={
            isHalted
              ? 'Abandon — mark as not-needed, unblocks dependents'
              : 'Abandon this child — unblocks dependents, descopes the work'
          }
        >
          <SquareSlash className="size-3.5" />
          {busy === 'abandon' ? '…' : 'Abandon'}
        </Button>
        {isHalted ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-[11px]"
                disabled={busy !== null}
                aria-label="More actions"
                title="More actions"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault()
                  onStartFreshClick()
                }}
                className="text-danger-400 focus:text-danger-400"
              >
                <RotateCcw className="size-3.5" />
                Start fresh job…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          // Reserve the same horizontal slot the ⋯ menu occupies on
          // halted rows so Resume/Start and Abandon stay vertically
          // aligned across all rows (size-3.5 icon + h-7 px-1.5 button).
          <span aria-hidden className="inline-block h-7 w-7" />
        )}
      </div>
      {noteOpen && isHalted ? (
        <div className="flex w-full max-w-md flex-col items-end gap-1.5">
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional: tell the agent what changed (becomes developer-input for the next turn)"
            rows={3}
            className="w-full resize-y rounded-md border border-line bg-overlay/60 px-2 py-1.5 text-[11px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
            disabled={busy !== null}
          />
          <div className="flex items-center gap-1.5">
            <Button
              onClick={() => {
                setNoteOpen(false)
                setNote('')
              }}
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </div>
        </div>
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

// ── Halted banner ──────────────────────────────────────────────────────────
//
// Surfaced when a campaign is parked at `awaiting-developer-input` because
// one or more children failed/escalated. Two bulk actions:
//
//   Resume all  — re-enter every halted child Job at its last phase. The
//                 most common case (transient infra hiccup, flaky test,
//                 quota refill). No note prompt at the bulk level: per-row
//                 Resume can take a note when the user wants to nudge a
//                 specific child.
//
//   Abandon all — mark every halted child as cancelled, unblocking
//                 dependents. Use when the failures reflect work that is
//                 no longer needed.
//
// Both actions are restricted to the failed/escalated subset so a stray
// click can't disturb children that were progressing fine. "Start fresh"
// is intentionally not offered at the bulk level — it's destructive enough
// that we want per-row confirms.

function HaltedBanner({
  job,
  children,
  onMutated,
}: {
  job: Job
  children: CampaignChild[]
  onMutated: () => void
}) {
  const [busy, setBusy] = useState<'resume' | 'abandon' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const halted = useMemo(
    () => children.filter(c => isHaltedStatus(effectiveStatus(c))),
    [children],
  )

  if (job.status !== 'awaiting-developer-input' || halted.length === 0) return null

  const bulk = async (action: 'resume' | 'abandon') => {
    setBusy(action)
    setError(null)
    const failures: string[] = []
    for (const c of halted) {
      try {
        await requestJson(
          `/jobs/${job.id}/children/${encodeURIComponent(c.name)}/${action}`,
          jsonRequest({}, { method: 'POST' }),
        )
      } catch (err) {
        failures.push(`${c.name}: ${err instanceof Error ? err.message : 'failed'}`)
      }
    }
    setBusy(null)
    if (failures.length > 0) {
      setError(
        `${failures.length} action(s) failed — ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '…' : ''}`,
      )
    }
    onMutated()
  }

  const noun = halted.length === 1 ? SUB_RUN_NOUN.singularLower : SUB_RUN_NOUN.pluralLower
  const haltedLabel = `${halted.length} failed ${noun}`

  return (
    <div className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-400" />
          <div className="space-y-1">
            <div className="text-sm font-medium text-fg">Campaign halted on failure</div>
            <p className="text-[12px] leading-snug text-fg-muted">
              {haltedLabel} — Resume retries each at its last phase, Abandon descopes
              them. Use per-row buttons below if you want to add a note or mix
              actions.
            </p>
            <p className="text-[11px] font-mono text-fg-subtle">
              {halted.map(c => c.name).join(', ')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            onClick={() => void bulk('resume')}
            disabled={busy !== null}
            size="sm"
            className="h-7 px-2 text-[11px]"
            title={`Resume all ${haltedLabel} at their last phase`}
          >
            <Play className="size-3.5" />
            {busy === 'resume' ? '…' : `Resume all (${halted.length})`}
          </Button>
          <Button
            onClick={() => void bulk('abandon')}
            disabled={busy !== null}
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px] text-danger-400 hover:bg-danger-500/10 hover:text-danger-400"
            title={`Abandon all ${haltedLabel} — descope and let the campaign continue`}
          >
            <SquareSlash className="size-3.5" />
            {busy === 'abandon' ? '…' : `Abandon all (${halted.length})`}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="mt-2 text-[11px] text-danger-400">{error}</div>
      ) : null}
    </div>
  )
}

export default function CampaignView({ job, onMutated }: CampaignViewProps) {
  const children = job.campaignChildren ?? []
  const usage = aggregateUsage(children)

  const counts = children.reduce<Record<CampaignChildStatus, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1
    return acc
  }, { pending: 0, ready: 0, dispatched: 0, complete: 0, failed: 0, escalated: 0, skipped: 0, cancelled: 0 })

  // Header chip strip is grouped by *live* status so transient states
  // like `awaiting-rate-limit` or `awaiting-event` surface in the
  // overview instead of being collapsed under the coordinator's
  // `dispatched` bucket.
  const liveCounts = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const c of children) {
      const s = effectiveStatus(c)
      acc[s] = (acc[s] ?? 0) + 1
    }
    return acc
  }, [children])

  // Cancelled children are descoped work — they're noise once you're done
  // triaging. Hide them by default; counts/metrics still reflect reality.
  const [hideCancelled, setHideCancelled] = useState(true)
  const visibleChildren = useMemo(
    () => (hideCancelled ? children.filter(c => c.status !== 'cancelled') : children),
    [children, hideCancelled],
  )

  if (children.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{SUB_RUN_NOUN.plural}</CardTitle>
          <CardDescription>
            {`No ${SUB_RUN_NOUN.pluralLower} registered yet. The campaign planner is still defining the execution graph.`}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const totalPrs = children.reduce((s, c) => s + (c.summary?.prMappings.length ?? 0), 0)
  // Cancelled/abandoned children are descoped — exclude them from BOTH
  // numerator and denominator so progress reflects only the work that's
  // still in scope. Skipped is treated as completed (work consciously
  // marked not-needed counts as a resolved outcome).
  const inScopeChildren = children.length - counts.cancelled
  const completedChildren = counts.complete + counts.skipped
  const progress = inScopeChildren === 0 ? 0 : (completedChildren / inScopeChildren) * 100

  return (
    <Card>
      <CardHeader className="gap-4 border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{SUB_RUN_NOUN.plural}</CardTitle>
            <CardDescription>{`Dependency-aware execution view with per-${SUB_RUN_NOUN.singularLower} controls.`}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {Object.keys(liveCounts)
              .filter(status => liveCounts[status] > 0)
              .map(status => (
                <span key={status} className="inline-flex items-center gap-1.5 text-[11px]">
                  <ChildStatusPill status={status} />
                  <span className="tabular-nums text-fg-muted">{liveCounts[status]}</span>
                </span>
              ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <MetricCell
            label="Progress"
            value={`${completedChildren}/${inScopeChildren}`}
            detail={`${Math.round(progress)}% complete`}
          />
          <MetricCell
            label="Tokens"
            value={formatTokens(usage.inputTokens + usage.outputTokens)}
            detail={`Across all ${SUB_RUN_NOUN.pluralLower}`}
          />
          <MetricCell
            label="Cost"
            value={formatPreciseCurrency(usage.totalCostUsd)}
            detail={`Aggregate ${SUB_RUN_NOUN.singularLower} spend`}
          />
          <MetricCell
            label="Pull requests"
            value={totalPrs.toString()}
            detail={`Opened across ${SUB_RUN_NOUN.pluralLower}`}
          />
        </div>

        <Progress value={progress} />
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <HaltedBanner job={job} children={children} onMutated={onMutated} />

        <div>
          <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
            <Layers3 className="size-3.5" />
            Dependency graph
          </div>
          <DependencyGraph children={visibleChildren} />
        </div>

        {counts.cancelled > 0 ? (
          <div className="flex items-center justify-end gap-2 text-[11px] text-fg-muted">
            <span>Hide cancelled ({counts.cancelled})</span>
            <Switch
              size="sm"
              checked={hideCancelled}
              onCheckedChange={setHideCancelled}
              ariaLabel="Hide cancelled children"
            />
          </div>
        ) : null}

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
              {visibleChildren.map(c => {
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
                    <td className="px-3 py-2.5">
                      <ChildStatusPill
                        status={effectiveStatus(c)}
                        rateLimitInfo={c.summary?.rateLimitInfo}
                      />
                    </td>
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
                        <Link
                          to={`/jobs/${c.jobId}`}
                          className="font-mono text-[11px] text-accent-300 hover:text-accent-400"
                          title={`Open ${SUB_RUN_NOUN.singularLower} detail`}
                        >
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
          <Stat label={`Running ${SUB_RUN_NOUN.pluralLower}`} value={(counts.dispatched + counts.ready).toString()} />
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
