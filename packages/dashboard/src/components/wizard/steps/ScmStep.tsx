import { Plug } from 'lucide-react'
import StepShell from './components/StepShell'
import ProviderCard from './components/ProviderCard'
import LiveTestPanel from './components/LiveTestPanel'
import ProviderListError from './components/ProviderListError'
import GenericAuthPanel from '../GenericAuthPanel'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import { getProvidersForStep, sortForOnboarding, useProviderCatalog } from '../../../hooks/useProviderCatalog'
import type { StepState, WizardAction } from '../wizard-state'

interface ScmStepProps {
  state: StepState
  dispatch: (action: WizardAction) => void
  onOpenDrawer: () => void
}

export default function ScmStep({ state, dispatch, onOpenDrawer }: ScmStepProps) {
  const { plugins, loading, error, refresh } = useProviderCatalog()
  const providers = sortForOnboarding(getProvidersForStep(plugins, 'scm'))
  const selectedId = state.selectedProviderId
  const selected = providers.find(p => p.id === selectedId)
  const limitations = selected?.ui?.limitations ?? []

  return (
    <StepShell
      eyebrow="Step 2 of 2"
      title="Where does your code live?"
      description="Coro clones your repository, works on a branch, and opens a pull request for review. Connect GitHub or Bitbucket — or try Coro on a local checkout first."
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
            badge={
              provider.ui?.limitations?.length
                ? 'limited'
                : provider.ui?.recommendedForOnboarding
                  ? 'recommended'
                  : undefined
            }
            selected={selectedId === provider.id}
            onSelect={() =>
              dispatch({ type: 'selectProvider', step: 'scm', providerId: provider.id })
            }
          />
        ))}
      </div>

      {limitations.length > 0 ? (
        <SettingsNotice tone="warning" title="Local mode is for trying Coro, not for delivering to a team.">
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {limitations.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="mt-1.5 text-fg-subtle">
            You can connect GitHub or Bitbucket any time from Settings → Source control.
          </div>
        </SettingsNotice>
      ) : null}

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

      <button
        type="button"
        onClick={onOpenDrawer}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-transparent px-4 py-2.5 text-[12px] text-fg-subtle hover:border-accent-500/30 hover:bg-overlay/40 hover:text-fg-muted"
      >
        <Plug className="size-3.5" />
        Using GitLab or another host? Browse plugins
      </button>
    </StepShell>
  )
}
