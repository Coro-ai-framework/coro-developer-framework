// Plan mode reports, on every turn, whether the work is understood well
// enough to run. The composer uses it to decide how much to encourage
// "Generate run" and what to say is still open, so the developer never has
// to guess whether the investigation has landed.

export type ReadinessState = 'investigating' | 'ready' | 'no-run-needed'

export interface Readiness {
  state: ReadinessState
  openQuestions: string[]
  note: string
}

const STATES: ReadinessState[] = ['investigating', 'ready', 'no-run-needed']

export function parseReadiness(assistantMessage: string): Readiness | null {
  const match = assistantMessage.match(/<readiness>\s*([\s\S]*?)\s*<\/readiness>/i)
  if (!match?.[1]) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const obj = parsed as Record<string, unknown>
  const rawState = typeof obj.state === 'string' ? obj.state.trim() : ''
  const state = STATES.find(s => s === rawState)
  if (!state) return null

  const openQuestions = Array.isArray(obj.openQuestions)
    ? obj.openQuestions
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map(q => q.trim())
    : []

  // A model that claims "ready" while still listing unknowns is
  // investigating; trust the list over the label.
  const effective: ReadinessState =
    state === 'ready' && openQuestions.length > 0 ? 'investigating' : state

  return {
    state: effective,
    openQuestions,
    note: typeof obj.note === 'string' ? obj.note.trim() : '',
  }
}
