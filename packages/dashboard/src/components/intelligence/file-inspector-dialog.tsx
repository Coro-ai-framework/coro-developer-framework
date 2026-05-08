// ── File Inspector Dialog ──────────────────────────────────────────────────
//
// Opens any intelligence artefact (workflow / agent / skill / memory) and
// shows three views:
//
//   • Rendered — the markdown rendered in-page so you can read the file as
//     intended, including front-matter and prose.
//   • Source   — the raw file contents in monospace, byte-for-byte.
//   • Diff     — only when this file shadows a lower layer; shows a simple
//     line-by-line diff against the next-lower layer that owns the same
//     path. Lets you answer "what did my override actually change?".
//
// Read-only in this phase. The "Edit" / "Override" actions land in Phase 4.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, FileText, Loader2, Plus, RotateCcw } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import LayerBadge, { type IntelligenceLayer } from './layer-badge'
import { ApiError, jsonRequest, requestJson } from '../../lib/http'
import { renderInlineMarkdown } from './markdown-mini'
import { renderLineDiff, summarizeDiff } from './line-diff'

interface FileInspectorTarget {
  layer: IntelligenceLayer
  path: string
  displayName: string
  /** Lower layer this entry shadows, if any. Drives the Diff tab availability. */
  overrides?: IntelligenceLayer
}

interface FileInspectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: FileInspectorTarget | null
  /** Called after a successful write/delete so the parent can refresh the catalogue. */
  onChanged?: (next: { layer: IntelligenceLayer; path: string } | null) => void
}

interface FilePayload {
  layer: IntelligenceLayer
  path: string
  content: string
  lowerLayer: IntelligenceLayer | null
  lowerContent: string | null
}

export default function FileInspectorDialog({
  open,
  onOpenChange,
  target,
  onChanged,
}: FileInspectorDialogProps) {
  const [payload, setPayload] = useState<FilePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<'rendered' | 'source' | 'diff'>('rendered')
  // Tracks the layer/path the inspector is currently showing. Diverges from
  // `target` after an Override/Revert action so we don't have to round-trip
  // through the parent.
  const [activeLayer, setActiveLayer] = useState<IntelligenceLayer | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<null | 'override' | 'revert'>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !target) {
      setPayload(null)
      setError(null)
      setActiveLayer(null)
      setActivePath(null)
      setActionError(null)
      return
    }
    setActiveLayer(target.layer)
    setActivePath(target.path)
  }, [open, target])

  // Re-fetch whenever the active layer/path changes (driven either by a new
  // target or by an internal action like Override / Revert).
  useEffect(() => {
    if (!open || !activeLayer || !activePath) return
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    setPayload(null)
    setTab('rendered')
    requestJson<FilePayload>(
      `/intelligence/file?layer=${encodeURIComponent(activeLayer)}&path=${encodeURIComponent(activePath)}`,
      { signal: ctrl.signal },
    )
      .then(data => setPayload(data))
      .catch(err => {
        if ((err as { name?: string }).name === 'AbortError') return
        const message =
          err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : (err as Error).message
        setError(message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort()
  }, [open, activeLayer, activePath])

  // The Diff tab only makes sense when there is something to diff against.
  // For an artefact that only exists in the current layer, hide it.
  const canDiff = Boolean(payload?.lowerContent && payload.lowerLayer)

  // Pre-compute +/- counts so the legend can show "+12 −250" up-front and
  // the user knows there ARE additions even if they're below the fold.
  const diffSummary = useMemo(() => {
    if (!payload?.lowerContent) return null
    return summarizeDiff(payload.lowerContent, payload.content)
  }, [payload])

  // Ref + handler so the user can jump to the first `+` row when the diff
  // is dominated by removals at the top.
  const diffScrollRef = useRef<HTMLDivElement>(null)
  function jumpToFirstAdd() {
    const root = diffScrollRef.current
    if (!root) return
    const target = root.querySelector('[data-diff-kind="add"]') as HTMLElement | null
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function overrideInLayer(targetLayer: 'tenant' | 'repo') {
    if (!payload || !activePath) return
    setActionPending('override')
    setActionError(null)
    try {
      // Seed the new override with the current (base) content so the user
      // has something concrete to edit. The PUT writes through to disk.
      await requestJson<{ layer: string; path: string; bytes: number }>(
        '/intelligence/file',
        jsonRequest(
          { layer: targetLayer, path: activePath, content: payload.content },
          { method: 'PUT' },
        ),
      )
      // Re-target the inspector to the new override so the user sees it
      // shadowing the base layer.
      setActiveLayer(targetLayer)
      onChanged?.({ layer: targetLayer, path: activePath })
    } catch (err) {
      const message =
        err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : (err as Error).message
      setActionError(message)
    } finally {
      setActionPending(null)
    }
  }

  async function revertToLower() {
    if (!payload || !activeLayer || !activePath || !payload.lowerLayer) return
    setActionPending('revert')
    setActionError(null)
    try {
      await requestJson<{ deleted: true }>(
        `/intelligence/file?layer=${encodeURIComponent(activeLayer)}&path=${encodeURIComponent(activePath)}`,
        { method: 'DELETE' },
      )
      const fallback = payload.lowerLayer
      setActiveLayer(fallback)
      onChanged?.({ layer: fallback, path: activePath })
    } catch (err) {
      const message =
        err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : (err as Error).message
      setActionError(message)
    } finally {
      setActionPending(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-4xl flex-col gap-0 max-h-[min(820px,calc(100vh-2rem))]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4 text-fg-muted" />
            <span className="truncate">{target?.displayName ?? 'File'}</span>
            {target ? (
              <LayerBadge layer={target.layer} overrides={target.overrides} size="sm" />
            ) : null}
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            {target?.path}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-fg-muted">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {error}
            </div>
          ) : payload ? (
            <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)} className="gap-3">
              <div className="sticky top-0 z-30 -mx-6 border-b border-line bg-panel px-6 pb-3 pt-1">
                <TabsList>
                  <TabsTrigger value="rendered">Rendered</TabsTrigger>
                  <TabsTrigger value="source">Source</TabsTrigger>
                  <TabsTrigger value="diff" disabled={!canDiff}>
                    Diff
                    {canDiff && payload.lowerLayer ? (
                      <span className="ml-1.5 text-[10px] opacity-70">vs {payload.lowerLayer}</span>
                    ) : null}
                  </TabsTrigger>
                </TabsList>
                {tab === 'diff' && payload.lowerContent && diffSummary ? (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-panel-raised px-3 py-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">
                    <span className="inline-flex items-center gap-3">
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-danger-500/40 bg-danger-500/15 px-1.5 py-0.5 font-mono text-[11px] normal-case text-danger-400">
                        −{diffSummary.removed}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-success-500/40 bg-success-500/15 px-1.5 py-0.5 font-mono text-[11px] normal-case text-success-400">
                        +{diffSummary.added}
                      </span>
                      <span className="text-fg-subtle/70">
                        {payload.lowerLayer} → {payload.layer}
                      </span>
                    </span>
                    {diffSummary.added > 0 ? (
                      <button
                        type="button"
                        onClick={jumpToFirstAdd}
                        className="inline-flex items-center gap-1 rounded-md border border-success-500/30 bg-success-500/10 px-2 py-0.5 font-medium normal-case tracking-normal text-success-400 transition-colors hover:bg-success-500/20"
                      >
                        <ArrowDown className="size-3" />
                        Jump to first added line
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <TabsContent value="rendered" className="rounded-lg border border-line bg-canvas/40 p-4">
                <div
                  className="prose-coro space-y-3 text-sm leading-6 text-fg"
                  // Renderer escapes input — see markdown-mini for the contract.
                  dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(payload.content) }}
                />
              </TabsContent>

              <TabsContent value="source" className="rounded-lg border border-line bg-canvas/60">
                <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-5 text-fg">
                  {payload.content}
                </pre>
              </TabsContent>

              <TabsContent value="diff" className="rounded-lg border border-line bg-canvas/60">
                {payload.lowerContent ? (
                  <div ref={diffScrollRef}>
                    <div
                      dangerouslySetInnerHTML={{
                        __html: renderLineDiff(payload.lowerContent, payload.content),
                      }}
                    />
                  </div>
                ) : (
                  <div className="p-4 text-sm text-fg-muted">No lower layer to diff against.</div>
                )}
              </TabsContent>
            </Tabs>
          ) : null}
        </DialogBody>

        <div className="shrink-0 border-t border-line px-6 py-3">
          {payload ? (
            <div className="flex w-full flex-col gap-2">
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {payload.layer === 'base' ? (
                    <>
                      <Button
                        size="sm"
                        variant="default"
                        disabled={actionPending !== null}
                        onClick={() => overrideInLayer('tenant')}
                      >
                        {actionPending === 'override' ? (
                          <Loader2 className="mr-1 size-3 animate-spin" />
                        ) : (
                          <Plus className="mr-1 size-3" />
                        )}
                        Override in Custom
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        title="No repo overlay mounted"
                      >
                        <Plus className="mr-1 size-3" />
                        Override in Repo
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionPending !== null || !payload.lowerLayer}
                      onClick={revertToLower}
                      title={
                        payload.lowerLayer
                          ? `Delete this override and fall back to ${payload.lowerLayer}`
                          : 'Nothing to revert to — no lower layer'
                      }
                    >
                      {actionPending === 'revert' ? (
                        <Loader2 className="mr-1 size-3 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1 size-3" />
                      )}
                      Revert to Coro
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-fg-subtle">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="size-3" />
                    {payload.layer === 'base' ? 'Base file' : 'Override file'}
                  </span>
                  {payload.lowerLayer ? (
                    <span className="inline-flex items-center gap-1">
                      Shadowing
                      <LayerBadge layer={payload.lowerLayer} size="sm" />
                    </span>
                  ) : null}
                </div>
              </div>
              {actionError ? (
                <div className="text-[11px] text-danger-400">{actionError}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
