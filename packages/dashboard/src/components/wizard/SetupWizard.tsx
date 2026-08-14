import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import type { WizardState } from './wizard-state'
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
import WelcomeStep from './steps/WelcomeStep'
import LlmStep from './steps/LlmStep'
import ScmStep from './steps/ScmStep'
import TrackerStep from './steps/TrackerStep'
import SuccessStep from './steps/SuccessStep'
import CustomPluginDrawer from './panels/CustomPluginDrawer'
import {
  INITIAL_WIZARD_STATE,
  hasSkippedRequiredStep,
  wizardReducer,
  type WizardStepId,
} from './wizard-state'
import type { StepKind } from '../../lib/plugin-catalog-types'

interface SetupWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const STEP_ORDER: WizardStepId[] = ['welcome', 'llm', 'scm', 'tracker', 'success']

/**
 * First-time-user setup wizard. The legacy implementation embedded
 * full Settings sections (with their own card chrome, dirty-tracking,
 * and aliases editor) into a modal — overwhelming on first run.
 *
 * This rewrite is purpose-built:
 *   - Local state machine (`wizardReducer`) holds per-step selection,
 *     draft, and last test result. No coupling to the global draft
 *     except at commit time.
 *   - Each config step (LLM / SCM / tracker) has its own dedicated
 *     component with a single question, provider radio cards, the
 *     minimum field set, and a "Test & Continue" button that pings
 *     the runner for live verification.
 *   - Every step is skippable; the success step warns when a
 *     required step was skipped.
 *   - A custom-plugin drawer slides in over the step body so the user
 *     can install drop-in plugins (GitLab, etc.) without leaving the
 *     wizard.
 */
export default function SetupWizard({ open, onOpenChange }: SetupWizardProps) {
  const { markFirstRunComplete, commitWizardStep, reloadPlugins, draft, pluginsCatalogue } = useSettings()
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE)
  const [advancing, setAdvancing] = useState(false)
  const [advanceError, setAdvanceError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const hydratedRef = useRef(false)

  // Pre-select providers the user already has configured (the wizard
  // is also reachable from Settings → "Run setup wizard"). This means
  // a returning user sees their existing GitHub / Anthropic choice
  // already filled in instead of an empty picker.
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
    const scm = scmIds.find(([id]) => id === draft.pluginDefaultScm) ?? scmIds[0]
    if (scm) {
      dispatch({ type: 'selectProvider', step: 'scm', providerId: scm[0] })
      for (const [k, v] of Object.entries(scm[1].config)) {
        dispatch({ type: 'setField', step: 'scm', key: k, value: v })
      }
    }
    const trackerIds = Object.entries(draft.pluginInstalled).filter(
      ([id, e]) =>
        e.enabled !== false &&
        pluginsCatalogue.plugins.find(p => p.manifest.id === id)?.manifest.kind === 'tracker',
    )
    const tracker = trackerIds.find(([id]) => id === draft.pluginDefaultTracker) ?? trackerIds[0]
    if (tracker) {
      dispatch({ type: 'selectProvider', step: 'tracker', providerId: tracker[0] })
      for (const [k, v] of Object.entries(tracker[1].config)) {
        dispatch({ type: 'setField', step: 'tracker', key: k, value: v })
      }
    }
  }, [open, draft, pluginsCatalogue])

  const currentIndex = STEP_ORDER.indexOf(state.currentStep)
  const isFinal = state.currentStep === 'success'

  const advanceTo = useCallback(
    (next: WizardStepId) => {
      setAdvanceError(null)
      dispatch({ type: 'goto', step: next })
    },
    [],
  )

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
      step === 'llm' ? 'llm' : step === 'scm' ? 'scm' : step === 'tracker' ? 'tracker' : null

    if (stepKind && state.steps[stepKind].status === 'passed') {
      const providerId = state.steps[stepKind].selectedProviderId
      if (providerId && providerId !== '__skip__') {
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

    // Welcome → llm → scm → tracker → success. Tracker auto-advances
    // to success even if the user skipped via the "I don't use a tracker"
    // card (the TrackerStep dispatches `skip` before we get here).
    const next = STEP_ORDER[Math.min(STEP_ORDER.length - 1, currentIndex + 1)]
    advanceTo(next)
  }, [state, currentIndex, advanceTo, commitWizardStep])

  const handleSkip = useCallback(() => {
    setAdvanceError(null)
    const step = state.currentStep
    if (step === 'llm' || step === 'scm' || step === 'tracker') {
      dispatch({ type: 'skip', step })
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
        if (state.steps.tracker.status === 'skipped') skipped.push('tracker')
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
    state.currentStep === 'llm' ? 'llm' :
    state.currentStep === 'scm' ? 'scm' :
    state.currentStep === 'tracker' ? 'tracker' :
    null
  const currentStepState = currentStepKind ? state.steps[currentStepKind] : null
  const canAdvance = currentStepState ? currentStepState.status === 'passed' : true

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
      case 'welcome':
        body = <WelcomeStep />
        break
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
      case 'tracker':
        body = (
          <TrackerStep
            state={state.steps.tracker}
            dispatch={dispatch}
            onSkip={() => {
              const next = STEP_ORDER[Math.min(STEP_ORDER.length - 1, currentIndex + 1)]
              advanceTo(next)
            }}
            onOpenDrawer={() => dispatch({ type: 'openDrawer', step: 'tracker' })}
          />
        )
        break
      case 'success':
        body = <SuccessStep wizardState={state} onFinish={finish} />
        break
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const isWelcome = state.currentStep === 'welcome'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 max-h-[min(760px,calc(100vh-2rem))]">
        {isWelcome ? (
          <DialogHeader className="sr-only">
            <DialogTitle>Welcome to Coro</DialogTitle>
            <DialogDescription>First-time setup</DialogDescription>
          </DialogHeader>
        ) : (
          <DialogHeader className="shrink-0">
            <div className="flex items-start justify-between gap-3 pr-10">
              <div className="space-y-1">
                <DialogTitle>{isFinal ? 'You are set!' : 'First-time setup'}</DialogTitle>
                <DialogDescription>
                  {isFinal
                    ? 'Recap of what you just configured and what to do next.'
                    : 'Configure the essentials — one minute, three steps.'}
                </DialogDescription>
              </div>
            </div>
            <Stepper currentStep={state.currentStep} wizardState={state} />
          </DialogHeader>
        )}

        {isWelcome ? (
          <div className="flex-1 min-h-0 overflow-y-auto">{body}</div>
        ) : (
          <DialogBody className="flex-1 min-h-0 space-y-5 pt-4">
            {advanceError ? (
              <div className="rounded-xl border border-danger-500/35 bg-danger-500/8 px-3 py-2.5 text-sm text-danger-300">
                {advanceError}
              </div>
            ) : null}
            {body}
          </DialogBody>
        )}

        {/* ── Footer ───────────────────────────────────────────────── */}
        {!isFinal && !drawerOpen ? (
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-overlay/30 px-6 py-4">
            <div className="flex items-center gap-2">
              {!isWelcome && currentStepKind ? (
                <Button type="button" variant="ghost" size="sm" onClick={handleSkip} disabled={advancing}>
                  Skip for now
                </Button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleBack}
                disabled={isWelcome || advancing}
              >
                <ArrowLeft />
                Back
              </Button>
              {!isWelcome ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClose}
                  disabled={advancing}
                >
                  Close — finish later
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={() => void handleContinue()}
                disabled={(currentStepKind ? !canAdvance : false) || advancing}
              >
                {advancing ? (
                  <>
                    <Loader2 className="animate-spin" /> Saving…
                  </>
                ) : isWelcome ? (
                  <>
                    Let's get started <ArrowRight />
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
            {finishing ? 'Saving your setup…' : hasSkippedRequiredStep(state)
              ? 'Click "Finish setup in Settings" to wrap up the remaining required pieces.'
              : 'Click "Create my first job" to dispatch a run.'}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// ── Stepper pills ───────────────────────────────────────────────────────────

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
    { id: 'tracker', label: 'Tracker', kind: 'tracker' },
  ]
  const order = STEP_ORDER
  const currentIdx = order.indexOf(currentStep)

  return (
    <ol className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle">
      {labels.map(({ id, label, kind }) => {
        const idx = order.indexOf(id)
        const current = idx === currentIdx
        const passed = kind ? wizardState.steps[kind].status === 'passed' : idx < currentIdx
        const skipped = kind ? wizardState.steps[kind].status === 'skipped' : false
        const done = passed || skipped || idx < currentIdx
        return (
          <li
            key={id}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors',
              current
                ? 'border-accent-500/45 bg-accent-500/10 text-fg'
                : passed
                  ? 'border-success-500/30 bg-success-500/8 text-success-300'
                  : skipped
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
