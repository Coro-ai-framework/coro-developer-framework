import { Plug } from 'lucide-react'
import StepShell from './components/StepShell'
import ProviderCard from './components/ProviderCard'
import LiveTestPanel from './components/LiveTestPanel'
import ProviderListError from './components/ProviderListError'
import GenericAuthPanel from '../GenericAuthPanel'
import { getProvidersForStep, useProviderCatalog } from '../../../hooks/useProviderCatalog'
import type { StepState, WizardAction } from '../wizard-state'

interface LlmStepProps {
  state: StepState
  dispatch: (action: WizardAction) => void
  onOpenDrawer: () => void
}

export default function LlmStep({ state, dispatch, onOpenDrawer }: LlmStepProps) {
  const { plugins, loading, error, refresh } = useProviderCatalog()
  const providers = getProvidersForStep(plugins, 'llm')
  const selectedId = state.selectedProviderId
  const selected = providers.find(p => p.id === selectedId)

  return (
    <StepShell
      eyebrow="Step 1 of 3"
      title="Which model should power Coro?"
      description="Coro uses an LLM to plan, write code, and review changes. Pick one to start — you can switch or add more later in Settings."
    >
      <div className="space-y-3">
        {loading ? <p className="text-sm text-fg-muted">Loading providers…</p> : null}
        {error ? <ProviderListError message={error} onRetry={() => void refresh()} /> : null}
        {providers.map(provider => (
          <ProviderCard
            key={provider.id}
            pluginId={provider.id}
            title={provider.displayName}
            subtitle={provider.ui?.subtitle ?? ''}
            recommended={provider.ui?.recommendedForOnboarding}
            selected={selectedId === provider.id}
            onSelect={() =>
              dispatch({ type: 'selectProvider', step: 'llm', providerId: provider.id })
            }
          />
        ))}

        <button
          type="button"
          onClick={onOpenDrawer}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-transparent px-4 py-3 text-sm text-fg-muted hover:border-accent-500/30 hover:bg-overlay/40 hover:text-fg"
        >
          <Plug className="size-4" />
          Need something else? Browse custom executor plugins
        </button>
      </div>

      {selected ? (
        <GenericAuthPanel
          entry={selected}
          draftConfig={state.draftConfig}
          autoVerifyWhenReady
          onChange={(key, value) =>
            dispatch({ type: 'setField', step: 'llm', key, value })
          }
          onBeginTest={() => dispatch({ type: 'beginTest', step: 'llm' })}
          onTestResult={result =>
            dispatch({ type: 'testResult', step: 'llm', result })
          }
        />
      ) : null}

      <LiveTestPanel status={state.status} result={state.lastResult} />
    </StepShell>
  )
}

export function llmStepCanContinue(state: StepState): boolean {
  return state.status === 'passed' || state.status === 'skipped'
}
