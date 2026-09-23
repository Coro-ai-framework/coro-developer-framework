import { useEffect, useId, useMemo, useState } from 'react'
import { Loader2, RotateCw, Settings2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { ApiError, jsonRequest, requestJson } from '../../lib/http'
import ModelPicker from '../llm/ModelPicker'
import { findModel, formatUsd, projectPhaseCostUsd } from '../llm/pricing'
import { useExecutorPlugins } from '../llm/useExecutorPlugins'
import { useProviderModels } from '../llm/useProviderModels'
import { latestPhaseUsage } from '../../lib/job-detail-presentation'
import { cn } from '../../lib/utils'
import type { Job } from '../../types'

/**
 * Per-phase model override + soft re-run controls. Rendered inside the
 * "Selected phase" card on Job Detail. Backed by two runner endpoints
 * added in Phase 1 of the alias UX plan:
 *
 *   - `PATCH /jobs/:id/phase-overrides` — set/clear an override for a
 *     phase. Takes effect on the next entry into that phase.
 *   - `POST  /jobs/:id/phases/:phase/rerun` — soft re-run; refuses if
 *     the job is currently executing the phase.
 *
 * Lifecycle nuance: an override applied to the currently-running phase
 * does NOT preempt the live turn — the runner picks it up on the next
 * `selectModel` call (next phase entry, next subagent, or next rerun).
 * The UI surfaces this with a banner so the user isn't surprised.
 */
export interface PhaseModelPanelProps {
  job: Job
  /** Phase the developer is currently inspecting. */
  phase: string
  /** Called after a successful PATCH/rerun so the parent can refetch. */
  onMutated: () => void
  className?: string
}

export default function PhaseModelPanel({ job, phase, onMutated, className }: PhaseModelPanelProps) {
  const isLivePhase = phase === job.phase
  const isJobRunning = job.status === 'running'
  const override = job.phaseModelOverrides?.[phase]

  const { providers, loading: providersLoading } = useExecutorPlugins()
  const { modelsByProvider, loadModels } = useProviderModels()

  // Local draft; seeded from the persisted override so re-opening the
  // panel doesn't lose the developer's last choice.
  const [draft, setDraft] = useState<{ provider: string; model: string }>(() => ({
    provider: override?.provider ?? '',
    model: override?.model ?? '',
  }))
  // Re-seed when the underlying override or phase changes (e.g. user
  // clicks a different phase node).
  useEffect(() => {
    setDraft({ provider: override?.provider ?? '', model: override?.model ?? '' })
  }, [phase, override?.provider, override?.model])

  const [busy, setBusy] = useState<null | 'apply' | 'clear' | 'rerun'>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const editorId = useId()

  // Most recent execution of this phase. Repeated phases append, so the
  // last match is the model and workload a re-run would be compared with.
  const lastUsage = latestPhaseUsage(job.phaseUsage, phase)
  const lastUsedModel = lastUsage?.model ?? null

  // Cost delta: project the recorded workload against the candidate
  // pricing and compare to the actually-billed cost. Only meaningful
  // when (a) the phase has run at least once and (b) the candidate
  // model has pricing published.
  const draftDescriptor = findModel(modelsByProvider, draft.provider, draft.model)
  const projectedCost = projectPhaseCostUsd(draftDescriptor, lastUsage)
  const originalCost = lastUsage?.costUsd ?? null
  const deltaCost
    = projectedCost != null && originalCost != null ? projectedCost - originalCost : null

  const dirty = useMemo(() => {
    return (draft.provider || '') !== (override?.provider ?? '')
      || (draft.model || '') !== (override?.model ?? '')
  }, [draft, override])

  const callApi = async (kind: 'apply' | 'clear' | 'rerun') => {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'apply') {
        if (!draft.model) throw new Error('Pick a model first.')
        await requestJson(
          `/jobs/${encodeURIComponent(job.id)}/phase-overrides`,
          jsonRequest({ phase, model: draft.model, provider: draft.provider || undefined }, { method: 'PATCH' }),
        )
      } else if (kind === 'clear') {
        await requestJson(
          `/jobs/${encodeURIComponent(job.id)}/phase-overrides`,
          jsonRequest({ phase, clear: true }, { method: 'PATCH' }),
        )
        setDraft({ provider: '', model: '' })
      } else if (kind === 'rerun') {
        const body: Record<string, unknown> = {}
        if (draft.model) body.model = draft.model
        if (draft.provider) body.provider = draft.provider
        await requestJson(
          `/jobs/${encodeURIComponent(job.id)}/phases/${encodeURIComponent(phase)}/rerun`,
          jsonRequest(body, { method: 'POST' }),
        )
      }
      if (kind !== 'rerun') setEditing(false)
      onMutated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // Collapsed-state summary of the active model. Priority:
  //   1. Pending override (not yet applied — only differs when editing)
  //   2. Persisted override on this phase
  //   3. Last actually-used model from phaseUsage
  //   4. "(workflow default)"
  const displayModel = override?.model ?? lastUsedModel ?? null
  const displaySource: 'override' | 'last-used' | 'default' = override
    ? 'override'
    : lastUsedModel
      ? 'last-used'
      : 'default'

  const closeEditor = () => {
    setEditing(false)
    setError(null)
    setDraft({ provider: override?.provider ?? '', model: override?.model ?? '' })
  }

  return (
    <>
      <button
        type="button"
        aria-expanded={editing}
        aria-controls={editing ? editorId : undefined}
        onClick={() => {
          if (editing) closeEditor()
          else setEditing(true)
        }}
        className={cn(
          'inline-flex h-8 w-full max-w-full items-center gap-2 rounded-xl border border-line bg-canvas/50 px-2.5 text-left transition-colors hover:border-line-strong hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 sm:w-auto',
          className,
        )}
      >
        <Settings2 className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
        <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">Model</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-fg">
          {displayModel ?? <span className="font-sans text-fg-subtle">(workflow default)</span>}
        </span>
        {displaySource === 'override' ? (
          <span className="shrink-0 rounded-full border border-accent-400/40 bg-accent-500/10 px-1.5 py-0 text-[10px] uppercase tracking-wide text-accent-300">
            override
          </span>
        ) : displaySource === 'last-used' ? (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-subtle">last run</span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] font-medium text-accent-300 sm:ml-1">Change</span>
      </button>

      {editing ? (
        <div id={editorId} className="w-full basis-full space-y-2 rounded-xl border border-line bg-canvas/40 p-3">
          {providersLoading ? (
            <div className="flex items-center gap-2 text-[12px] text-fg-subtle">
              <Loader2 className="size-3 animate-spin" /> Loading providers…
            </div>
          ) : providers.length === 0 ? (
            <div className="text-[12px] text-fg-subtle">
              No LLM provider plugins are installed. Configure one in Settings → LLM Providers
              before overriding a phase model.
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[12rem] max-w-xs flex-1">
                <ModelPicker
                  value={draft}
                  onChange={setDraft}
                  providers={providers}
                  modelsByProvider={modelsByProvider}
                  loadModels={loadModels}
                  disabled={busy !== null}
                  hideLabel
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={!dirty || !draft.model || busy !== null}
                onClick={() => void callApi('apply')}
              >
                {busy === 'apply' ? <Loader2 className="size-3 animate-spin" /> : null}
                Apply
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!override || busy !== null}
                onClick={() => void callApi('clear')}
                title={override ? 'Remove the per-phase override and revert to workflow default' : 'No override to clear'}
              >
                <X className="size-3" /> Clear
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy !== null || (isLivePhase && isJobRunning)}
                onClick={() => void callApi('rerun')}
                title={
                  isLivePhase && isJobRunning
                    ? 'Pause the job before re-running the live phase'
                    : 'Re-enter this phase, optionally with the chosen model'
                }
              >
                {busy === 'rerun' ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
                Re-run
              </Button>
              <button
                type="button"
                onClick={closeEditor}
                className="text-[11px] text-fg-subtle hover:text-fg"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Cost delta preview — only when the phase has already run
              once and the candidate model carries pricing. Comparing
              against the recorded workload (input/output/cache tokens). */}
          {projectedCost != null && originalCost != null && lastUsage ? (
            <div className="text-[11px] text-fg-subtle">
              For this phase's last run ({lastUsage.inputTokens.toLocaleString()} in /{' '}
              {lastUsage.outputTokens.toLocaleString()} out tokens):{' '}
              <span className="text-fg">${formatUsd(originalCost)}</span> →{' '}
              <span className="text-fg">${formatUsd(projectedCost)}</span>
              {deltaCost != null ? (
                <span
                  className={
                    deltaCost > 0
                      ? 'ml-1 text-warning-400'
                      : deltaCost < 0
                        ? 'ml-1 text-success-400'
                        : 'ml-1 text-fg-subtle'
                  }
                >
                  ({deltaCost >= 0 ? '+' : '−'}${formatUsd(Math.abs(deltaCost))})
                </span>
              ) : null}
            </div>
          ) : null}

          {isLivePhase && isJobRunning ? (
            <div className="rounded-lg border border-warning-400/30 bg-warning-500/5 px-2.5 py-1.5 text-[11px] leading-4 text-warning-100">
              This phase is running now. The override applies on the next selectModel call —
              the in-flight turn keeps its original model. Use “Re-run” to apply immediately.
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-danger-400/40 bg-danger-500/5 px-2.5 py-1.5 text-[11px] text-danger-200">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
