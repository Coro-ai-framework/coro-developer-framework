import type { ChoiceQuestion, DecisionQuestion, NoulQuestion, ScoreQuestion } from '../clients/decision/types'

export const DEFAULT_PHASE_OBLIGATIONS: readonly string[] = [
  'The phase produced the output its workflow contract requires.',
  'The work still serves the stated objective of this job.',
  'The phase made progress rather than repeating work an earlier run already did.',
  'Failures the phase hit were surfaced, not silently worked around.',
]

export const NONE_OPTION = 'none'

export function buildOverseerQuestions(
  obligations: readonly string[],
): Record<string, DecisionQuestion> {
  const criteria: Record<string, string | null> = {
    [NONE_OPTION]: 'Every obligation above was met.',
  }
  for (let i = 0; i < obligations.length; i++) {
    criteria[`obligation[${i}]`] = null
  }

  const breach: ChoiceQuestion = {
    type: 'choice',
    instructions: 'Which of `phase_obligations` did this phase fail to meet? Pick `none` if every obligation was met.',
    criteria,
  }
  const offTrack: NoulQuestion = {
    type: 'noul',
    instructions: 'The work described still serves the stated objective.',
    criteria: {
      true: 'The trajectory still serves the stated objective.',
      false: 'The work has drifted away from the stated objective.',
    },
  }
  const severity: ScoreQuestion = {
    type: 'score',
    instructions: 'How serious is any problem with this phase of the run?',
    criteria: [
      'Cosmetic — no action needed.',
      'Worth a look but the run should continue.',
      'A developer should review this before more work is done.',
      'The run should stop.',
    ],
  }
  const blocked: NoulQuestion = {
    type: 'noul',
    instructions: 'The agent appears to be waiting on something it cannot resolve itself.',
    criteria: {
      true: 'The agent is blocked on something it cannot resolve itself.',
      false: 'The agent can continue without outside help.',
    },
  }

  return {
    breach,
    off_track: offTrack,
    severity,
    blocked,
  }
}
