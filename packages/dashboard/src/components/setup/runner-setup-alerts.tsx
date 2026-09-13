import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Settings2, Sparkles } from 'lucide-react'
import { Button } from '../ui/button'
import SetupWizard from '../wizard/SetupWizard'
import { SettingsProvider, useSettings } from '../../pages/Settings/SettingsContext'
import { evaluateReadiness } from '../../pages/Settings/readiness'
import { jsonRequest, requestJson } from '../../lib/http'
import { shouldShowGraduationCard } from '../../lib/coach-mode'
import { RUN_NOUN } from '../../lib/run-labels'

type SetupState = 'loading' | 'not-configured' | 'partial' | 'configured'

interface SetupSummary {
  state: SetupState
  missing: string[]
}

function SetupBanner({ setup, onLaunchWizard }: { setup: SetupSummary; onLaunchWizard: () => void }) {
  const isFirstRun = setup.state === 'not-configured'
  const title = isFirstRun ? 'Welcome to Coro — finish setup' : 'Runner setup is incomplete'
  const description = isFirstRun
    ? 'Connect a model and a code host — two steps, about a minute.'
    : `One or more essentials are missing. Finish configuration so ${RUN_NOUN.pluralLower} can run cleanly.`

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-warning-500/25 bg-warning-500/8 p-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-warning-500/25 bg-warning-500/10 text-warning-400">
          {isFirstRun ? <Sparkles className="size-4" /> : <AlertTriangle className="size-4" />}
        </div>
        <div className="space-y-1">
          <div className="text-[15px] font-semibold text-fg">{title}</div>
          <p className="max-w-2xl text-sm text-fg-muted">{description}</p>
          {setup.missing.length > 0 ? (
            <div className="text-sm text-fg-muted">
              Missing: <span className="text-fg">{setup.missing.join(', ')}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onLaunchWizard}>
          <Sparkles />
          Run setup wizard
        </Button>
        <Button asChild variant="outline">
          <Link to="/settings">
            <Settings2 />
            Open settings
          </Link>
        </Button>
      </div>
    </div>
  )
}

function GraduationCard({
  totalRuns,
  onTurnOff,
  onKeepOn,
}: {
  totalRuns: number
  onTurnOff: () => Promise<void>
  onKeepOn: () => Promise<void>
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-accent-500/25 bg-accent-500/8 p-5 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <div className="text-[15px] font-semibold text-fg">
          You&apos;ve done {totalRuns} runs. Ready to fly solo?
        </div>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Coach mode pauses Coro at every checkpoint. Turn it off and Coro will run end-to-end by
          default — you can still flip back on for any run.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void onTurnOff()}>
          Turn off coach mode
        </Button>
        <Button type="button" variant="outline" onClick={() => void onKeepOn()}>
          Keep it on
        </Button>
      </div>
    </div>
  )
}

function RunnerSetupAlertsInner() {
  const { draft, pluginsCatalogue, loading, firstRunCompleted, preferences, reload } = useSettings()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [autoLaunched, setAutoLaunched] = useState(false)

  const setup = useMemo<SetupSummary>(() => {
    if (loading || !pluginsCatalogue) {
      return { state: 'loading', missing: [] }
    }
    const readiness = evaluateReadiness({ draft, pluginsCatalogue })
    const llmReady = readiness.byId['llm-provider'].status === 'ok'
    const scmReady = readiness.byId['source-control'].status === 'ok'
    const missing: string[] = []
    if (!llmReady) missing.push('LLM provider')
    if (!scmReady) missing.push('Source control')
    if (missing.length === 0) return { state: 'configured', missing }

    const anyConfigured =
      Object.values(draft.pluginInstalled).some(
        entry =>
          (entry.enabled !== false) && Object.keys(entry.config ?? {}).length > 0,
      ) || !!draft.llmDefaultProvider
    return {
      state: anyConfigured ? 'partial' : 'not-configured',
      missing,
    }
  }, [draft, pluginsCatalogue, loading])

  useEffect(() => {
    if (autoLaunched) return
    if (setup.state !== 'not-configured') return
    if (firstRunCompleted) return
    if (typeof window === 'undefined') return
    const dismissed = window.localStorage.getItem('coro.firstRun.dismissed') === 'true'
    if (dismissed) return
    setWizardOpen(true)
    setAutoLaunched(true)
  }, [setup.state, autoLaunched, firstRunCompleted])

  function handleWizardOpenChange(next: boolean) {
    setWizardOpen(next)
    if (!next && typeof window !== 'undefined' && !firstRunCompleted) {
      window.localStorage.setItem('coro.firstRun.dismissed', 'true')
    }
  }

  const showBanner = setup.state !== 'configured' && setup.state !== 'loading'
  const showGraduation = shouldShowGraduationCard(preferences?.coachMode)

  if (!showBanner && !showGraduation) {
    return <SetupWizard open={wizardOpen} onOpenChange={handleWizardOpenChange} />
  }

  return (
    <div className="mb-4 space-y-3">
      {showBanner ? <SetupBanner setup={setup} onLaunchWizard={() => setWizardOpen(true)} /> : null}
      {showGraduation ? (
        <GraduationCard
          totalRuns={preferences?.coachMode?.totalRuns ?? 0}
          onTurnOff={async () => {
            await requestJson(
              '/config',
              jsonRequest(
                { coachMode: { enabled: false, graduatedAt: new Date().toISOString() } },
                { method: 'PUT' },
              ),
            )
            await reload()
          }}
          onKeepOn={async () => {
            const total = preferences?.coachMode?.totalRuns ?? 0
            await requestJson(
              '/config',
              jsonRequest(
                {
                  coachMode: {
                    graduateAfterRuns: total + 10,
                    graduatedAt: new Date().toISOString(),
                  },
                },
                { method: 'PUT' },
              ),
            )
            await reload()
          }}
        />
      ) : null}
      <SetupWizard open={wizardOpen} onOpenChange={handleWizardOpenChange} />
    </div>
  )
}

export default function RunnerSetupAlerts() {
  return (
    <SettingsProvider>
      <RunnerSetupAlertsInner />
    </SettingsProvider>
  )
}
