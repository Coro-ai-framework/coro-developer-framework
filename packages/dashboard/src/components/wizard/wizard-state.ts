// Local state machine for the FTUE setup wizard.
//
// The dashboard's `SettingsContext` already has a draft + dirty-track
// of the entire config. We deliberately don't reuse that draft here —
// the wizard's UX is "pick one provider per step, fill in the
// minimum, prove it works, advance". Coupling that flow to the
// global draft (which still carries every other Settings section)
// would force every step to think about unrelated dirty state and
// invent skip semantics on top of it.
//
// Instead, the wizard keeps a small per-step record of selection +
// draft fields + last test result, and only commits to the global
// SettingsContext when a step's "Test & Continue" passes (or the
// user explicitly skips).

export type StepKind = 'llm' | 'scm' | 'tracker'

export type StepStatus = 'idle' | 'testing' | 'passed' | 'failed' | 'skipped'

export interface TestCheck {
  name: string
  ok: boolean
  message: string
  hint?: string
}

export interface TestResult {
  ok: boolean
  message: string
  hint?: string
  checks?: TestCheck[]
}

export interface StepState {
  /** The provider id the user selected for this step (e.g. `'anthropic'`). */
  selectedProviderId: string | null
  /** Form draft for the selected provider (matches plugin config keys). */
  draftConfig: Record<string, unknown>
  /** Status of the last "Test & Continue" attempt. */
  status: StepStatus
  /** Last test response, used to render success / error notices. */
  lastResult: TestResult | null
}

export type WizardStepId = 'welcome' | 'llm' | 'scm' | 'tracker' | 'success'

export interface WizardState {
  currentStep: WizardStepId
  steps: Record<StepKind, StepState>
  /** Open drawer flag — true when the user is browsing custom plugins. */
  drawerOpen: boolean
  /** Step the drawer is associated with (so closing returns to the right body). */
  drawerForStep: StepKind | null
}

const EMPTY_STEP: StepState = {
  selectedProviderId: null,
  draftConfig: {},
  status: 'idle',
  lastResult: null,
}

export const INITIAL_WIZARD_STATE: WizardState = {
  currentStep: 'welcome',
  steps: {
    llm: { ...EMPTY_STEP, draftConfig: {} },
    scm: { ...EMPTY_STEP, draftConfig: {} },
    tracker: { ...EMPTY_STEP, draftConfig: {} },
  },
  drawerOpen: false,
  drawerForStep: null,
}

export type WizardAction =
  | { type: 'goto'; step: WizardStepId }
  | { type: 'selectProvider'; step: StepKind; providerId: string }
  | { type: 'setField'; step: StepKind; key: string; value: unknown }
  | { type: 'beginTest'; step: StepKind }
  | { type: 'testResult'; step: StepKind; result: TestResult }
  | { type: 'skip'; step: StepKind }
  | { type: 'openDrawer'; step: StepKind }
  | { type: 'closeDrawer' }

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'goto':
      return { ...state, currentStep: action.step }
    case 'selectProvider': {
      const prev = state.steps[action.step]
      // Switching providers resets the per-provider draft + test
      // status — we don't want a stale OpenAI key to bleed into an
      // Anthropic selection or vice versa.
      if (prev.selectedProviderId === action.providerId) return state
      return {
        ...state,
        steps: {
          ...state.steps,
          [action.step]: {
            ...EMPTY_STEP,
            selectedProviderId: action.providerId,
          },
        },
      }
    }
    case 'setField': {
      const prev = state.steps[action.step]
      const existing = prev.draftConfig[action.key]
      const isClear =
        action.value === '' || action.value === undefined || action.value === null
      if (isClear && existing === undefined) return state
      if (!isClear && existing === action.value) return state
      if (
        !isClear &&
        existing !== null &&
        typeof existing === 'object' &&
        action.value !== null &&
        typeof action.value === 'object' &&
        JSON.stringify(existing) === JSON.stringify(action.value)
      ) {
        return state
      }
      const nextConfig = { ...prev.draftConfig }
      if (isClear) {
        delete nextConfig[action.key]
      } else {
        nextConfig[action.key] = action.value
      }
      // Any edit invalidates the previous test result so the user
      // doesn't get "Continue" enabled on stale data.
      return {
        ...state,
        steps: {
          ...state.steps,
          [action.step]: {
            ...prev,
            draftConfig: nextConfig,
            status: 'idle',
            lastResult: null,
          },
        },
      }
    }
    case 'beginTest': {
      const prev = state.steps[action.step]
      return {
        ...state,
        steps: {
          ...state.steps,
          [action.step]: { ...prev, status: 'testing' },
        },
      }
    }
    case 'testResult': {
      const prev = state.steps[action.step]
      return {
        ...state,
        steps: {
          ...state.steps,
          [action.step]: {
            ...prev,
            status: action.result.ok ? 'passed' : 'failed',
            lastResult: action.result,
          },
        },
      }
    }
    case 'skip': {
      const prev = state.steps[action.step]
      return {
        ...state,
        steps: {
          ...state.steps,
          [action.step]: { ...prev, status: 'skipped', lastResult: null },
        },
      }
    }
    case 'openDrawer':
      return { ...state, drawerOpen: true, drawerForStep: action.step }
    case 'closeDrawer':
      return { ...state, drawerOpen: false, drawerForStep: null }
    default:
      return state
  }
}

/**
 * Required steps for the success screen's "you skipped a required
 * step" warning. `tracker` is always optional.
 */
export const REQUIRED_STEPS: ReadonlyArray<StepKind> = ['llm', 'scm']

export function hasSkippedRequiredStep(state: WizardState): boolean {
  return REQUIRED_STEPS.some(s => state.steps[s].status === 'skipped')
}

export function allStepsAddressed(state: WizardState): boolean {
  // For the success step's CTA decision: every required step is
  // either passed or explicitly skipped.
  return REQUIRED_STEPS.every(
    s => state.steps[s].status === 'passed' || state.steps[s].status === 'skipped',
  )
}
