import fs from 'node:fs'
import type {
  EffectiveGuardrailRule,
  GuardrailRuleSpec,
  GuardrailRuleOverride,
  GuardrailsConfigOverride,
  GuardrailsFile,
  GuardrailRuleSource,
} from './types'
import { getBundledGuardrailsDefaultsPath } from './bundled-path'
import { defaultGuardrailsScriptsDir } from '../config/local-config'
import { scriptFileExists } from './checks/script'

export function loadBundledGuardrailsFile(): GuardrailsFile {
  const raw = fs.readFileSync(getBundledGuardrailsDefaultsPath(), 'utf-8')
  const parsed = JSON.parse(raw) as GuardrailsFile
  if (!Array.isArray(parsed.rules)) {
    throw new Error('Bundled guardrails.defaults.json must contain a rules array')
  }
  return parsed
}

function rowToOverrideShape(rule: GuardrailRuleSpec): GuardrailRuleOverride {
  return rule
}

function ruleSource(id: string, bundledIds: Set<string>, override: GuardrailRuleOverride): GuardrailRuleSource {
  if (!bundledIds.has(id)) return 'custom'
  const keys = Object.keys(override).filter(k => k !== 'id')
  if (keys.length === 0) return 'bundled'
  return 'override'
}

function enrichRule(
  rule: GuardrailRuleSpec,
  source: GuardrailRuleSource,
  scriptsDir: string,
): EffectiveGuardrailRule {
  const effective: EffectiveGuardrailRule = {
    ...rule,
    enabled: rule.enabled !== false,
    source,
  }
  if (rule.check === 'script' && rule.script) {
    effective.scriptFileExists = scriptFileExists(scriptsDir, rule.script)
  }
  return effective
}

/**
 * Merge shipped defaults with user overrides from `~/.coro/config.json`.
 * Overrides replace same-id bundled rows; unknown ids are custom rules.
 */
export function resolveGuardrails(override?: GuardrailsConfigOverride | null): {
  bundled: GuardrailsFile
  resolved: { enabled: boolean; rules: EffectiveGuardrailRule[]; scriptsDir: string }
} {
  const bundled = loadBundledGuardrailsFile()
  const scriptsDir = defaultGuardrailsScriptsDir()
  const globalEnabled = override?.enabled !== undefined
    ? override.enabled
    : bundled.enabled !== false

  const bundledById = new Map<string, GuardrailRuleSpec>(bundled.rules.map(r => [r.id, r]))
  const bundledIds = new Set(bundledById.keys())

  for (const row of override?.rules ?? []) {
    if (!row.id) continue
    const base = bundledById.get(row.id)
    if (base) {
      bundledById.set(row.id, { ...base, ...row, id: row.id })
    } else if (row.on && row.check) {
      bundledById.set(row.id, row as GuardrailRuleSpec)
    }
  }

  const rules: EffectiveGuardrailRule[] = []
  for (const rule of bundledById.values()) {
    const source = ruleSource(rule.id, bundledIds, rowToOverrideShape(rule))
    rules.push(enrichRule(rule, source, scriptsDir))
  }

  return {
    bundled,
    resolved: {
      enabled: globalEnabled,
      rules,
      scriptsDir,
    },
  }
}

/** Overrides-only slice suitable for persisting to config.json. */
export function diffOverridesFromBundled(
  effective: EffectiveGuardrailRule[],
  bundled: GuardrailsFile,
): GuardrailRuleSpec[] {
  const bundledById = new Map(bundled.rules.map(r => [r.id, r]))
  const overrides: GuardrailRuleSpec[] = []

  for (const rule of effective) {
    const base = bundledById.get(rule.id)
    if (!base) {
      overrides.push(pickPersistedRule(rule))
      continue
    }
    const changed =
      rule.enabled !== (base.enabled !== false)
      || JSON.stringify(rule.config ?? {}) !== JSON.stringify(base.config ?? {})
      || JSON.stringify(rule.during ?? null) !== JSON.stringify(base.during ?? null)
      || rule.check !== base.check
      || rule.on !== base.on
      || rule.script !== base.script
    if (changed) overrides.push(pickPersistedRule(rule, base))
  }
  return overrides
}

function pickPersistedRule(
  rule: EffectiveGuardrailRule,
  base?: GuardrailRuleSpec,
): GuardrailRuleSpec {
  const row: GuardrailRuleSpec = { id: rule.id, on: rule.on, check: rule.check }
  if (rule.enabled !== (base?.enabled !== false)) row.enabled = rule.enabled
  if (rule.config && JSON.stringify(rule.config) !== JSON.stringify(base?.config ?? {})) {
    row.config = rule.config
  }
  if (rule.during && JSON.stringify(rule.during) !== JSON.stringify(base?.during ?? null)) {
    row.during = rule.during
  }
  if (rule.script) row.script = rule.script
  if (rule.title && rule.title !== base?.title) row.title = rule.title
  if (rule.description && rule.description !== base?.description) row.description = rule.description
  return row
}
