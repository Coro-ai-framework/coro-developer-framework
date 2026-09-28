import * as path from 'node:path'
import {
  calculateCostFromCatalogue,
  defaultAliasesFromCatalogue,
  loadExecutorModelCatalogue,
  supportsFromCatalogue,
  type ExecutorModelCatalogue,
  type ExecutorModelDescriptor,
  type NormalizedTokenUsage,
} from '@coro-ai/plugin-sdk'

export const ANTHROPIC_PLUGIN_ID = 'anthropic' as const

export const ANTHROPIC_CATALOGUE: ExecutorModelCatalogue = loadExecutorModelCatalogue(
  path.join(__dirname, '..', 'models.json'),
)

export const ANTHROPIC_MODELS: ReadonlyArray<ExecutorModelDescriptor> = ANTHROPIC_CATALOGUE.models

export function supportsAnthropicModel(model: string): boolean {
  return supportsFromCatalogue(ANTHROPIC_CATALOGUE, model)
}

export function calculateAnthropicCostUsd(model: string, usage: NormalizedTokenUsage): number {
  return calculateCostFromCatalogue(ANTHROPIC_CATALOGUE, model, usage)
}

export function anthropicDefaultAliases(): Record<string, { provider: string; model: string }> {
  return defaultAliasesFromCatalogue(ANTHROPIC_CATALOGUE, ANTHROPIC_PLUGIN_ID)
}
