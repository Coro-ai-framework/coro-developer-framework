import { useState } from 'react'
import { Ban, Plug, ShieldCheck } from 'lucide-react'
import StepShell from './components/StepShell'
import ProviderCard from './components/ProviderCard'
import ProviderConfigForm from './components/ProviderConfigForm'
import LiveTestPanel from './components/LiveTestPanel'
import { Button } from '../../ui/button'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { cn } from '../../../lib/utils'
import { buildTestPayload, getProvidersForStep } from '../provider-catalog'
import type { StepState, WizardAction } from '../wizard-state'

interface TrackerStepProps {
  state: StepState
  dispatch: (action: WizardAction) => void
  onSkip: () => void
  onOpenDrawer: () => void
}

interface TrackerTestResponse {
  ok: boolean
  message?: string
  hint?: string
}

/**
 * "Where do your tickets live?" — optional step. Includes an explicit
 * "I don't use a tracker" card that immediately marks the step
 * skipped and advances. Trackers we know how to test ping their
 * provider via `POST /test/tracker`.
 */
export default function TrackerStep({ state, dispatch, onSkip, onOpenDrawer }: TrackerStepProps) {
  const providers = getProvidersForStep('tracker')
  const selectedId = state.selectedProviderId
  const selected = providers.find(p => p.id === selectedId)
  const skipSelected = selectedId === '__skip__'
  const [testing, setTesting] = useState(false)

  async function runTest() {
    if (!selected) return
    const payload = buildTestPayload('tracker', selected.id, state.draftConfig)
    if (!payload) {
      dispatch({
        type: 'testResult',
        step: 'tracker',
        result: { ok: false, message: 'This plugin has no built-in connectivity test.' },
      })
      return
    }
    setTesting(true)
    dispatch({ type: 'beginTest', step: 'tracker' })
    try {
      const result = await requestJson<TrackerTestResponse>(
        payload.url,
        jsonRequest(payload.body, { method: 'POST' }),
      )
      dispatch({
        type: 'testResult',
        step: 'tracker',
        result: {
          ok: result.ok,
          message: result.message ?? (result.ok ? 'Connected.' : 'Test failed.'),
          ...(result.hint ? { hint: result.hint } : {}),
        },
      })
    } catch (err) {
      dispatch({
        type: 'testResult',
        step: 'tracker',
        result: {
          ok: false,
          message: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
        },
      })
    } finally {
      setTesting(false)
    }
  }

  const requiredFilled = !!selected && selected.fields
    .filter(f => f.required)
    .every(f => {
      const v = state.draftConfig[f.key]
      return typeof v === 'string' && v.length > 0
    })

  return (
    <StepShell
      eyebrow="Step 3 of 3 — optional"
      title="Where do your tickets live?"
      description="Optional. Connect a tracker so Coro can pick up assigned tickets and report progress back. You can skip this and add it later from Settings."
    >
      <div className="space-y-3">
        {providers.map(provider => (
          <ProviderCard
            key={provider.id}
            pluginId={provider.id}
            title={provider.title}
            subtitle={provider.subtitle}
            selected={selectedId === provider.id}
            onSelect={() =>
              dispatch({ type: 'selectProvider', step: 'tracker', providerId: provider.id })
            }
          />
        ))}

        <button
          type="button"
          onClick={() => {
            // Synthetic id; we don't bind it to a provider entry.
            dispatch({ type: 'selectProvider', step: 'tracker', providerId: '__skip__' })
            dispatch({ type: 'skip', step: 'tracker' })
            onSkip()
          }}
          aria-pressed={skipSelected}
          className={cn(
            'group flex w-full items-start gap-4 rounded-2xl border bg-overlay/30 px-4 py-4 text-left transition-all',
            'hover:bg-overlay/60 hover:border-accent-500/30',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
            skipSelected
              ? 'border-accent-500/55 bg-accent-500/8'
              : 'border-line border-dashed',
          )}
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-overlay/60 ring-1 ring-line text-fg-muted">
            <Ban className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-fg">I don't use a tracker</div>
            <div className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              Skip this step. You can wire up Jira, Linear, or GitHub Issues later in Settings.
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={onOpenDrawer}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-transparent px-4 py-3 text-sm text-fg-muted hover:border-accent-500/30 hover:bg-overlay/40 hover:text-fg"
        >
          <Plug className="size-4" />
          Need something else? Browse custom tracker plugins
        </button>
      </div>

      {selected ? (
        <>
          <ProviderConfigForm
            provider={selected}
            draft={state.draftConfig}
            onChange={(key, value) =>
              dispatch({ type: 'setField', step: 'tracker', key, value })
            }
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void runTest()}
              disabled={!requiredFilled || testing}
            >
              <ShieldCheck />
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>
        </>
      ) : null}

      <LiveTestPanel status={state.status} result={state.lastResult} />
    </StepShell>
  )
}
