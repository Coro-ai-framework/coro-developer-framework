import type { DecisionAnswer } from '@coro-ai/cloud-protocol'

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  /** Option key to description. A description may be null. */
  criteria: Record<string, string | null>
}

export interface ScoreQuestion {
  type: 'score'
  instructions: string
  /** 2–10 ordered level descriptions. Index 0 is the first entry. */
  criteria: string[]
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface DecisionAsk {
  /** String, object, or array of strings. Keep it tight — context rot is real. */
  state: unknown
  questions: Record<string, DecisionQuestion>
}

export interface DecisionSuccess {
  available: true
  /** Exact version the provider answered with. Persist this. */
  model: string
  latencyMs: number
  inputTokens: number
  answers: Record<string, DecisionAnswer>
}

export interface DecisionUnavailable {
  available: false
  reason: string
}

export type DecisionResult = DecisionSuccess | DecisionUnavailable

/**
 * The only surface the runner talks to. Implementations MUST NOT throw:
 * every failure resolves to `{ available: false, reason }`, because every
 * call site treats unavailability as "behave exactly as before".
 */
export interface DecisionProvider {
  readonly providerId: string
  ask(req: DecisionAsk): Promise<DecisionResult>
}
