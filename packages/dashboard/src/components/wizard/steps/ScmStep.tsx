import { Plug } from 'lucide-react'
import StepShell from './components/StepShell'
import ProviderCard from './components/ProviderCard'
import LiveTestPanel from './components/LiveTestPanel'
import GenericAuthPanel from '../GenericAuthPanel'
import { getProvidersForStep, useProviderCatalog } from '../../../hooks/useProviderCatalog'
import type { StepState, WizardAction } from '../wizard-state'

interface ScmStepProps {
  state: StepState
  dispatch: (action: WizardAction) => void
  onOpenDrawer: () => void
}

export default function ScmStep({ state, dispatch, onOpenDrawer }: ScmStepProps) {
  const { plugins, loading } = useProviderCatalog()
  const providers = getProvidersForStep(plugins, 'scm')
  const selectedId = state.selectedProviderId
  const selected = providers.find(p => p.id === selectedId)

  return (
    <StepShell
      eyebrow="Step 2 of 3"
      title="Where does your code live?"
      description="Coro clones repositories, opens branches, and submits pull requests on your behalf. Connect a git host so the agents can push their work."
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
              dispatch({ type: 'selectProvider', step: 'scm', providerId: provider.id })
            }
          />
        ))}

        <button
          type="button"
          onClick={onOpenDrawer}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-transparent px-4 py-3 text-sm text-fg-muted hover:border-accent-500/30 hover:bg-overlay/40 hover:text-fg"
        >
          <Plug className="size-4" />
          Need GitLab or something else? Browse custom plugins
        </button>
      </div>

      {selected ? (
        <GenericAuthPanel
          entry={selected}
          draftConfig={state.draftConfig}
          autoVerifyWhenReady
          onChange={(key, value) =>
            dispatch({ type: 'setField', step: 'scm', key, value })
          }
          onBeginTest={() => dispatch({ type: 'beginTest', step: 'scm' })}
          onTestResult={result =>
            dispatch({ type: 'testResult', step: 'scm', result })
          }
        />
      ) : null}

      <LiveTestPanel status={state.status} result={state.lastResult} />
    </StepShell>
  )
}
