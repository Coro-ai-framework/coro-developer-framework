import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GuardrailScript } from '@coro-ai/plugin-sdk'
import type { GuardrailCheckFn } from '../types'

const SCRIPT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

export function guardrailsScriptPath(scriptsDir: string, basename: string): string {
  if (!SCRIPT_NAME_RE.test(basename)) {
    throw new Error(`Invalid guardrail script name: ${basename}`)
  }
  const resolvedDir = path.resolve(scriptsDir)
  const file = path.resolve(resolvedDir, `${basename}.mjs`)
  if (!file.startsWith(resolvedDir + path.sep) && file !== resolvedDir) {
    throw new Error(`Guardrail script path escapes scripts directory: ${basename}`)
  }
  return file
}

export function scriptFileExists(scriptsDir: string, basename: string): boolean {
  try {
    const file = guardrailsScriptPath(scriptsDir, basename)
    return fs.existsSync(file)
  } catch {
    return false
  }
}

export function createScriptCheck(scriptsDir: string): GuardrailCheckFn {
  return async (rule, ctx) => {
    const name = rule.script
    if (!name || typeof name !== 'string') {
      return {
        allow: false,
        reason: `Guardrail "${rule.id}" uses check "script" but has no "script" basename configured.`,
      }
    }

    let file: string
    try {
      file = guardrailsScriptPath(scriptsDir, name)
    } catch (err) {
      return { allow: false, reason: (err as Error).message }
    }

    if (!fs.existsSync(file)) {
      return {
        allow: false,
        reason:
          `Guardrail script not found: ${file}. Create ${name}.mjs under ${scriptsDir} ` +
          `with a default export async function (ctx) => ({ allow: true }).`,
      }
    }

    let mod: { default?: GuardrailScript }
    try {
      mod = await import(pathToFileURL(file).href) as { default?: GuardrailScript }
    } catch (err) {
      return {
        allow: false,
        reason: `Failed to load guardrail script "${name}": ${(err as Error).message}`,
      }
    }

    if (typeof mod.default !== 'function') {
      return {
        allow: false,
        reason: `Guardrail script "${name}" must default-export an async function.`,
      }
    }

    const decision = await mod.default(ctx)
    if (!decision || typeof decision.allow !== 'boolean') {
      return { allow: false, reason: `Guardrail script "${name}" returned an invalid decision.` }
    }
    if (!decision.allow && (!decision.reason || decision.reason.trim().length === 0)) {
      return { allow: false, reason: `Guardrail script "${name}" blocked the action without a reason.` }
    }
    return decision
  }
}
