import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { useSettings } from '../../pages/Settings/SettingsContext'
import LlmStep from './steps/LlmStep'
import OverseerStep from './steps/OverseerStep'
import ScmStep from './steps/ScmStep'
import SuccessStep from './steps/SuccessStep'
import CustomPluginDrawer from './panels/CustomPluginDrawer'
import {
  INITIAL_WIZARD_STATE,
  hasSkippedRequiredStep,
  isLocalOnlyScm,
  wizardReducer,
  type StepKind,
  type WizardState,
  type WizardStepId,
} from './wizard-state'

interface SetupWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const STEP_ORDER: WizardStepId[] = ['llm', 'scm', 'overseer', 'success']

/**
 * First-time-user setup wizard. A model, a code host, an optional
 * Overseer key, then a recap. Tracker, MCP, and drop-in plugins live
 * in Settings; the Local card is the SCM skip, not a footer button.
 */
export default function SetupWizard({ open, onOpenChange }: SetupWizardProps) {
  const {
    markFirstRunComplete,
    commitWizardStep,
    commitDecisionLayer,
    reloadPlugins,
    draft,
    meta,
    pluginsCatalogue,
    firstRunCompleted,
  } = useSettings()
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE)
  const [advancing, setAdvancing] = useState(false)
  const [advanceError, setAdvanceError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const hydratedRef = useRef(false)

  // Pre-select providers the user already has configured (the wizard
  // is also reachable from Settings → "Run setup wizard"). This means
  // a returning user sees their existing GitHub / Anthropic choice
  // already filled in instead of an empty picker.
  //
  // Do not pre-select `local` on a true first run — it auto-passes
  // with an empty form and would steal the recommended GitHub card.
  useEffect(() => {
    if (!open) {
      hydratedRef.current = false
      return
    }
    if (hydratedRef.current) return
    if (!pluginsCatalogue) return
    hydratedRef.current = true

    const llmId = draft.llmDefaultProvider
    if (llmId && draft.pluginInstalled[llmId]) {
      dispatch({ type: 'selectProvider', step: 'llm', providerId: llmId })
      for (const [k, v] of Object.entries(draft.pluginInstalled[llmId].config)) {
        dispatch({ type: 'setField', step: 'llm', key: k, value: v })
      }
    }
    const scmIds = Object.entries(draft.pluginInstalled).filter(
      ([id, e]) =>
        e.enabled !== false &&
        pluginsCatalogue.plugins.find(p => p.manifest.id === id)?.manifest.kind === 'scm',
    )
    const hostedScm = scmIds.filter(([id]) => id !== 'local')
    const scm =
      hostedScm.find(([id]) => id === draft.pluginDefaultScm) ??
      hostedScm[0] ??
      (firstRunCompleted ? scmIds.find(([id]) => id === 'local') : undefined)
    if (scm) {
      dispatch({ type: 'selectProvider', step: 'scm', providerId: scm[0] })
      for (const [k, v] of Object.entries(scm[1].config)) {
        dispatch({ type: 'setField', step: 'scm', key: k, value: v })
      }
    }
    const overseerMode = draft.decisionMode === 'live' ? 'live' : 'shadow'
    dispatch({
      type: 'hydrateOverseer',
      apiKey: draft.decisionApiKey,
      mode: overseerMode,
      configured: draft.decisionMode !== 'off' && Boolean(draft.decisionApiKey || meta?.resolved.decisionConfigured),
    })
  }, [open, draft, pluginsCatalogue, firstRunCompleted, meta])

  const currentIndex = STEP_ORDER.indexOf(state.currentStep)
  const isFinal = state.currentStep === 'success'

  const advanceTo = useCallback((next: WizardStepId) => {
    setAdvanceError(null)
    dispatch({ type: 'goto', step: next })
  }, [])

  const handleBack = useCallback(() => {
    setAdvanceError(null)
    const prev = STEP_ORDER[Math.max(0, currentIndex - 1)]
    advanceTo(prev)
  }, [advanceTo, currentIndex])

  const handleClose = useCallback(() => {
    if (typeof window !== 'undefined') {
      const completed = window.localStorage.getItem('coro.firstRun.completed') === 'true'
      if (!completed) window.localStorage.setItem('coro.firstRun.dismissed', 'true')
    }
    onOpenChange(false)
  }, [onOpenChange])

  /**
   * Commits the just-passed step's draft to the runner and moves to
   * the next step. We persist incrementally so closing mid-wizard
   * doesn't lose verified credentials.
   */
  const handleContinue = useCallback(async () => {
    setAdvanceError(null)
    const step = state.currentStep
    const stepKind: StepKind | null =
      step === 'llm' ? 'llm' : step === 'scm' ? 'scm' : null

    if (step === 'overseer') {
      const key = state.overseer.apiKey.trim()
      const alreadyOn = Boolean(meta?.resolved.decisionConfigured)
      if (!key && !alreadyOn) {
        setAdvanceError('Paste a Jev key, or skip this step. Coro runs without Overseer.')
        return
      }
      setAdvancing(true)
      try {
        await commitDecisionLayer({ mode: state.overseer.mode, apiKey: state.overseer.apiKey })
        dispatch({ type: 'passOverseer' })
      } catch (err) {
        setAdvanceError(
          `Could not save Overseer: ${err instanceof Error ? err.message : String(err)}`,
        )
        setAdvancing(false)
        return
      } finally {
        setAdvancing(false)
      }
    }

    if (stepKind && state.steps[stepKind].status === 'passed') {
      const providerId = state.steps[stepKind].selectedProviderId
      if (providerId) {
        setAdvancing(true)
        try {
          await commitWizardStep({
            kind: stepKind === 'llm' ? 'executor' : stepKind,
            pluginId: providerId,
            config: state.steps[stepKind].draftConfig,
            setAsDefault: true,
          })
        } catch (err) {
          setAdvanceError(
            `Could not save the step: ${err instanceof Error ? err.message : String(err)}`,
          )
          setAdvancing(false)
          return
        } finally {
          setAdvancing(false)
        }
      }
    }

    const next = STEP_ORDER[Math.min(STEP_ORDER.length - 1, currentIndex + 1)]
    advanceTo(next)
  }, [state, currentIndex, advanceTo, commitWizardStep, commitDecisionLayer, meta])

  const handleSkip = useCallback(() => {
    setAdvanceError(null)
    if (state.currentStep === 'llm' || state.currentStep === 'scm') {
      dispatch({ type: 'skip', step: state.currentStep })
    }
    if (state.currentStep === 'overseer') {
      dispatch({ type: 'skipOverseer' })
    }
    const next = STEP_ORDER[Math.min(STEP_ORDER.length - 1, currentIndex + 1)]
    advanceTo(next)
  }, [state.currentStep, currentIndex, advanceTo])

  const finish = useCallback(
    async (target: 'newJob' | 'dashboard' | 'settings') => {
      setFinishing(true)
      setAdvanceError(null)
      try {
        const skipped: Array<'llm' | 'scm' | 'tracker'> = []
        if (state.steps.llm.status === 'skipped') skipped.push('llm')
        if (state.steps.scm.status === 'skipped') skipped.push('scm')
        await markFirstRunComplete({ skipped })
      } catch (err) {
        // The wizard stays open: closing it here would claim setup was
        // recorded while the runner never received it.
        setAdvanceError(
          `Could not save setup completion: ${err instanceof Error ? err.message : String(err)}`,
        )
        setFinishing(false)
        return
      }
      setFinishing(false)
      // `target` is a hint for analytics / navigation. The Link in
      // SuccessStep handles the actual navigation via react-router.
      void target
      onOpenChange(false)
    },
    [markFirstRunComplete, onOpenChange, state.steps],
  )

  // ── Drawer ─────────────────────────────────────────────────────────────
  const drawerStep = state.drawerForStep
  const drawerOpen = state.drawerOpen && drawerStep !== null

  // ── Footer compute ─────────────────────────────────────────────────────
  const currentStepKind: StepKind | null =
    state.currentStep === 'llm' ? 'llm' : state.currentStep === 'scm' ? 'scm' : null
  const currentStepState = currentStepKind ? state.steps[currentStepKind] : null
  const overseerReady =
    state.overseer.apiKey.trim().length > 0 || Boolean(meta?.resolved.decisionConfigured)
  const canAdvance =
    state.currentStep === 'overseer'
      ? overseerReady
      : currentStepState
        ? currentStepState.status === 'passed'
        : true

  // ── Body ───────────────────────────────────────────────────────────────
  let body: ReactNode = null
  if (drawerOpen && drawerStep) {
    body = (
      <CustomPluginDrawer
        step={drawerStep}
        onClose={() => {
          void reloadPlugins()
          dispatch({ type: 'closeDrawer' })
        }}
      />
    )
  } else {
    switch (state.currentStep) {
      case 'llm':
        body = (
          <LlmStep
            state={state.steps.llm}
            dispatch={dispatch}
            onOpenDrawer={() => dispatch({ type: 'openDrawer', step: 'llm' })}
          />
        )
        break
      case 'scm':
        body = (
          <ScmStep
            state={state.steps.scm}
            dispatch={dispatch}
            onOpenDrawer={() => dispatch({ type: 'openDrawer', step: 'scm' })}
          />
        )
        break
      case 'overseer':
        body = (
          <OverseerStep
            state={state.overseer}
            configured={Boolean(meta?.resolved.decisionConfigured)}
            onKey={apiKey => dispatch({ type: 'setOverseerKey', apiKey })}
            onMode={mode => dispatch({ type: 'setOverseerMode', mode })}
          />
        )
        break
      case 'success':
        body = (
          <SuccessStep
            wizardState={state}
            onFinish={finish}
            onOpenScmStep={() => advanceTo('scm')}
          />
        )
        break
    }
  }

  const headerCopy =
    state.currentStep === 'llm'
      ? {
          title: 'Welcome to Coro',
          description:
            'A model, a code host, and an optional faithfulness check. About a minute.',
        }
      : state.currentStep === 'scm'
        ? {
            title: 'First-time setup',
            description: 'Connect the code host Coro will clone from and open pull requests on.',
          }
        : state.currentStep === 'overseer'
          ? {
              title: 'First-time setup',
              description: 'Optional. Add a Jev key if you have one. Skip it and Coro runs the same.',
            }
          : {
            title: 'You are set!',
            description: 'Recap of what you just configured and what to do next.',
          }

  const successHint = finishing
    ? 'Saving your setup…'
    : hasSkippedRequiredStep(state)
      ? 'Click "Finish setup in Settings" to wrap up the remaining required pieces.'
      : isLocalOnlyScm(state)
        ? 'Your first run will point at a git checkout on this machine.'
        : 'Click "Create my first job" to dispatch a run.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 max-h-[min(760px,calc(100vh-2rem))]">
        <DialogHeader className="shrink-0">
          <div className="flex items-start justify-between gap-3 pr-10">
            <div className="space-y-1">
              <DialogTitle>{headerCopy.title}</DialogTitle>
              <DialogDescription>{headerCopy.description}</DialogDescription>
            </div>
          </div>
          <Stepper currentStep={state.currentStep} wizardState={state} />
        </DialogHeader>

        <DialogBody className="flex-1 min-h-0 space-y-5 pt-4">
          {advanceError ? (
            <div className="rounded-xl border border-danger-500/35 bg-danger-500/8 px-3 py-2.5 text-sm text-danger-300">
              {advanceError}
            </div>
          ) : null}
          {body}
        </DialogBody>

        {!isFinal && !drawerOpen ? (
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-overlay/30 px-6 py-4">
            <div className="flex items-center gap-2">
              {currentStepKind === 'llm' || currentStepKind === 'scm' || state.currentStep === 'overseer' ? (
                <Button type="button" variant="ghost" size="sm" onClick={handleSkip} disabled={advancing}>
                  {state.currentStep === 'overseer' ? "Skip — I don't have a key" : 'Skip for now'}
                </Button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleBack}
                disabled={currentIndex === 0 || advancing}
              >
                <ArrowLeft />
                Back
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClose}
                disabled={advancing}
              >
                Close — finish later
              </Button>
              <Button
                type="button"
                onClick={() => void handleContinue()}
                disabled={(currentStepKind ? !canAdvance : false) || advancing}
              >
                {advancing ? (
                  <>
                    <Loader2 className="animate-spin" /> Saving…
                  </>
                ) : state.currentStep === 'overseer' ? (
                  <>
                    Turn on Overseer <ArrowRight />
                  </>
                ) : (
                  <>
                    Continue <ArrowRight />
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : null}

        {isFinal ? (
          <div className="shrink-0 border-t border-line bg-overlay/30 px-6 py-4 text-[12px] text-fg-subtle">
            {successHint}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Stepper({
  currentStep,
  wizardState,
}: {
  currentStep: WizardStepId
  wizardState: WizardState
}) {
  const labels: Array<{ id: WizardStepId; label: string; kind?: StepKind }> = [
    { id: 'llm', label: 'Model', kind: 'llm' },
    { id: 'scm', label: 'Code host', kind: 'scm' },
    { id: 'overseer', label: 'Overseer' },
  ]
  const currentIdx = STEP_ORDER.indexOf(currentStep)

  return (
    <ol className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle">
      {labels.map(({ id, label, kind }) => {
        const idx = STEP_ORDER.indexOf(id)
        const current = idx === currentIdx
        const passed = kind
          ? wizardState.steps[kind].status === 'passed'
          : id === 'overseer'
            ? wizardState.overseer.status === 'passed'
            : idx < currentIdx
        const skipped = kind
          ? wizardState.steps[kind].status === 'skipped'
          : id === 'overseer'
            ? wizardState.overseer.status === 'skipped'
            : false
        const optionalSkip = id === 'overseer' && skipped
        const done = passed || (skipped && !optionalSkip) || idx < currentIdx
        return (
          <li
            key={id}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors',
              current
                ? 'border-accent-500/45 bg-accent-500/10 text-fg'
                : passed
                  ? 'border-success-500/30 bg-success-500/8 text-success-300'
                  : skipped && !optionalSkip
                    ? 'border-warning-500/25 bg-warning-500/8 text-warning-300'
                    : 'border-line bg-overlay/40',
            )}
          >
            <span
              className={cn(
                'inline-block size-1.5 rounded-full',
                current ? 'bg-accent-400' : done ? 'bg-success-400' : 'bg-fg-subtle/60',
              )}
            />
            <span className="font-medium uppercase tracking-[0.14em]">{label}</span>
          </li>
        )
      })}
    </ol>
  )
}
