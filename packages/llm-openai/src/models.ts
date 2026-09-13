import * as path from 'node:path'
import {
  calculateCostFromCatalogue,
  defaultAliasesFromCatalogue,
  defaultModelFromCatalogue,
  loadExecutorModelCatalogue,
  supportsFromCatalogue,
  type ExecutorModelCatalogue,
  type ExecutorModelDescriptor,
  type NormalizedTokenUsage,
} from '@coro-ai/plugin-sdk'

export const OPENAI_PLUGIN_ID = 'openai' as const

export const OPENAI_CATALOGUE: ExecutorModelCatalogue = loadExecutorModelCatalogue(
  path.join(__dirname, '..', 'models.json'),
)

export const OPENAI_MODELS: ReadonlyArray<ExecutorModelDescriptor> = OPENAI_CATALOGUE.models

export function supportsOpenAiModel(model: string): boolean {
  return supportsFromCatalogue(OPENAI_CATALOGUE, model)
}

export function calculateOpenAiCostUsd(model: string, usage: NormalizedTokenUsage): number {
  return calculateCostFromCatalogue(OPENAI_CATALOGUE, model, usage)
}

export function openAiDefaultAliases(): Record<string, { provider: string; model: string }> {
  return defaultAliasesFromCatalogue(OPENAI_CATALOGUE, OPENAI_PLUGIN_ID)
}

export function openAiDefaultModelForTier(tier: 'planning' | 'coding' | 'mini'): string | undefined {
  return defaultModelFromCatalogue(OPENAI_CATALOGUE, tier)
}
