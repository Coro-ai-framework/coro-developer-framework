// ── Cost helpers shared by the model picker + per-phase panel ──────────────
//
// Pricing on `ProviderModelDescriptor` is USD per million tokens, mirroring
// the SDK's `ExecutorModelDescriptor.pricing`. Formatters here are
// purely cosmetic — never used for accounting, which always trusts the
// runtime-reported `costUsd` on the phase usage record.

import type { ProviderModelDescriptor } from './useProviderModels'

export function findModel(
  modelsByProvider: Record<string, ProviderModelDescriptor[] | null | undefined>,
  provider: string,
  model: string,
): ProviderModelDescriptor | null {
  if (!provider || !model) return null
  const list = modelsByProvider[provider]
  if (!list) return null
  return list.find(m => m.id === model) ?? null
}

/** "≈ $3.00 in / $15.00 out per M tok" or null when pricing is unknown. */
export function formatPricingHint(model: ProviderModelDescriptor | null | undefined): string | null {
  const tier = priceTier(model)
  if (!tier) return null
  return `${tier.symbol} ${tier.label}`
}

/**
 * Compact per-option price indicator (e.g. "$$$") used inside <option>
 * labels. Returns empty string when pricing isn't published. The tier
 * is a coarse 1–5 bucket across the known model price range so users
 * can eyeball relative cost without reading dollar amounts.
 */
export function formatOptionPriceTag(model: ProviderModelDescriptor | null | undefined): string {
  return priceTier(model)?.symbol ?? ''
}

/**
 * Bucket a model's blended (input + output) per-M price into a 1–5
 * "$" tier. Thresholds are tuned to the current Anthropic + OpenAI
 * lineup so the cheapest models land at "$" and frontier models at
 * "$$$$$" — adjust if a new generation reshapes the range.
 */
export function priceTier(
  model: ProviderModelDescriptor | null | undefined,
): { symbol: string; label: string } | null {
  const p = model?.pricing
  if (!p) return null
  const inP = p.inputPerMTokens
  const outP = p.outputPerMTokens
  if (inP == null && outP == null) return null
  const avg
    = inP != null && outP != null ? (inP + outP) / 2
    : inP ?? outP ?? 0
  let count: number
  let label: string
  if (avg <= 1) { count = 1; label = 'cheapest' }
  else if (avg <= 5) { count = 2; label = 'low' }
  else if (avg <= 20) { count = 3; label = 'mid' }
  else if (avg <= 50) { count = 4; label = 'high' }
  else { count = 5; label = 'frontier' }
  return { symbol: '$'.repeat(count), label }
}

/**
 * Project the cost a phase would incur if it had been run with the
 * given model, using its recorded token counts as the workload. Returns
 * null when the model has no pricing or token counts are absent.
 */
export function projectPhaseCostUsd(
  model: ProviderModelDescriptor | null | undefined,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  } | null | undefined,
): number | null {
  const p = model?.pricing
  if (!p || !usage) return null
  const perToken = (rate: number | undefined) => (rate ?? 0) / 1_000_000
  const cost
    = (usage.inputTokens ?? 0) * perToken(p.inputPerMTokens)
    + (usage.outputTokens ?? 0) * perToken(p.outputPerMTokens)
    + (usage.cacheReadInputTokens ?? 0) * perToken(p.cacheReadPerMTokens)
    + (usage.cacheCreationInputTokens ?? 0) * perToken(p.cacheCreationPerMTokens ?? p.inputPerMTokens)
  return cost
}

/** Compact USD formatter — sub-cent values shown with extra precision. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '—'
  if (amount === 0) return '0.00'
  if (Math.abs(amount) < 0.01) return amount.toFixed(4)
  if (Math.abs(amount) < 1) return amount.toFixed(3)
  return amount.toFixed(2)
}
