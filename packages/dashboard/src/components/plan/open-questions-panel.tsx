import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronUp, MessageCircleQuestion } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import {
  isAnswered,
  type OpenQuestion,
  type QuestionAnswer,
} from '../../lib/intake-readiness'

const EMPTY_ANSWER: QuestionAnswer = { selected: [], other: '' }

interface OpenQuestionsPanelProps {
  questions: OpenQuestion[]
  answers: Record<string, QuestionAnswer>
  onAnswer: (id: string, answer: QuestionAnswer) => void
  note: string
  onSend: () => void
  disabled?: boolean
}

/**
 * The questions plan mode is blocked on, laid out the way agent harnesses
 * ask: one question at a time, its reasoning beside it, and suggested
 * answers to pick from with room for a different one. Answers are collected
 * here and sent as a single turn, together with anything in the composer.
 */
export default function OpenQuestionsPanel({
  questions,
  answers,
  onAnswer,
  note,
  onSend,
  disabled = false,
}: OpenQuestionsPanelProps) {
  const [active, setActive] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const otherRef = useRef<HTMLTextAreaElement>(null)

  const total = questions.length
  const index = Math.min(active, total - 1)
  const question = questions[index]
  const answer = (question && answers[question.id]) ?? EMPTY_ANSWER
  const answeredCount = questions.filter(q => isAnswered(answers[q.id])).length
  const isLast = index === total - 1

  useEffect(() => {
    const el = otherRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [answer.other, index])

  if (!question) return null

  function goTo(next: number) {
    setActive(Math.max(0, Math.min(total - 1, next)))
  }

  function nextUnanswered(after: number, current: Record<string, QuestionAnswer>): number | null {
    for (let step = 1; step < total; step++) {
      const i = (after + step) % total
      if (!isAnswered(current[questions[i]!.id])) return i
    }
    return null
  }

  function pick(optionIndex: number) {
    if (!question) return
    if (question.multiSelect) {
      const selected = answer.selected.includes(optionIndex)
        ? answer.selected.filter(i => i !== optionIndex)
        : [...answer.selected, optionIndex].sort((a, b) => a - b)
      onAnswer(question.id, { ...answer, selected })
      return
    }
    const next = { selected: [optionIndex], other: '' }
    onAnswer(question.id, next)
    const upcoming = nextUnanswered(index, { ...answers, [question.id]: next })
    if (upcoming !== null) goTo(upcoming)
  }

  function setOther(text: string) {
    if (!question) return
    onAnswer(question.id, {
      selected: question.multiSelect || !text.trim() ? answer.selected : [],
      other: text,
    })
  }

  function advance() {
    if (isLast) onSend()
    else goTo(index + 1)
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (disabled || !question) return
    const target = event.target as HTMLElement
    const typing = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'
    if (typing) return
    const digit = Number.parseInt(event.key, 10)
    if (digit >= 1 && digit <= question.options.length) {
      event.preventDefault()
      pick(digit - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      goTo(index + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goTo(index - 1)
    }
  }

  const heading = total === 1 ? 'Coro needs your input' : `Coro has ${total} questions for you`

  return (
    <section
      aria-label="Open questions"
      onKeyDown={onPanelKeyDown}
      className="mb-3 overflow-hidden rounded-2xl border border-accent-500/35 bg-panel shadow-[0_18px_40px_-28px_rgba(97,114,255,0.6)]"
    >
      <header className="flex items-start gap-3 px-4 pb-2 pt-3.5">
        <MessageCircleQuestion className="mt-0.5 size-[18px] shrink-0 text-accent-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-[14px] font-semibold text-fg">{heading}</h2>
            <span className="text-[12px] text-fg-subtle">
              {answeredCount} of {total} answered
            </span>
          </div>
          {note && !collapsed ? (
            <p className="mt-0.5 text-[12.5px] leading-[1.55] text-fg-muted">{note}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(value => !value)}
          className="rounded-lg p-1 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg-muted"
          aria-label={collapsed ? 'Show questions' : 'Hide questions'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </header>

      {collapsed ? null : (
        <>
          {total > 1 ? (
            <div role="tablist" className="flex flex-wrap gap-1.5 px-4 pb-1">
              {questions.map((q, i) => {
                const done = isAnswered(answers[q.id])
                const selected = i === index
                return (
                  <button
                    key={q.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => goTo(i)}
                    className={cn(
                      'inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors',
                      selected
                        ? 'border-accent-500/50 bg-accent-500/15 text-accent-200'
                        : 'border-line-strong text-fg-muted hover:border-accent-500/30 hover:text-fg',
                    )}
                  >
                    {done ? (
                      <Check className="size-3 shrink-0 text-success-400" aria-label="Answered" />
                    ) : (
                      <span className="text-fg-subtle">{i + 1}</span>
                    )}
                    <span className="truncate">{q.header}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          <div className="max-h-[42vh] overflow-y-auto px-4 pb-3 pt-2">
            <p className="text-[15px] font-medium leading-[1.55] text-fg">{question.question}</p>
            {question.context ? (
              <p className="mt-1.5 text-[13px] leading-[1.6] text-fg-muted">{question.context}</p>
            ) : null}

            {question.options.length > 0 ? (
              <div
                role={question.multiSelect ? 'group' : 'radiogroup'}
                aria-label={question.question}
                className="mt-3 space-y-1.5"
              >
                {question.multiSelect ? (
                  <p className="text-[11.5px] text-fg-subtle">Pick all that apply.</p>
                ) : null}
                {question.options.map((option, i) => {
                  const checked = answer.selected.includes(i)
                  return (
                    <button
                      key={`${question.id}-${i}`}
                      type="button"
                      role={question.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={checked}
                      disabled={disabled}
                      onClick={() => pick(i)}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:opacity-50',
                        checked
                          ? 'border-accent-500/55 bg-accent-500/10'
                          : 'border-line bg-overlay/40 hover:border-line-strong hover:bg-overlay',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex size-5 shrink-0 items-center justify-center border text-[11px] font-semibold',
                          question.multiSelect ? 'rounded-md' : 'rounded-full',
                          checked
                            ? 'border-accent-400 bg-accent-500 text-white'
                            : 'border-line-strong text-fg-subtle',
                        )}
                        aria-hidden
                      >
                        {checked ? <Check className="size-3" /> : i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-[13.5px] font-medium leading-6 text-fg">{option.label}</span>
                          {option.recommended ? (
                            <span className="rounded-full border border-accent-500/30 bg-accent-500/10 px-1.5 py-px text-[10.5px] font-medium text-accent-300">
                              Recommended
                            </span>
                          ) : null}
                        </span>
                        {option.description ? (
                          <span className="block text-[12.5px] leading-[1.55] text-fg-muted">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}

            <textarea
              ref={otherRef}
              rows={question.options.length > 0 ? 1 : 2}
              value={answer.other}
              disabled={disabled}
              onChange={event => setOther(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  advance()
                }
              }}
              placeholder={
                question.options.length > 0 ? 'Something else — type your own answer' : 'Type your answer'
              }
              aria-label={question.options.length > 0 ? 'Other answer' : 'Answer'}
              className={cn(
                'mt-2 w-full resize-none rounded-xl border bg-overlay/40 px-3 py-2.5 text-[13.5px] leading-6 text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:opacity-50',
                answer.other.trim() ? 'border-accent-500/55' : 'border-line',
              )}
            />
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
            <span className="mr-auto text-[11.5px] text-fg-subtle">
              {answeredCount < total
                ? 'Unanswered questions are sent as skipped — Coro will state what it assumed.'
                : 'All answered. Add anything else in the box below.'}
            </span>
            {index > 0 ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => goTo(index - 1)}>
                Back
              </Button>
            ) : null}
            {!isLast ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => goTo(index + 1)}>
                {isAnswered(answer) ? 'Next' : 'Skip'}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant={isLast || answeredCount === total ? 'primary' : 'ghost'}
              disabled={disabled || answeredCount === 0}
              onClick={onSend}
            >
              Send {answeredCount === total ? 'answers' : `${answeredCount} answer${answeredCount === 1 ? '' : 's'}`}
            </Button>
          </footer>
        </>
      )}
    </section>
  )
}
