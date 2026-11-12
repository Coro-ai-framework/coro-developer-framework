// Plan mode reports, on every turn, whether the work is understood well
// enough to run. The composer uses it to decide how much to encourage
// "Generate run" and to put the questions still open in front of the
// developer, so they never have to guess what the investigation is waiting on.

export type ReadinessState = 'investigating' | 'ready' | 'no-run-needed'

export interface OpenQuestionOption {
  label: string
  description: string
  recommended: boolean
}

export interface OpenQuestion {
  id: string
  /** Short chip label; falls back to a numbered label when the model omits it. */
  header: string
  question: string
  /** Why it matters / what the investigation found that leaves it open. */
  context: string
  options: OpenQuestionOption[]
  multiSelect: boolean
}

export interface Readiness {
  state: ReadinessState
  /** Plain question text — what the runner, persistence, and dispatch hand-off read. */
  openQuestions: string[]
  /** Absent on readiness persisted before questions were structured. */
  questions?: OpenQuestion[]
  note: string
}

const STATES: ReadinessState[] = ['investigating', 'ready', 'no-run-needed']
const MAX_OPTIONS = 6

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseOption(raw: unknown): OpenQuestionOption | null {
  if (typeof raw === 'string') {
    const label = raw.trim()
    return label ? { label, description: '', recommended: false } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const label = str(obj.label)
  if (!label) return null
  return { label, description: str(obj.description), recommended: obj.recommended === true }
}

function parseQuestion(raw: unknown, index: number): OpenQuestion | null {
  const fallbackHeader = `Question ${index + 1}`
  if (typeof raw === 'string') {
    const question = raw.trim()
    if (!question) return null
    return { id: `q${index}`, header: fallbackHeader, question, context: '', options: [], multiSelect: false }
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const question = str(obj.question)
  if (!question) return null
  const options = Array.isArray(obj.options)
    ? obj.options.map(parseOption).filter((o): o is OpenQuestionOption => o !== null).slice(0, MAX_OPTIONS)
    : []
  return {
    id: `q${index}`,
    header: str(obj.header) || fallbackHeader,
    question,
    context: str(obj.context),
    options,
    multiSelect: obj.multiSelect === true && options.length > 1,
  }
}

function parseQuestions(raw: unknown): OpenQuestion[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(q => (typeof q === 'string' ? q.trim() : str((q as Record<string, unknown> | null)?.question)))
    .map(parseQuestion)
    .filter((q): q is OpenQuestion => q !== null)
}

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

  const questions = parseQuestions(obj.openQuestions)

  // A model that claims "ready" while still listing unknowns is
  // investigating; trust the list over the label.
  const effective: ReadinessState =
    state === 'ready' && questions.length > 0 ? 'investigating' : state

  return {
    state: effective,
    openQuestions: questions.map(q => q.question),
    questions,
    note: str(obj.note),
  }
}

/** Structured questions, or plain-text ones for readiness saved before they existed. */
export function readinessQuestions(readiness: Readiness | null | undefined): OpenQuestion[] {
  if (!readiness) return []
  if (readiness.questions?.length) return readiness.questions
  return parseQuestions(readiness.openQuestions)
}

export interface QuestionAnswer {
  /** Indexes into `OpenQuestion.options`. */
  selected: number[]
  /** Free-text answer: the "Other" choice, or the whole answer when there are no options. */
  other: string
}

export function isAnswered(answer: QuestionAnswer | undefined): boolean {
  return !!answer && (answer.selected.length > 0 || answer.other.trim().length > 0)
}

function answerText(question: OpenQuestion, answer: QuestionAnswer): string {
  const picked = answer.selected
    .map(i => question.options[i]?.label)
    .filter((label): label is string => !!label)
  const other = answer.other.trim()
  return [...picked, ...(other ? [other] : [])].join('; ')
}

/**
 * The developer's reply, written so the transcript still reads on its own:
 * each answer sits under the question it answers, and a question left blank
 * is said to be skipped rather than silently dropped.
 */
export function composeAnswerMessage(
  questions: OpenQuestion[],
  answers: Record<string, QuestionAnswer>,
  extra = '',
): string {
  const notes = extra.trim()
  if (!questions.some(q => isAnswered(answers[q.id]))) return notes

  const lines = questions.map((q, i) => {
    const answer = answers[q.id]
    const reply = answer && isAnswered(answer)
      ? answerText(q, answer)
      : 'Skipped — use your judgement and say what you assumed.'
    return `${i + 1}. ${q.question}\n   → ${reply}`
  })
  const body = `Answers to your open questions:\n\n${lines.join('\n\n')}`
  return notes ? `${body}\n\n${notes}` : body
}
