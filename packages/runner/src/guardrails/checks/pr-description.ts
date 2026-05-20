import type { GuardrailCheckFn } from '../types'

export interface PrDescriptionConfig {
  minLength?: number
  requiredHeadings?: string[]
}

export const checkPrDescription: GuardrailCheckFn = async (rule, ctx) => {
  const cfg = (rule.config ?? {}) as PrDescriptionConfig
  const minLength = typeof cfg.minLength === 'number' ? cfg.minLength : 80
  const requiredHeadings = Array.isArray(cfg.requiredHeadings)
    ? cfg.requiredHeadings.filter((h): h is string => typeof h === 'string')
    : ['## What']

  const description = typeof ctx.toolInput.description === 'string'
    ? ctx.toolInput.description
    : typeof ctx.toolInput.body === 'string'
      ? ctx.toolInput.body
      : ''

  const trimmed = description.trim()
  if (trimmed.length < minLength) {
    return {
      allow: false,
      reason:
        `PR description is too short (${trimmed.length} chars; minimum ${minLength}). ` +
        `Add a clear summary with required sections before opening the PR.`,
    }
  }

  const missing = requiredHeadings.filter(h => !trimmed.includes(h))
  if (missing.length > 0) {
    return {
      allow: false,
      reason:
        `PR description is missing required heading(s): ${missing.join(', ')}. ` +
        `Include them in the description body and retry.`,
    }
  }

  return { allow: true }
}
