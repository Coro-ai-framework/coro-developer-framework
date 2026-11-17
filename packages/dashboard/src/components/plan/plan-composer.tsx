import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check } from 'lucide-react'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { findModel } from '../llm/pricing'
import type { ProviderOption } from '../llm/ModelPicker'
import { useExecutorPlugins } from '../llm/useExecutorPlugins'
import { useProviderModels, type ProviderModelDescriptor } from '../llm/useProviderModels'
import { cn } from '../../lib/utils'
import { CONVERSATION_COPY } from '../../lib/run-labels'
import { getReadinessMeta, toneDotClasses } from '../../lib/status'
import {
  composeAnswerMessage,
  isAnswered,
  readinessQuestions,
  type QuestionAnswer,
  type Readiness,
} from '../../lib/intake-readiness'
import { usePlanSession } from '../../providers/plan-session'
import GenerateRunButton, { conversationHasRun } from './generate-run-button'
import { conversationHasLiveRun } from '../../lib/linked-run'
import OpenQuestionsPanel from './open-questions-panel'
import ToolAccessMenu from './tool-access-menu'

function PlanModeModelSelect({
  value,
  onChange,
  providers,
  modelsByProvider,
  loadModels,
  disabled = false,
}: {
  value: { provider: string; model: string }
  onChange: (next: { provider: string; model: string }) => void
  providers: ProviderOption[]
  modelsByProvider: Record<string, ProviderModelDescriptor[] | null | undefined>
  loadModels: (providerId: string) => Promise<void>
  disabled?: boolean
}) {
  const providerKey = providers.map(p => p.id).join('|')
  useEffect(() => {
    for (const p of providers) void loadModels(p.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey])

  const label = useMemo(() => {
    if (!value.model) return 'Planning tier default'
    const descriptor = findModel(modelsByProvider, value.provider, value.model)
    return descriptor?.displayName ?? value.model
  }, [value, modelsByProvider])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="text-[11px] text-fg-subtle transition-colors hover:text-fg-muted disabled:opacity-50"
        >
          Model: <span className="font-mono text-fg-muted">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-72 overflow-y-auto">
        {providers.map((p, index) => {
          const models = modelsByProvider[p.id]
          if (!models?.length) return null
          return (
            <div key={p.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{p.displayName}</DropdownMenuLabel>
              {models.map(m => {
                const selected = value.provider === p.id && value.model === m.id
                return (
                  <DropdownMenuItem
                    key={`${p.id}:${m.id}`}
                    onClick={() => onChange({ provider: p.id, model: m.id })}
                  >
                    <span className={cn(selected && 'text-accent-300')}>{m.displayName}</span>
                    {selected ? <Check className="ml-auto size-3.5 text-accent-300" /> : null}
                  </DropdownMenuItem>
                )
              })}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
}

/**
 * Plan-mode sessions are uncapped, so the model's context window is the only
 * real ceiling on how long an investigation can run. Showing how much of it
 * is spent is information, not a limit — there is no enforcement behind it.
 */
function ContextMeter({ used, window }: { used: number; window?: number }) {
  if (used <= 0) return null
  if (!window) {
    return <span className="text-[11px] text-fg-subtle">{formatTokens(used)} context</span>
  }
  const ratio = (used / window) * 100
  const pct = Math.min(100, Math.round(ratio))
  // A 1M-token window makes a real investigation read as "0%" for a long
  // time; say "<1%" rather than claim the context is empty.
  const label = ratio > 0 && pct === 0 ? '<1%' : `${pct}%`
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-fg-subtle"
      title={`${used.toLocaleString()} of ${window.toLocaleString()} context tokens used`}
    >
      <span className="h-1 w-10 overflow-hidden rounded-full bg-line">
        <span
          className={cn(
            'block h-full rounded-full transition-all',
            pct >= 85 ? 'bg-warning-400' : 'bg-accent-500/70',
          )}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </span>
      {label} context
    </span>
  )
}

function ReadinessStrip({ readiness }: { readiness: Readiness }) {
  const meta = getReadinessMeta(readiness.state)
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-[1.5]">
      <span className="flex items-center gap-1.5 font-medium text-fg-muted">
        <span className={cn('size-1.5 rounded-full', toneDotClasses(meta.tone))} />
        {meta.label}
      </span>
      {readiness.note ? <span className="text-fg-subtle">{readiness.note}</span> : null}
    </div>
  )
}

export default function PlanComposer({ blocked = false }: { blocked?: boolean }) {
  const session = usePlanSession()
  const [input, setInput] = useState('')
  const { providers } = useExecutorPlugins()
  const { modelsByProvider, loadModels } = useProviderModels()
  const disabled = blocked || session.busy || session.noLlm

  const contextWindow = useMemo(
    () =>
      findModel(modelsByProvider, session.modelChoice.provider, session.modelChoice.model)?.contextTokens
      ?? session.contextWindow,
    [modelsByProvider, session.modelChoice, session.contextWindow],
  )

  const questions = useMemo(() => readinessQuestions(session.readiness), [session.readiness])
  const showQuestions = session.hasProgress && !session.busy && questions.length > 0
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  const questionsKey = questions.map(q => q.question).join('\n')
  useEffect(() => setAnswers({}), [questionsKey])

  const liveRun = useMemo(() => conversationHasLiveRun(session.items, session.jobs), [session.items, session.jobs])
  const hasAnswers = showQuestions && questions.some(q => isAnswered(answers[q.id]))
  const canSend = !disabled && (input.trim().length > 0 || hasAnswers)

  // The textarea clears optimistically so the next question can be typed
  // straight away, but `send` refuses a turn while one is in flight — and the
  // disabled state trails the ref by a render, so a fast second Enter can get
  // that far. Put the text back rather than swallowing it.
  const dispatchTurn = useCallback((opts?: { generateRun?: boolean }) => {
    const text = input
    const message = showQuestions ? composeAnswerMessage(questions, answers, text) : text
    setInput('')
    void session.send(message, opts).then(accepted => {
      if (!accepted) setInput(prev => (prev ? prev : text))
      else setAnswers({})
    })
  }, [input, session, showQuestions, questions, answers])

  const submit = useCallback(() => {
    if (canSend) dispatchTurn()
  }, [canSend, dispatchTurn])

  const generateRun = useCallback(() => dispatchTurn({ generateRun: true }), [dispatchTurn])

  return (
    <div className="shrink-0 pb-1 pt-3">
      {showQuestions ? (
        <OpenQuestionsPanel
          questions={questions}
          answers={answers}
          onAnswer={(id, answer) => setAnswers(prev => ({ ...prev, [id]: answer }))}
          note={session.readiness?.note ?? ''}
          onSend={submit}
          disabled={disabled}
        />
      ) : session.readiness && session.hasProgress ? (
        <ReadinessStrip readiness={session.readiness} />
      ) : null}
      <form
        onSubmit={e => {
          e.preventDefault()
          submit()
        }}
        className="flex items-end gap-2"
      >
        <AutoGrowTextarea
          value={input}
          onChange={setInput}
          onSubmit={submit}
          canSubmit={canSend}
          placeholder={
            showQuestions
              ? 'Add context, or dig further…'
              : liveRun
                ? 'Ask about the run, or tell Coro how to steer it…'
                : session.hasProgress
                  ? 'Answer, or dig further…'
                  : 'Describe what you want Coro to do…'
          }
          disabled={disabled}
          autoFocus={!session.hasProgress}
        />
        <Button type="submit" size="icon" disabled={!canSend} aria-label="Send">
          <ArrowUp />
        </Button>
      </form>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <div className="flex items-center gap-3">
          <PlanModeModelSelect
            value={session.modelChoice}
            onChange={session.setModelChoice}
            providers={providers}
            modelsByProvider={modelsByProvider}
            loadModels={loadModels}
            disabled={session.busy}
          />
          <ToolAccessMenu />
        </div>
        <div className="flex items-center gap-2.5">
          <ContextMeter used={session.contextUsed} window={contextWindow} />
          <span className="hidden text-[11px] text-fg-subtle @lg/conversation:inline">
            {session.turnCount} turns · {session.totalTokens.toLocaleString()} tokens
          </span>
          {session.busy && session.canStop ? (
            <button
              type="button"
              onClick={session.cancel}
              title={CONVERSATION_COPY.stopHint}
              className="text-[11px] text-fg-subtle transition-colors hover:text-fg-muted"
            >
              Stop
            </button>
          ) : null}
          {session.busy && !session.canStop ? (
            <span className="text-[11px] text-fg-subtle">{CONVERSATION_COPY.stillInvestigating}</span>
          ) : null}
          <GenerateRunButton
            readiness={session.readiness}
            disabled={disabled}
            generated={conversationHasRun(session.items)}
            onClick={generateRun}
          />
        </div>
      </div>
    </div>
  )
}

interface AutoGrowTextareaProps {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  canSubmit: boolean
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
}

function AutoGrowTextarea({
  value,
  onChange,
  onSubmit,
  canSubmit,
  placeholder,
  disabled,
  autoFocus,
}: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const maxHeight = 10 * 24 + 24
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      autoFocus={autoFocus}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          if (canSubmit) onSubmit()
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      className="flex-1 resize-none rounded-2xl border border-line-strong bg-overlay px-4 py-3 text-[13.5px] leading-6 text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:cursor-not-allowed disabled:opacity-50"
    />
  )
}
