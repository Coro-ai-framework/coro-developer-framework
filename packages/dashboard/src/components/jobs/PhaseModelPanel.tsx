import { useEffect, useMemo, useState } from 'react'
import { Loader2, Pencil, RotateCw, X } from 'lucide-react'
import { Button } from '../ui/button'
import { ApiError, jsonRequest, requestJson } from '../../lib/http'
import ModelPicker from '../llm/ModelPicker'
import { useExecutorPlugins } from '../llm/useExecutorPlugins'
import { useProviderModels } from '../llm/useProviderModels'
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
}

export default function PhaseModelPanel({ job, phase, onMutated }: PhaseModelPanelProps) {
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

  // The model that was actually used the last time this phase ran (if
  // any). Lets us display a concrete value in the collapsed state
  // instead of vague "workflow default" copy.
  const lastUsedModel = useMemo(() => {
    const matches = (job.phaseUsage ?? []).filter(p => p.phase === phase)
    return matches.length > 0 ? matches[matches.length - 1].model : null
  }, [job.phaseUsage, phase])

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

  return (
    <div className="space-y-2">
      {/* Collapsed summary row — single line, no extra chrome. */}
      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">Model</span>
        <span className="font-mono text-fg">
          {displayModel ?? <span className="text-fg-subtle">(workflow default)</span>}
        </span>
        {displaySource === 'override' ? (
          <span className="rounded-full border border-info-400/40 bg-info-500/10 px-1.5 py-0 text-[10px] uppercase tracking-wide text-info-200">
            override
          </span>
        ) : displaySource === 'last-used' ? (
          <span className="text-[10px] uppercase tracking-wide text-fg-subtle">last run</span>
        ) : null}
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-overlay hover:text-fg"
            aria-label="Change model for this phase"
            title="Change model for this phase"
          >
            <Pencil className="size-3" />
            Change
          </button>
        ) : null}
      </div>

      {/* Expanded editor — only mounted when the developer wants it. */}
      {editing ? (
        <div className="space-y-2 rounded-xl border border-line bg-canvas/40 p-3">
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
                onClick={() => {
                  setEditing(false)
                  setError(null)
                  setDraft({ provider: override?.provider ?? '', model: override?.model ?? '' })
                }}
                className="text-[11px] text-fg-subtle hover:text-fg"
              >
                Cancel
              </button>
            </div>
          )}

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
    </div>
  )
}
