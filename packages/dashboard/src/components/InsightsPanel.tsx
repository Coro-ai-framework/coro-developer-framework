import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Lightbulb, Pencil, RotateCcw, X } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { SegmentedControl } from './ui/segmented-control'
import { Textarea } from './ui/textarea'
import { cn } from '../lib/utils'
import { formatRelativeTime } from '../lib/format'
import { jsonRequest, requestJson, ApiError } from '../lib/http'
import type { Insight, InsightLayer, InsightStatus } from '../types'

interface InsightsPanelProps {
  jobId: string
  insights: Insight[]
  onChanged: () => void | Promise<void>
}

type LayerChoice = 'tenant' | 'repo' | 'evaluator'

const LAYER_OPTIONS: ReadonlyArray<{ value: LayerChoice; label: string }> = [
  { value: 'tenant', label: 'Team' },
  { value: 'repo', label: 'Repo' },
  { value: 'evaluator', label: 'Let evaluator decide' },
]

const STATUS_FILTERS: ReadonlyArray<{ value: 'all' | InsightStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]

function statusOf(insight: Insight): InsightStatus {
  return insight.status ?? 'pending'
}

function effectiveLayer(insight: Insight): InsightLayer | undefined {
  return insight.userLayer ?? insight.suggestedLayer
}

function layerChoiceFor(insight: Insight): LayerChoice {
  if (insight.userLayer === 'tenant') return 'tenant'
  if (insight.userLayer === 'repo') return 'repo'
  return 'evaluator'
}

function statusBadgeVariant(status: InsightStatus): 'neutral' | 'success' | 'danger' | 'warning' {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  return 'warning'
}

export default function InsightsPanel({ jobId, insights: seedInsights, onChanged }: InsightsPanelProps) {
  const [insights, setInsights] = useState<Insight[]>(seedInsights)
  const [filter, setFilter] = useState<'all' | InsightStatus>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<{ summary: string; detail: string; suggestion: string }>({
    summary: '', detail: '', suggestion: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Always pull from the dedicated endpoint — it backfills ids/status onto
  // legacy insights that were recorded before this feature shipped.
  async function reload() {
    try {
      const data = await requestJson<{ insights: Insight[] }>(
        `/jobs/${encodeURIComponent(jobId)}/insights`,
      )
      setInsights(data.insights ?? [])
      setError(null)
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message
      setError(msg)
    }
  }

  useEffect(() => { void reload() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [jobId])

  // If the parent's job poll surfaces more insights than we have cached
  // (a new add_insight came in), refresh from the endpoint so we get ids.
  useEffect(() => {
    if (seedInsights.length > insights.length) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedInsights.length])

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 }
    for (const i of insights) c[statusOf(i)]++
    return c
  }, [insights])

  const visible = useMemo(() => {
    if (filter === 'all') return insights
    return insights.filter((i) => statusOf(i) === filter)
  }, [insights, filter])

  // Same numbering agents see in prompts (`### 1.`, `### 2.`, …): 1-based
  // index among non-rejected insights, in API list order.
  const insightNumbers = useMemo(() => {
    const map = new Map<string, number>()
    let n = 0
    for (const i of insights) {
      if (statusOf(i) === 'rejected') continue
      n++
      map.set(i.id ?? `${i.phase}:${i.summary}`, n)
    }
    return map
  }, [insights])

  async function patch(insightId: string, body: Record<string, unknown>) {
    setBusyId(insightId)
    setError(null)
    try {
      const updated = await requestJson<{ insight: Insight }>(
        `/jobs/${encodeURIComponent(jobId)}/insights/${encodeURIComponent(insightId)}`,
        jsonRequest(body, { method: 'PATCH' }),
      )
      // Optimistic local update so users see the change immediately even
      // before the parent's job poll catches up.
      if (updated?.insight) {
        setInsights((prev) => prev.map((i) => (i.id === insightId ? updated.insight : i)))
      } else {
        await reload()
      }
      void onChanged()
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message
      setError(msg)
    } finally {
      setBusyId(null)
    }
  }

  function startEdit(insight: Insight) {
    setEditingId(insight.id ?? null)
    setEditDraft({
      summary: insight.editedSummary ?? insight.summary,
      detail: insight.editedDetail ?? insight.detail,
      suggestion: insight.editedSuggestion ?? insight.suggestion ?? '',
    })
  }

  async function saveEdit(insight: Insight) {
    if (!insight.id) return
    const body: Record<string, unknown> = {}
    // Only send fields that diverge from the originals; null clears.
    body.editedSummary = editDraft.summary === insight.summary ? null : editDraft.summary
    body.editedDetail = editDraft.detail === insight.detail ? null : editDraft.detail
    const origSugg = insight.suggestion ?? ''
    body.editedSuggestion = editDraft.suggestion === origSugg ? null : (editDraft.suggestion || null)
    await patch(insight.id, body)
    setEditingId(null)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  async function setLayer(insight: Insight, choice: LayerChoice) {
    if (!insight.id) return
    await patch(insight.id, { userLayer: choice === 'evaluator' ? null : choice })
  }

  async function setStatus(insight: Insight, status: InsightStatus) {
    if (!insight.id) return
    await patch(insight.id, { status })
  }

  return (
    <Card>
      <CardHeader className="gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Lightbulb className="size-4 text-amber-500" aria-hidden="true" />
            Insights
            <span className="text-sm font-normal text-muted-foreground">
              ({counts.pending} pending · {counts.approved} approved · {counts.rejected} rejected)
            </span>
          </CardTitle>
          <CardDescription>
            Findings recorded by agents during the run. Approve the ones you want the evaluator to ship
            as memory PRs and tag whether they belong in your team or repo intelligence layer. Rejected
            entries are kept for audit but skipped by the evaluator.
          </CardDescription>
        </div>
        <SegmentedControl
          options={STATUS_FILTERS}
          value={filter}
          onChange={setFilter}
          size="sm"
          ariaLabel="Filter insights by status"
        />
      </CardHeader>

      <CardContent className="space-y-3 pt-5">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-muted-foreground">
            {insights.length === 0
              ? 'No insights have been recorded yet. Agents call add_insight during the run to surface findings here.'
              : `No insights match the "${filter}" filter.`}
          </div>
        ) : null}

        {visible.map((insight) => {
          const status = statusOf(insight)
          const id = insight.id ?? `${insight.phase}:${insight.summary}`
          const expanded = expandedId === id
          const editing = editingId === id
          const busy = busyId === insight.id
          const layer = effectiveLayer(insight)
          const userOverroad = insight.editedSummary || insight.editedDetail || insight.editedSuggestion
          const displaySummary = insight.editedSummary ?? insight.summary
          const displayDetail = insight.editedDetail ?? insight.detail
          const displaySuggestion = insight.editedSuggestion ?? insight.suggestion
          const insightNum = insightNumbers.get(id)

          return (
            <div
              key={id}
              className={cn(
                'rounded-md border border-line bg-overlay/40 transition-opacity',
                status === 'rejected' && 'opacity-60',
                busy && 'opacity-50',
              )}
            >
              <div className="flex items-start gap-3 p-3">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : id)}
                  className="mt-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={expanded ? 'Collapse' : 'Expand'}
                >
                  {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>

                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {insightNum != null ? (
                      <Badge
                        variant="neutral"
                        className="font-mono normal-case tracking-normal"
                        title={insight.id ? `Insight ${insight.id}` : undefined}
                      >
                        #{insightNum}
                      </Badge>
                    ) : null}
                    <Badge variant={statusBadgeVariant(status)} className="capitalize">{status}</Badge>
                    <Badge variant="neutral" className="font-mono">{insight.phase}</Badge>
                    <Badge variant="accent">{insight.category}</Badge>
                    {layer ? (
                      <Badge variant="neutral">
                        {insight.userLayer ? 'layer: ' : 'suggested: '}{layer === 'tenant' ? 'team' : 'repo'}
                      </Badge>
                    ) : null}
                    {insight.sourceChildName ? (
                      <Badge variant="neutral">from {insight.sourceChildName}</Badge>
                    ) : null}
                    {userOverroad ? (
                      <Badge variant="warning">edited</Badge>
                    ) : null}
                  </div>
                  <p className="text-sm font-medium leading-snug">{displaySummary}</p>
                  {(insight.editedAt || insight.decidedAt) ? (
                    <p className="text-[11px] text-muted-foreground">
                      {insight.decidedAt ? <>decided {formatRelativeTime(insight.decidedAt)}{insight.decidedBy ? ` by ${insight.decidedBy}` : ''}</> : null}
                      {insight.decidedAt && insight.editedAt ? ' · ' : ''}
                      {insight.editedAt ? <>edited {formatRelativeTime(insight.editedAt)}{insight.editedBy ? ` by ${insight.editedBy}` : ''}</> : null}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {status !== 'approved' ? (
                    <Button size="sm" variant="success" disabled={busy} onClick={() => void setStatus(insight, 'approved')}>
                      <Check className="size-3.5" /> Approve
                    </Button>
                  ) : null}
                  {status !== 'rejected' ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus(insight, 'rejected')}>
                      <X className="size-3.5" /> Reject
                    </Button>
                  ) : null}
                  {status !== 'pending' ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus(insight, 'pending')} title="Reset to pending">
                      <RotateCcw className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>

              {expanded ? (
                <div className="space-y-4 border-t border-line/60 px-3 py-4">
                  {editing ? (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Summary</label>
                        <Textarea
                          rows={2}
                          value={editDraft.summary}
                          onChange={(e) => setEditDraft({ ...editDraft, summary: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Detail</label>
                        <Textarea
                          rows={6}
                          value={editDraft.detail}
                          onChange={(e) => setEditDraft({ ...editDraft, detail: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Suggestion (optional)</label>
                        <Textarea
                          rows={3}
                          value={editDraft.suggestion}
                          onChange={(e) => setEditDraft({ ...editDraft, suggestion: e.target.value })}
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={cancelEdit}>Cancel</Button>
                        <Button size="sm" variant="primary" onClick={() => void saveEdit(insight)}>Save edits</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Detail</p>
                        <p className="mt-1 whitespace-pre-wrap leading-relaxed">{displayDetail}</p>
                      </div>
                      {displaySuggestion ? (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggestion</p>
                          <p className="mt-1 whitespace-pre-wrap leading-relaxed">{displaySuggestion}</p>
                        </div>
                      ) : null}
                      {userOverroad ? (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer">Show original (pre-edit)</summary>
                          <div className="mt-2 space-y-2 rounded bg-muted/30 p-2">
                            <p><span className="font-medium">Summary:</span> {insight.summary}</p>
                            <p className="whitespace-pre-wrap"><span className="font-medium">Detail:</span> {insight.detail}</p>
                            {insight.suggestion ? <p className="whitespace-pre-wrap"><span className="font-medium">Suggestion:</span> {insight.suggestion}</p> : null}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/40 pt-3">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium text-muted-foreground">Target layer:</span>
                      <SegmentedControl
                        options={LAYER_OPTIONS}
                        value={layerChoiceFor(insight)}
                        onChange={(v) => void setLayer(insight, v)}
                        size="sm"
                        ariaLabel="Target intelligence layer"
                      />
                    </div>
                    {!editing ? (
                      <Button size="sm" variant="outline" onClick={() => startEdit(insight)}>
                        <Pencil className="size-3.5" /> Edit
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
