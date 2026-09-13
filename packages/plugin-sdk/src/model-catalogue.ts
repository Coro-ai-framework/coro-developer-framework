// ── Executor model-catalogue I/O ─────────────────────────────────────────────
//
// Each LLM executor package ships a versioned `models.json` as the
// single source of truth for picker rows, `supports()`, default
// aliases, and optional cost calculation. The runner never reads these
// files — it only consumes {@link PhaseExecutorRuntime.listModels}.

import * as fs from 'node:fs'
import { z } from 'zod'
import {
  MODEL_TIERS,
  defaultModelForTier,
  tierDefaultAliases,
  type ModelTier,
} from './helpers'
import type {
  ExecutorModelCatalogue,
  ExecutorModelDescriptor,
  NormalizedTokenUsage,
} from './types'

const MODEL_TIER_SET = new Set<string>(MODEL_TIERS)

const executorModelDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  contextTokens: z.number().int().positive(),
  tier: z.enum(MODEL_TIERS).optional(),
  isDefault: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  pricing: z.object({
    inputPerMTokens: z.number().optional(),
    outputPerMTokens: z.number().optional(),
    cacheReadPerMTokens: z.number().optional(),
    cacheCreationPerMTokens: z.number().optional(),
  }).optional(),
})

export const executorModelCatalogueSchema = z.object({
  models: z.array(executorModelDescriptorSchema).min(1),
  idPrefixes: z.array(z.string().min(1)).optional(),
  idPatterns: z.array(z.string().min(1)).optional(),
  extraAliases: z.record(z.string(), z.string().min(1)).optional(),
})

export type { ExecutorModelCatalogue }

/**
 * Parse and validate a catalogue object (already-decoded JSON).
 * `source` is included in thrown errors so a bad `models.json` is
 * locatable.
 */
export function parseExecutorModelCatalogue(
  input: unknown,
  source = '<memory>',
): ExecutorModelCatalogue {
  const parsed = executorModelCatalogueSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(
      `Invalid executor model catalogue (${source}): ${parsed.error.message}`,
    )
  }
  const catalogue = parsed.data
  const defaultsByTier = new Map<string, string>()
  for (const model of catalogue.models) {
    if (model.tier && !MODEL_TIER_SET.has(model.tier)) {
      throw new Error(
        `Invalid executor model catalogue (${source}): model "${model.id}" has unknown tier "${model.tier}"`,
      )
    }
    if (model.tier && model.isDefault) {
      const existing = defaultsByTier.get(model.tier)
      if (existing) {
        throw new Error(
          `Invalid executor model catalogue (${source}): tier "${model.tier}" has two isDefault models (${existing} and ${model.id})`,
        )
      }
      defaultsByTier.set(model.tier, model.id)
    }
  }
  for (const pattern of catalogue.idPatterns ?? []) {
    try {
      new RegExp(pattern)
    } catch (err) {
      throw new Error(
        `Invalid executor model catalogue (${source}): idPatterns entry ${JSON.stringify(pattern)} is not a valid regular expression: ${(err as Error).message}`,
      )
    }
  }
  return catalogue
}

/** Read, parse, and validate `models.json` from disk. */
export function loadExecutorModelCatalogue(filePath: string): ExecutorModelCatalogue {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(
      `Could not read executor model catalogue at ${filePath}: ${(err as Error).message}`,
    )
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(
      `Invalid JSON in executor model catalogue (${filePath}): ${(err as Error).message}`,
    )
  }
  return parseExecutorModelCatalogue(decoded, filePath)
}

function findCataloguedModel(
  catalogue: ExecutorModelCatalogue,
  model: string,
): ExecutorModelDescriptor | undefined {
  return catalogue.models.find(m => model === m.id || model.startsWith(`${m.id}-`))
}

/**
 * Cheap `supports()` predicate derived from the catalogue. Matches:
 *   1. An exact catalogued id (or `${id}-…` dated snapshot of one).
 *   2. Any `idPrefixes` entry.
 *   3. Any `idPatterns` regular expression.
 */
export function supportsFromCatalogue(
  catalogue: ExecutorModelCatalogue,
  model: string,
): boolean {
  if (typeof model !== 'string' || model.length === 0) return false
  if (findCataloguedModel(catalogue, model)) return true
  for (const prefix of catalogue.idPrefixes ?? []) {
    if (model.startsWith(prefix)) return true
  }
  for (const pattern of catalogue.idPatterns ?? []) {
    if (new RegExp(pattern).test(model)) return true
  }
  return false
}

/**
 * USD cost from catalogue `pricing` tables. Same formula the OpenAI
 * executor historically used: per-million input / output / cache-read /
 * cache-creation. Returns 0 when the model has no pricing row.
 */
export function calculateCostFromCatalogue(
  catalogue: ExecutorModelCatalogue,
  model: string,
  usage: NormalizedTokenUsage,
): number {
  const pricing = findCataloguedModel(catalogue, model)?.pricing
  if (!pricing) return 0
  const inputCost = usage.inputTokens * ((pricing.inputPerMTokens ?? 0) / 1_000_000)
  const outputCost = usage.outputTokens * ((pricing.outputPerMTokens ?? 0) / 1_000_000)
  const cacheReadCost = usage.cacheReadInputTokens * ((pricing.cacheReadPerMTokens ?? 0) / 1_000_000)
  const cacheCreationCost = usage.cacheCreationInputTokens
    * ((pricing.cacheCreationPerMTokens ?? pricing.inputPerMTokens ?? 0) / 1_000_000)
  return inputCost + outputCost + cacheReadCost + cacheCreationCost
}

/**
 * Canonical `tier:*` aliases plus any `extraAliases` declared in JSON.
 * Extra alias values that start with `tier:` copy that already-derived
 * entry (used to remap `mini` onto `coding` when a provider has no
 * mini-class model).
 */
export function defaultAliasesFromCatalogue(
  catalogue: ExecutorModelCatalogue,
  provider: string,
): Record<string, { provider: string; model: string }> {
  const out = { ...tierDefaultAliases(catalogue.models, provider) }
  for (const [key, target] of Object.entries(catalogue.extraAliases ?? {})) {
    if (target.startsWith('tier:')) {
      const copied = out[target]
      if (copied) out[key] = copied
      continue
    }
    out[key] = { provider, model: target }
  }
  return out
}

/** Convenience: default model id for a tier from a full catalogue object. */
export function defaultModelFromCatalogue(
  catalogue: ExecutorModelCatalogue,
  tier: ModelTier,
): string | undefined {
  return defaultModelForTier(catalogue.models, tier)
}
