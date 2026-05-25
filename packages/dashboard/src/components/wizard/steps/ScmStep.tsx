import { useState } from 'react'
import { Plug, ShieldCheck } from 'lucide-react'
import StepShell from './components/StepShell'
import ProviderCard from './components/ProviderCard'
import ProviderConfigForm from './components/ProviderConfigForm'
import LiveTestPanel from './components/LiveTestPanel'
import { Button } from '../../ui/button'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { buildTestPayload, getProvidersForStep } from '../provider-catalog'
import type { StepState, TestCheck, WizardAction } from '../wizard-state'

interface ScmStepProps {
  state: StepState
  dispatch: (action: WizardAction) => void
  onOpenDrawer: () => void
}

interface GitTestResponse {
  ok: boolean
  message?: string
  hint?: string
  checks?: TestCheck[]
}

/**
 * "Where does your code live?" — pick GitHub or Bitbucket, fill in
 * the minimum required fields, then click Test & Continue. Hits the
 * existing `POST /test/git` endpoint which already returns a
 * structured per-check breakdown (REST auth, scopes, git smart-HTTP)
 * that LiveTestPanel renders verbatim.
 */
export default function ScmStep({ state, dispatch, onOpenDrawer }: ScmStepProps) {
  const providers = getProvidersForStep('scm')
  const selectedId = state.selectedProviderId
  const selected = providers.find(p => p.id === selectedId)
  const [testing, setTesting] = useState(false)

  async function runTest() {
    if (!selected) return
    const payload = buildTestPayload('scm', selected.id, state.draftConfig)
    if (!payload) {
      dispatch({
        type: 'testResult',
        step: 'scm',
        result: {
          ok: false,
          message: 'This plugin has no built-in connectivity test.',
        },
      })
      return
    }
    setTesting(true)
    dispatch({ type: 'beginTest', step: 'scm' })
    try {
      const result = await requestJson<GitTestResponse>(
        payload.url,
        jsonRequest(payload.body, { method: 'POST' }),
      )
      dispatch({
        type: 'testResult',
        step: 'scm',
        result: {
          ok: result.ok,
          message: result.message ?? (result.ok ? 'Authenticated.' : 'Test failed.'),
          ...(result.hint ? { hint: result.hint } : {}),
          ...(result.checks ? { checks: result.checks } : {}),
        },
      })
    } catch (err) {
      dispatch({
        type: 'testResult',
        step: 'scm',
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
      eyebrow="Step 2 of 3"
      title="Where does your code live?"
      description="Coro clones repositories, opens branches, and submits pull requests on your behalf. Connect a git host so the agents can push their work."
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
        <>
          <ProviderConfigForm
            provider={selected}
            draft={state.draftConfig}
            onChange={(key, value) =>
              dispatch({ type: 'setField', step: 'scm', key, value })
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
