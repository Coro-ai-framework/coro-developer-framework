// ── Intelligence (Phase 2: read-only Layer Map) ────────────────────────────
//
// Top-level page that surfaces the layered intelligence model: every
// workflow, agent, skill, and memory file the runner can see, grouped
// by where it lives on disk.
//
// This page is intentionally read-only. Its only job in this phase is to
// answer two questions for the developer:
//
//   1. "What intelligence am I running with right now?"
//   2. "Where would I go to override or extend it?"
//
// Inspector + edit/override actions land in subsequent phases. We keep the
// data shape (`/intelligence/layers`) lean so those phases can layer on top
// without renegotiating it.

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Brain,
  FileText,
  FolderOpen,
  Info,
  Layers,
  Package,
  RefreshCw,
  Server,
  Sparkles,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from 'lucide-react'
import PageHeader from '../components/common/page-header'
import ErrorState from '../components/common/error-state'
import LayerBadge, { type IntelligenceLayer } from '../components/intelligence/layer-badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import WorkflowDetailsDialog from '../components/workflow/workflow-details-dialog'
import { ApiError, requestJson } from '../lib/http'
import type { WorkflowOption } from '../workflows'
import { fetchLaunchableWorkflows } from '../workflows'

// ── Types mirroring the runner response ────────────────────────────────────

type ArtefactKind = 'workflow' | 'agent' | 'skill' | 'memory'

interface Artefact {
  path: string
  kind: ArtefactKind
  displayName: string
  description: string
  layer: IntelligenceLayer
  overrides?: IntelligenceLayer
  source: string
}

interface LayerInfo {
  layer: IntelligenceLayer
  root: string
  exists: boolean
  writable: boolean
  counts: Record<ArtefactKind, number>
}

interface IntelligenceCatalogue {
  layers: LayerInfo[]
  artefacts: Artefact[]
}

// ── Display metadata ───────────────────────────────────────────────────────

const KIND_META: Record<
  ArtefactKind,
  { label: string; plural: string; Icon: LucideIcon; tone: string; description: string }
> = {
  workflow: {
    label: 'Workflow',
    plural: 'Workflows',
    Icon: WorkflowIcon,
    tone: 'text-accent-300',
    description: 'Multi-phase plans the runner dispatches against. Each workflow sequences agents into phases.',
  },
  agent: {
    label: 'Agent',
    plural: 'Agents',
    Icon: Bot,
    tone: 'text-success',
    description: 'Per-phase Claude personas. Override one to change how a phase reasons or what tools it uses.',
  },
  skill: {
    label: 'Skill',
    plural: 'Skills',
    Icon: Sparkles,
    tone: 'text-warning',
    description: 'Claude Code skills picked up automatically when the matching context appears.',
  },
  memory: {
    label: 'Memory',
    plural: 'Memory',
    Icon: Brain,
    tone: 'text-fg-muted',
    description: 'Append-mode notes. Every layer’s memory file is concatenated at runtime — nothing is shadowed.',
  },
}

const LAYER_META: Record<
  IntelligenceLayer,
  { label: string; Icon: LucideIcon; tone: string; pitch: string }
> = {
  base: {
    label: 'Coro',
    Icon: Package,
    tone: 'text-fg-muted',
    pitch: 'Ships with the Coro runner. Read-only — copy any artefact into Custom or Repo to customise it.',
  },
  tenant: {
    label: 'Custom',
    Icon: Layers,
    tone: 'text-accent-300',
    pitch: 'Your overlay at ~/.coro/intelligence. Wins over Coro for every repo on this machine.',
  },
  repo: {
    label: 'Repo',
    Icon: Server,
    tone: 'text-success',
    pitch: 'The target repo’s .coro/ folder. Highest priority — wins over both Coro and Custom.',
  },
}

// ── Page ───────────────────────────────────────────────────────────────────

const INTRO_DISMISS_KEY = 'coro:intelligence:intro-dismissed'

export default function Intelligence() {
  const [catalogue, setCatalogue] = useState<IntelligenceCatalogue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showIntro, setShowIntro] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(INTRO_DISMISS_KEY) !== '1'
  })

  // Workflows are returned by /intelligence/layers as Artefacts (which lacks
  // phase data). For the Details modal we reuse the launchable-workflow
  // endpoint that already returns parsed phases. Two cheap queries beats
  // bolting phase parsing onto the catalogue endpoint.
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>([])
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowOption | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  async function load(signal?: AbortSignal) {
    try {
      const [data, options] = await Promise.all([
        requestJson<IntelligenceCatalogue>('/intelligence/layers', { signal }),
        fetchLaunchableWorkflows().catch(() => [] as WorkflowOption[]),
      ])
      if (signal?.aborted) return
      setCatalogue(data)
      setWorkflowOptions(options)
      setError(null)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      const message =
        err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : (err as Error).message
      setError(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [])

  function dismissIntro() {
    setShowIntro(false)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(INTRO_DISMISS_KEY, '1')
    }
  }

  async function refresh() {
    setRefreshing(true)
    await load()
  }

  // Group artefacts by kind for the four columns. Memory is intentionally
  // not deduplicated by path — every layer's contribution is its own row,
  // since at runtime they all get appended together.
  const grouped = useMemo(() => {
    const out: Record<ArtefactKind, Artefact[]> = {
      workflow: [],
      agent: [],
      skill: [],
      memory: [],
    }
    if (!catalogue) return out
    for (const a of catalogue.artefacts) out[a.kind].push(a)
    return out
  }, [catalogue])

  function openWorkflowDetails(artefact: Artefact) {
    // Workflow id == folder name (workflows/<id>/workflow.md)
    const id = artefact.path.split('/')[1]
    const option = workflowOptions.find(w => w.id === id || w.workflowPath === artefact.path)
    if (!option) return
    setActiveWorkflow(option)
    setDetailsOpen(true)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Intelligence"
        title="Layered Intelligence"
        description="Every workflow, agent, skill, and memory note the runner can see — grouped by the layer it lives on. Drop files into Custom or Repo to customise behaviour without forking the Coro intelligence."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading || refreshing}
          >
            <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {showIntro ? (
        <div className="relative rounded-xl border border-line bg-overlay/40 p-4 pr-10 text-sm text-fg-muted">
          <button
            onClick={dismissIntro}
            className="absolute right-3 top-3 rounded-md p-1 text-fg-subtle hover:bg-overlay hover:text-fg"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 size-4 shrink-0 text-accent-300" />
            <div className="space-y-2">
              <p>
                Coro resolves intelligence in three layers: <strong className="text-fg">Repo</strong>{' '}
                (the working repo’s <code className="rounded bg-overlay px-1">.coro/</code> folder) wins over{' '}
                <strong className="text-fg">Custom</strong> (your{' '}
                <code className="rounded bg-overlay px-1">~/.coro/intelligence</code> overlay), which wins over the{' '}
                <strong className="text-fg">Coro</strong> intelligence shipped with the runner.
              </p>
              <p>
                Most artefacts use <em>last-wins replace</em>: the highest-priority copy is the only one used.
                Memory files use <em>append</em>: every layer’s contribution is concatenated, so notes stack
                across layers. Drop a file at the matching path in a higher layer to override (or extend, for memory).
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Layer Cards ─────────────────────────────────────────────────── */}
      {loading && !catalogue ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : catalogue ? (
        <div className="grid gap-4 md:grid-cols-3">
          {catalogue.layers.map(layer => (
            <LayerCard key={layer.layer} layer={layer} />
          ))}
          {/* Repo layer is not yet surfaced by the catalogue (no working repo
              context in the runner). Show a placeholder so the model is
              fully visible. */}
          {!catalogue.layers.some(l => l.layer === 'repo') ? (
            <RepoPlaceholder />
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorState title="Couldn’t load intelligence catalogue" message={error} /> : null}

      {/* ── Artefact columns ────────────────────────────────────────────── */}
      {catalogue ? (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {(['workflow', 'agent', 'skill', 'memory'] as ArtefactKind[]).map(kind => (
            <ArtefactColumn
              key={kind}
              kind={kind}
              artefacts={grouped[kind]}
              onOpenWorkflow={kind === 'workflow' ? openWorkflowDetails : undefined}
            />
          ))}
        </div>
      ) : null}

      <WorkflowDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        workflow={activeWorkflow}
      />
    </div>
  )
}

// ── Layer Card ─────────────────────────────────────────────────────────────

function LayerCard({ layer }: { layer: LayerInfo }) {
  const meta = LAYER_META[layer.layer]
  const Icon = meta.Icon
  const total =
    layer.counts.workflow + layer.counts.agent + layer.counts.skill + layer.counts.memory

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Icon className={`size-4 ${meta.tone}`} />
            <CardTitle className="text-sm font-semibold">{meta.label}</CardTitle>
            <LayerBadge layer={layer.layer} size="sm" />
            {!layer.writable ? (
              <span className="rounded bg-fg/8 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
                read-only
              </span>
            ) : null}
          </div>
          <p className="text-xs leading-snug text-fg-muted">{meta.pitch}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{total}</div>
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle">files</div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <FolderOpen className="size-3" />
          <code className="truncate font-mono" title={layer.root}>
            {shortenPath(layer.root)}
          </code>
        </div>
        {!layer.exists ? (
          <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            <AlertTriangle className="size-3 text-warning" />
            Not yet created on disk.
          </div>
        ) : null}
        <div className="grid grid-cols-4 gap-1 pt-1">
          {(['workflow', 'agent', 'skill', 'memory'] as ArtefactKind[]).map(kind => {
            const KindIcon = KIND_META[kind].Icon
            return (
              <div
                key={kind}
                className="flex flex-col items-center gap-0.5 rounded-md border border-line bg-overlay/30 px-1 py-1.5"
                title={KIND_META[kind].plural}
              >
                <KindIcon className={`size-3 ${KIND_META[kind].tone}`} />
                <span className="text-xs font-medium tabular-nums">{layer.counts[kind]}</span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function RepoPlaceholder() {
  return (
    <Card className="flex flex-col border-dashed bg-overlay/20">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-success" />
            <CardTitle className="text-sm font-semibold">Repo</CardTitle>
            <LayerBadge layer="repo" size="sm" />
          </div>
          <p className="text-xs leading-snug text-fg-muted">
            Highest-priority overlay, scoped to a single repo via its <code className="rounded bg-overlay px-1">.coro/</code> folder. Surfaces here once a job clones a repo with one.
          </p>
        </div>
      </CardHeader>
    </Card>
  )
}

// ── Artefact Column ────────────────────────────────────────────────────────

interface ArtefactColumnProps {
  kind: ArtefactKind
  artefacts: Artefact[]
  onOpenWorkflow?: (artefact: Artefact) => void
}

function ArtefactColumn({ kind, artefacts, onOpenWorkflow }: ArtefactColumnProps) {
  const meta = KIND_META[kind]
  const Icon = meta.Icon
  return (
    <Card className="flex min-h-[12rem] flex-col">
      <CardHeader className="space-y-1 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className={`size-4 ${meta.tone}`} />
            <CardTitle className="text-sm font-semibold">{meta.plural}</CardTitle>
          </div>
          <span className="rounded bg-overlay/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-fg-muted">
            {artefacts.length}
          </span>
        </div>
        <p className="text-[11px] leading-snug text-fg-subtle">{meta.description}</p>
      </CardHeader>
      <CardContent className="flex-1 space-y-1.5 pt-0">
        {artefacts.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-center text-[11px] text-fg-subtle">
            No {meta.plural.toLowerCase()} found.
          </div>
        ) : (
          artefacts.map(artefact => (
            <ArtefactRow
              key={`${artefact.layer}:${artefact.path}`}
              artefact={artefact}
              onOpenWorkflow={onOpenWorkflow}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function ArtefactRow({
  artefact,
  onOpenWorkflow,
}: {
  artefact: Artefact
  onOpenWorkflow?: (artefact: Artefact) => void
}) {
  const clickable = artefact.kind === 'workflow' && onOpenWorkflow
  const Wrapper = (clickable
    ? ({ children }: { children: React.ReactNode }) => (
        <button
          type="button"
          onClick={() => onOpenWorkflow!(artefact)}
          className="group block w-full rounded-lg border border-line bg-canvas/30 p-2.5 text-left transition-colors hover:border-accent-500/40 hover:bg-overlay/40"
        >
          {children}
        </button>
      )
    : ({ children }: { children: React.ReactNode }) => (
        <div className="rounded-lg border border-line bg-canvas/30 p-2.5">{children}</div>
      )) as React.ComponentType<{ children: React.ReactNode }>

  return (
    <Wrapper>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-fg">{artefact.displayName}</span>
            {artefact.kind === 'memory' ? (
              <span title="Append-mode: stacks across layers" className="text-[10px] text-fg-subtle">
                ∥
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <FileText className="size-2.5 shrink-0 text-fg-subtle" />
            <code className="truncate font-mono text-[10px] text-fg-subtle" title={artefact.path}>
              {artefact.path}
            </code>
          </div>
          {artefact.description ? (
            <p className="line-clamp-2 text-[11px] leading-snug text-fg-muted">
              {artefact.description}
            </p>
          ) : null}
        </div>
        <LayerBadge layer={artefact.layer} overrides={artefact.overrides} size="sm" />
      </div>
    </Wrapper>
  )
}

// ── Utilities ──────────────────────────────────────────────────────────────

function shortenPath(p: string): string {
  if (typeof window === 'undefined') return p
  // Replace user home with ~ for compactness
  const homeMatches = p.match(/^\/(?:Users|home)\/[^/]+/)
  if (homeMatches) return '~' + p.slice(homeMatches[0].length)
  return p
}
