import { describe, expect, it } from 'vitest'
import {
  INITIAL_WIZARD_STATE,
  hasSkippedRequiredStep,
  isLocalOnlyScm,
  wizardReducer,
  type WizardState,
} from '../src/components/wizard/wizard-state'
import { sortForOnboarding } from '../src/hooks/useProviderCatalog'
import type { PluginCatalogEntry } from '../src/lib/plugin-catalog-types'

function passedLocal(state: WizardState = INITIAL_WIZARD_STATE): WizardState {
  let next = wizardReducer(state, { type: 'selectProvider', step: 'scm', providerId: 'local' })
  next = wizardReducer(next, {
    type: 'testResult',
    step: 'scm',
    result: { ok: true, message: 'ready' },
  })
  return next
}

describe('wizard-state', () => {
  it('starts on the model step with only llm and scm records', () => {
    expect(INITIAL_WIZARD_STATE.currentStep).toBe('llm')
    expect(Object.keys(INITIAL_WIZARD_STATE.steps).sort()).toEqual(['llm', 'scm'])
  })

  it('treats local + passed as local-only SCM', () => {
    expect(isLocalOnlyScm(INITIAL_WIZARD_STATE)).toBe(false)
    expect(isLocalOnlyScm(passedLocal())).toBe(true)

    const github = wizardReducer(INITIAL_WIZARD_STATE, {
      type: 'selectProvider',
      step: 'scm',
      providerId: 'github',
    })
    const githubPassed = wizardReducer(github, {
      type: 'testResult',
      step: 'scm',
      result: { ok: true, message: 'ok' },
    })
    expect(isLocalOnlyScm(githubPassed)).toBe(false)
  })

  it('flags a skipped LLM as a skipped required step', () => {
    const skipped = wizardReducer(INITIAL_WIZARD_STATE, { type: 'skip', step: 'llm' })
    expect(hasSkippedRequiredStep(skipped)).toBe(true)
    expect(hasSkippedRequiredStep(passedLocal())).toBe(false)
  })
})

describe('sortForOnboarding', () => {
  function entry(
    id: string,
    ui?: PluginCatalogEntry['ui'],
  ): PluginCatalogEntry {
    return {
      id,
      kind: 'scm',
      displayName: id,
      capabilities: {},
      authMethods: [],
      configSchema: {},
      ...(ui ? { ui } : {}),
    }
  }

  it('puts recommended first and local last regardless of input order', () => {
    const ordered = sortForOnboarding([
      entry('local'),
      entry('bitbucket'),
      entry('github', { recommendedForOnboarding: true }),
    ])
    expect(ordered.map(p => p.id)).toEqual(['github', 'bitbucket', 'local'])
  })
})
