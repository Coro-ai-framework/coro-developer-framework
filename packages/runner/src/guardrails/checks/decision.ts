import type { GuardrailCheckFn } from '../types'
import type { DecisionProvider } from '../../clients/decision/types'

export interface DecisionGuardrailConfig {
  matchesNoul?: number
  secretsNoul?: number
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Optional structured-decision check. Fail-open: any throw, timeout, or
 * unavailable provider allows the action. There is no default rule that
 * uses this check — an operator has to add one.
 */
export function createDecisionCheck(decision?: DecisionProvider): GuardrailCheckFn {
  return async (rule, ctx) => {
    try {
      if (!decision) return { allow: true }
      const cfg = (rule.config ?? {}) as DecisionGuardrailConfig
      const matchesNoul = numberOr(cfg.matchesNoul, 0.5)
      const secretsNoul = numberOr(cfg.secretsNoul, 0.75)

      const description = typeof ctx.toolInput.description === 'string'
        ? ctx.toolInput.description
        : typeof ctx.toolInput.body === 'string'
          ? ctx.toolInput.body
          : ''
      const repoDir = ctx.repoDir
      let diff = { lines: 0, files: 0 }
      if (repoDir) {
        try {
          diff = await ctx.helpers.gitDiff({ repoDir })
        } catch {
          // Judge the description without a diff rather than skipping the check.
        }
      }

      const result = await decision.ask({
        state: {
          description,
          diffLines: diff.lines,
          diffFiles: diff.files,
          toolName: ctx.toolName ?? '',
        },
        questions: {
          matches: {
            type: 'noul',
            instructions: 'The proposed PR description matches the staged change in spirit.',
            criteria: {
              true: 'The description matches the change.',
              false: 'The description does not match the change.',
            },
          },
          secrets: {
            type: 'noul',
            instructions: 'The staged change appears to contain a credential or secret.',
            criteria: {
              true: 'A credential or secret looks present.',
              false: 'No credential or secret is apparent.',
            },
          },
        },
      })
      if (!result.available) return { allow: true }

      const matches = result.answers['matches']
      const secrets = result.answers['secrets']
      if (secrets?.type === 'noul' && secrets.noul >= secretsNoul) {
        return {
          allow: false,
          reason:
            `Decision check: the change looks like it may contain a secret `
            + `(probability ${secrets.noul.toFixed(2)}).`,
        }
      }
      if (matches?.type === 'noul' && matches.noul < matchesNoul) {
        return {
          allow: false,
          reason:
            `Decision check: the PR description does not look like it matches the change `
            + `(match probability ${matches.noul.toFixed(2)}).`,
        }
      }
      return { allow: true }
    } catch {
      return { allow: true }
    }
  }
}
