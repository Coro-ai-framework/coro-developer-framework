import { Ban, Plug } from 'lucide-react'
import StepShell from './components/StepShell'
import ProviderCard from './components/ProviderCard'
import LiveTestPanel from './components/LiveTestPanel'
import GenericAuthPanel from '../GenericAuthPanel'
import { cn } from '../../../lib/utils'
import { getProvidersForStep, useProviderCatalog } from '../../../hooks/useProviderCatalog'
import type { StepState, WizardAction } from '../wizard-state'

interface TrackerStepProps {
  state: StepState
  dispatch: (action: WizardAction) => void
  onSkip: () => void
  onOpenDrawer: () => void
}

export default function TrackerStep({ state, dispatch, onSkip, onOpenDrawer }: TrackerStepProps) {
  const { plugins, loading } = useProviderCatalog()
  const providers = getProvidersForStep(plugins, 'tracker')
  const selectedId = state.selectedProviderId
  const selected = providers.find(p => p.id === selectedId)
  const skipSelected = selectedId === '__skip__'

  return (
    <StepShell
      eyebrow="Step 3 of 3 — optional"
      title="Where do your tickets live?"
      description="Optional. Connect a tracker so Coro can pick up assigned tickets and report progress back. You can skip this and add it later from Settings."
    >
      <div className="space-y-3">
        {loading ? <p className="text-sm text-fg-muted">Loading providers…</p> : null}
        {providers.map(provider => (
          <ProviderCard
            key={provider.id}
            pluginId={provider.id}
            title={provider.displayName}
            subtitle={provider.ui?.subtitle ?? ''}
            recommended={provider.ui?.recommendedForOnboarding}
            selected={selectedId === provider.id}
            onSelect={() =>
              dispatch({ type: 'selectProvider', step: 'tracker', providerId: provider.id })
            }
          />
        ))}

        <button
          type="button"
          onClick={() => {
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
              Skip this step. You can wire up a tracker later in Settings.
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
        <GenericAuthPanel
          entry={selected}
          draftConfig={state.draftConfig}
          autoVerifyWhenReady
          onChange={(key, value) =>
            dispatch({ type: 'setField', step: 'tracker', key, value })
          }
          onBeginTest={() => dispatch({ type: 'beginTest', step: 'tracker' })}
          onTestResult={result =>
            dispatch({ type: 'testResult', step: 'tracker', result })
          }
        />
      ) : null}

      <LiveTestPanel status={state.status} result={state.lastResult} />
    </StepShell>
  )
}
