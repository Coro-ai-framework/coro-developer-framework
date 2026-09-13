import type { ExecutorModelDescriptor, NormalizedTokenUsage } from '@coro-ai/plugin-sdk'

export const OPENAI_PLUGIN_ID = 'openai' as const

export const OPENAI_MODELS: ReadonlyArray<ExecutorModelDescriptor> = [
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    contextTokens: 1_050_000,
    tier: 'planning',
    supportsThinking: true,
    pricing: {
      inputPerMTokens: 10,
      cacheReadPerMTokens: 1,
      cacheCreationPerMTokens: 12.5,
      outputPerMTokens: 50,
    },
  },
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    contextTokens: 1_050_000,
    tier: 'planning',
    isDefault: true,
    supportsThinking: true,
    pricing: {
      inputPerMTokens: 4,
      cacheReadPerMTokens: 0.4,
      cacheCreationPerMTokens: 5,
      outputPerMTokens: 20,
    },
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    contextTokens: 1_050_000,
    tier: 'coding',
    isDefault: true,
    supportsThinking: true,
    pricing: {
      inputPerMTokens: 2,
      cacheReadPerMTokens: 0.2,
      cacheCreationPerMTokens: 2.5,
      outputPerMTokens: 12,
    },
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    contextTokens: 1_050_000,
    tier: 'mini',
    isDefault: true,
    supportsThinking: true,
    pricing: {
      inputPerMTokens: 0.2,
      cacheReadPerMTokens: 0.02,
      cacheCreationPerMTokens: 0.25,
      outputPerMTokens: 1.2,
    },
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextTokens: 1_050_000,
    tier: 'planning',
    supportsThinking: true,
    pricing: { inputPerMTokens: 5, cacheReadPerMTokens: 0.5, outputPerMTokens: 30 },
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    contextTokens: 1_050_000,
    tier: 'coding',
    supportsThinking: true,
    pricing: { inputPerMTokens: 2.5, cacheReadPerMTokens: 0.25, outputPerMTokens: 15 },
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
