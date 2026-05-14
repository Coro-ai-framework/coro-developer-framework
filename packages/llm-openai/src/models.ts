import type { ExecutorModelDescriptor, NormalizedTokenUsage } from '@coro/plugin-sdk'

export const OPENAI_PLUGIN_ID = 'openai' as const

export const OPENAI_MODELS: ReadonlyArray<ExecutorModelDescriptor> = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextTokens: 400_000,
    tier: 'planning',
    supportsThinking: true,
    pricing: { inputPerMTokens: 5, cacheReadPerMTokens: 0.5, outputPerMTokens: 30 },
  },
  {
    id: 'gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    contextTokens: 400_000,
    tier: 'planning',
    supportsThinking: true,
    pricing: { inputPerMTokens: 30, outputPerMTokens: 180 },
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    contextTokens: 400_000,
    tier: 'coding',
    supportsThinking: true,
    pricing: { inputPerMTokens: 2.5, cacheReadPerMTokens: 0.25, outputPerMTokens: 15 },
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    contextTokens: 400_000,
    tier: 'mini',
    supportsThinking: true,
    pricing: { inputPerMTokens: 0.75, cacheReadPerMTokens: 0.075, outputPerMTokens: 4.5 },
  },
  {
    id: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    contextTokens: 400_000,
    tier: 'mini',
    supportsThinking: true,
    pricing: { inputPerMTokens: 0.2, cacheReadPerMTokens: 0.02, outputPerMTokens: 1.25 },
  },
  {
    id: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    contextTokens: 400_000,
    tier: 'coding',
    supportsThinking: true,
    pricing: { inputPerMTokens: 1.75, cacheReadPerMTokens: 0.175, outputPerMTokens: 14 },
  },
]

export function supportsOpenAiModel(model: string): boolean {
  if (typeof model !== 'string' || model.length === 0) return false
  return model.startsWith('gpt-') || /^o\d/.test(model) || model.startsWith('chatgpt-')
}

export function calculateOpenAiCostUsd(model: string, usage: NormalizedTokenUsage): number {
  const descriptor = findPricingDescriptor(model)
  const pricing = descriptor?.pricing
  if (!pricing) return 0
  const inputCost = usage.inputTokens * ((pricing.inputPerMTokens ?? 0) / 1_000_000)
  const outputCost = usage.outputTokens * ((pricing.outputPerMTokens ?? 0) / 1_000_000)
  const cacheReadCost = usage.cacheReadInputTokens * ((pricing.cacheReadPerMTokens ?? 0) / 1_000_000)
  const cacheCreationCost = usage.cacheCreationInputTokens * ((pricing.cacheCreationPerMTokens ?? pricing.inputPerMTokens ?? 0) / 1_000_000)
  return inputCost + outputCost + cacheReadCost + cacheCreationCost
}

function findPricingDescriptor(model: string): ExecutorModelDescriptor | undefined {
  return OPENAI_MODELS.find(m => model === m.id || model.startsWith(`${m.id}-`))
}
