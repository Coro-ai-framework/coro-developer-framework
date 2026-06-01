import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Loader2, Send, Sparkles } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import Field from './forms/field'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { findModel } from './llm/pricing'
import type { ProviderOption } from './llm/ModelPicker'
import { useExecutorPlugins } from './llm/useExecutorPlugins'
import { useProviderModels, type ProviderModelDescriptor } from './llm/useProviderModels'
import { jsonRequest, requestJson, ApiError } from '../lib/http'
import { parseBrief, parseReviewersList, type BriefDraft } from '../lib/intake-brief'
import { deriveRunHistoryHints, findSimilarRuns } from '../lib/run-history'
import { useIntakeStream, type IntakeChatMessage, type IntakeToolCall } from '../hooks/useIntakeStream'
import type { ConfigResponse } from '../pages/Settings/SettingsContext'
import type { Job } from '../types'
import type { WorkflowOption } from '../workflows'
import { cn } from '../lib/utils'

const MAX_TURNS_WITHOUT_BRIEF = 8
const GREETING =
  "Hi — tell me what you'd like Coro to work on. I'll ask a few questions if needed, then propose a run brief you can edit before dispatching."

interface IntakeChatProps {
  workflows: WorkflowOption[]
  jobs: Job[]
  onUseForm: () => void
  onNoLlm: () => void
}

export default function IntakeChat({ workflows, jobs, onUseForm, onNoLlm }: IntakeChatProps) {
  const navigate = useNavigate()
  const [messages, setMessages] = useState<IntakeChatMessage[]>([
    { role: 'assistant', content: GREETING },
  ])
  const [input, setInput] = useState('')
  const [partial, setPartial] = useState('')
  const [liveToolCalls, setLiveToolCalls] = useState<IntakeToolCall[]>([])
  const [brief, setBrief] = useState<BriefDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [modelChoice, setModelChoice] = useState({ provider: '', model: '' })
  const listRef = useRef<HTMLDivElement>(null)
  const userTurns = useMemo(() => messages.filter(m => m.role === 'user').length, [messages])

  const { providers } = useExecutorPlugins()
  const { modelsByProvider, loadModels } = useProviderModels()

  useEffect(() => {
    void requestJson<ConfigResponse>('/config').then(data => {
      const tier =
        data.config?.llm?.aliases?.['tier:planning'] ?? data.config?.llm?.aliases?.['planning']
      if (!tier?.model) return
      setModelChoice(prev => (prev.model ? prev : { provider: tier.provider ?? '', model: tier.model }))
    })
  }, [])

  const history = useMemo(() => deriveRunHistoryHints(jobs), [jobs])
  const similar = useMemo(
    () => findSimilarRuns(jobs, input || messages.filter(m => m.role === 'user').map(m => m.content).join(' '), brief?.repo),
    [jobs, input, messages, brief?.repo],
  )

  const { streaming, error, noLlm, turnCount, totalTokens, send, cancel } = useIntakeStream()

  useEffect(() => {
    if (noLlm) onNoLlm()
  }, [noLlm, onNoLlm])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, partial])

  const workflowPaths = useMemo(() => workflows.map(w => w.workflowPath), [workflows])

  const sendMessage = useCallback(
    async (text: string, forceBrief = false) => {
      const trimmed = text.trim()
      if (!trimmed && !forceBrief) return

      const nextMessages: IntakeChatMessage[] = [
        ...messages,
        ...(trimmed ? [{ role: 'user' as const, content: trimmed }] : []),
      ]
      if (forceBrief && trimmed) {
        nextMessages.push({
          role: 'user',
          content: 'Please emit your best <brief> now with what we have so far.',
        })
      }

      setMessages(nextMessages)
      setInput('')
      setPartial('')
      setLiveToolCalls([])
      setBrief(null)

      const result = await send(
        nextMessages,
        {
          recentRepos: history.recentRepos,
          recentReviewers: history.recentReviewers,
          availableWorkflows: workflows,
          userLocale: navigator.language,
        },
        token => setPartial(prev => prev + token),
        modelChoice.model ? modelChoice : undefined,
        setLiveToolCalls,
      )

      if (result.noLlm) return

      const assistantText = (result.assistantText || partial).trim()
      if (assistantText || result.toolCalls.length > 0) {
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: assistantText,
            ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
          },
        ])
      }
      setPartial('')
      setLiveToolCalls([])

      const parsed = parseBrief(assistantText, workflowPaths)
      if (parsed) {
        setBrief(parsed)
      } else if (userTurns + 1 >= MAX_TURNS_WITHOUT_BRIEF) {
        setSubmitError('We could not get to a clean brief. Try the form with your description prefilled.')
      }
    },
    [messages, send, history, workflows, workflowPaths, partial, userTurns, modelChoice],
  )

  async function dispatchBrief() {
    if (!brief) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const body = {
        type: 'job',
        workflowPath: brief.workflowPath,
        repo: brief.repo.trim(),
        serviceName: brief.serviceName.trim(),
        description: brief.description.trim(),
        reviewers: parseReviewersList(brief.reviewers),
        interactive: brief.interactive,
      }
      const data = await requestJson<{ jobId: string }>('/jobs', jsonRequest(body, { method: 'POST' }))
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-h-[480px] flex-col rounded-2xl border border-line bg-overlay/30">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <Sparkles className="size-4 text-accent-300" />
            Coro plan mode
          </div>
          <div className="flex items-center gap-3 text-[11px] text-fg-subtle">
            <span>{turnCount} turns · {totalTokens.toLocaleString()} tokens</span>
            <button type="button" className="text-accent-300 hover:underline" onClick={onUseForm}>
              Use the form instead
            </button>
          </div>
        </div>

        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.map((m, i) => (
            <div key={i} className="space-y-1">
              {m.content ? <ChatBubble role={m.role} content={m.content} /> : null}
              {m.toolCalls?.length ? (
                <ToolUseRows calls={m.toolCalls} collapsed={!streaming} />
              ) : null}
            </div>
          ))}
          {partial || liveToolCalls.length > 0 ? (
            <div className="space-y-1">
              {partial ? <ChatBubble role="assistant" content={partial} streaming={streaming} /> : null}
              {liveToolCalls.length > 0 ? (
                <ToolUseRows calls={liveToolCalls} collapsed={false} />
              ) : null}
            </div>
          ) : null}
          {streaming && !partial && liveToolCalls.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-fg-subtle">
              <Loader2 className="size-3 animate-spin" />
              Thinking…
            </div>
          ) : null}
          {error ? (
            <div className="rounded-xl border border-danger-500/30 bg-danger-500/10 p-3 text-sm text-danger-200">
              {error}
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => void sendMessage(input)}>
                  Retry
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={onUseForm}>
                  Use the form
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-line p-4">
          <form
            onSubmit={e => {
              e.preventDefault()
              void sendMessage(input)
            }}
            className="flex items-end gap-2"
          >
            <AutoGrowTextarea
              value={input}
              onChange={setInput}
              onSubmit={() => void sendMessage(input)}
              placeholder="Describe what you want Coro to do… (Shift+Enter for a new line)"
              disabled={streaming}
            />
            <Button type="submit" disabled={streaming || !input.trim()}>
              <Send />
            </Button>
          </form>
          <div className="mt-2 flex items-center justify-between gap-2">
            <PlanModeModelSelect
              value={modelChoice}
              onChange={setModelChoice}
              providers={providers}
              modelsByProvider={modelsByProvider}
              loadModels={loadModels}
              disabled={streaming}
            />
            <div className="flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={streaming}
                onClick={() => void sendMessage(input, true)}
              >
                Force brief now
              </Button>
              {streaming ? (
                <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                  Stop
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        {similar.length > 0 ? (
          <div className="rounded-2xl border border-line bg-overlay/30 p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Similar past runs
            </div>
            <ul className="mt-2 space-y-2">
              {similar.map(job => (
                <li key={job.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-line bg-overlay/40 px-3 py-2 text-left text-xs hover:border-line-strong"
                    onClick={() => navigate(`/jobs/${job.id}`)}
                  >
                    <div className="font-medium text-fg">
                      {typeof job.params?.serviceName === 'string' ? job.params.serviceName : job.id}
                    </div>
                    <div className="text-fg-muted">{job.status}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {brief ? (
          <BriefEditor
            brief={brief}
            workflows={workflows}
            onChange={setBrief}
            onSubmit={() => void dispatchBrief()}
            submitting={submitting}
            error={submitError}
          />
        ) : (
          <div className="rounded-2xl border border-dashed border-line bg-overlay/20 p-5 text-sm text-fg-muted">
            Your brief will appear here once we have the basics.
          </div>
        )}
      </div>
    </div>
  )
}

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
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
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

/**
 * Hide the raw <brief>…</brief> payload from chat — the structured
 * version already lives in the sidebar editor. If the model wrapped
 * the entire turn in <brief>, replace with a friendly hand-off line;
 * if it included prose alongside the brief, keep the prose and drop
 * only the tagged block.
 */
const BRIEF_TAG_REGEX = /<brief>[\s\S]*?<\/brief>/gi
const BRIEF_READY_MESSAGES = [
  "Brief's ready — give it a once-over on the right and dispatch when you're happy.",
  "Drafted a brief for you. Take a look on the right and tweak anything before sending it off.",
  'Brief is on the right. Edit anything that feels off, then dispatch the run.',
]

function displayContent(role: 'user' | 'assistant', content: string): string {
  if (role !== 'assistant') return content
  if (!BRIEF_TAG_REGEX.test(content)) return content
  BRIEF_TAG_REGEX.lastIndex = 0
  const stripped = content.replace(BRIEF_TAG_REGEX, '').trim()
  if (stripped) return stripped
  // Stable pick — same message every time for the same content so it
  // doesn't shuffle on re-render.
  const idx = Math.abs(hashString(content)) % BRIEF_READY_MESSAGES.length
  return BRIEF_READY_MESSAGES[idx]
}

function hashString(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i)
    h |= 0
  }
  return h
}

function ToolUseRows({ calls, collapsed }: { calls: IntakeToolCall[]; collapsed: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const doneCount = calls.filter(c => c.status === 'done').length
  const running = calls.find(c => c.status === 'running')

  if (collapsed && !expanded) {
    const summary = running
      ? toolRunningLabel(running)
      : `Read ${doneCount} item${doneCount === 1 ? '' : 's'}`
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="ml-1 text-[11px] text-fg-subtle hover:text-fg-muted"
      >
        {summary}
      </button>
    )
  }

  return (
    <div className="ml-1 space-y-1">
      {calls.map((call, idx) => (
        <ToolUseRow key={`${call.name}-${idx}`} call={call} />
      ))}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[11px] text-fg-subtle hover:text-fg-muted"
        >
          Hide
        </button>
      ) : null}
    </div>
  )
}

function toolRunningLabel(call: IntakeToolCall): string {
  const key =
    call.input && typeof call.input === 'object' && 'key' in call.input
      ? String((call.input as { key: unknown }).key)
      : call.input && typeof call.input === 'object' && 'path' in call.input
        ? String((call.input as { path: unknown }).path)
        : null
  switch (call.name) {
    case 'tracker_get_issue':
      return key ? `Coro is reading ${key}…` : 'Coro is reading a ticket…'
    case 'tracker_search_issues':
      return 'Coro is searching tickets…'
    case 'scm_read_file':
      return key ? `Coro is reading ${key}…` : 'Coro is reading a file…'
    case 'scm_search_code':
      return 'Coro is searching code…'
    default:
      return 'Coro is working…'
  }
}

function ToolUseRow({ call }: { call: IntakeToolCall }) {
  const [open, setOpen] = useState(false)
  const label =
    call.status === 'running'
      ? toolRunningLabel(call)
      : call.summary ?? call.name

  return (
    <div className="text-[11px] text-fg-subtle">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
          call.status === 'running'
            ? 'border-line bg-overlay/40'
            : call.ok === false
              ? 'border-danger-500/30 bg-danger-500/10 text-danger-200'
              : 'border-line bg-overlay/20 hover:bg-overlay/40',
        )}
      >
        {call.status === 'running' ? <Loader2 className="size-3 animate-spin" /> : null}
        <span>{label}</span>
      </button>
      {open ? (
        <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-canvas/80 p-2 text-[10px] text-fg-muted">
          {JSON.stringify(call.input ?? call.error ?? call.summary, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function ChatBubble({
  role,
  content,
  streaming = false,
}: {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}) {
  const text = displayContent(role, content)
  return (
    <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed',
          role === 'user'
            ? 'bg-accent-500/15 text-fg'
            : 'border border-line bg-canvas/60 text-fg-muted',
          streaming && 'animate-pulse',
        )}
      >
        {text}
      </div>
    </div>
  )
}

interface AutoGrowTextareaProps {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  placeholder?: string
  disabled?: boolean
}

/**
 * Single-control composer for the intake chat: behaves like a normal
 * messaging input — Enter sends, Shift+Enter inserts a newline, and
 * the box grows up to ~5 lines before scrolling.
 */
function AutoGrowTextarea({ value, onChange, onSubmit, placeholder, disabled }: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const maxHeight = 5 * 24 + 24 // ~5 lines @ 24px line-height + padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          if (!disabled && value.trim()) onSubmit()
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      className="flex-1 resize-none rounded-xl border border-line-strong bg-overlay px-3.5 py-2.5 text-sm leading-6 text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:cursor-not-allowed disabled:opacity-50"
    />
  )
}

function BriefEditor({
  brief,
  workflows,
  onChange,
  onSubmit,
  submitting,
  error,
}: {
  brief: BriefDraft
  workflows: WorkflowOption[]
  onChange: (b: BriefDraft) => void
  onSubmit: () => void
  submitting: boolean
  error: string | null
}) {
  const wf = workflows.find(w => w.workflowPath === brief.workflowPath)

  return (
    <div className="space-y-4 rounded-2xl border border-accent-500/30 bg-accent-500/5 p-5">
      <div>
        <div className="text-sm font-semibold text-fg">Run brief</div>
        <p className="mt-1 text-xs text-fg-muted">Edit anything before dispatching.</p>
      </div>

      <Field label="Repository" required>
        <Input value={brief.repo} onChange={e => onChange({ ...brief, repo: e.target.value })} />
      </Field>
      <Field label="Service name" required>
        <Input
          value={brief.serviceName}
          onChange={e => onChange({ ...brief, serviceName: e.target.value })}
        />
      </Field>
      <Field label="Description" required>
        <Textarea
          rows={5}
          value={brief.description}
          onChange={e => onChange({ ...brief, description: e.target.value })}
        />
      </Field>
      <Field label="Reviewers">
        <Input
          value={brief.reviewers}
          onChange={e => onChange({ ...brief, reviewers: e.target.value })}
          placeholder="alice, bob"
        />
      </Field>
      <Field label="Workflow">
        <select
          className="w-full rounded-lg border border-line bg-overlay/40 px-3 py-2 text-sm"
          value={brief.workflowPath}
          onChange={e => onChange({ ...brief, workflowPath: e.target.value })}
        >
          {workflows.map(w => (
            <option key={w.id} value={w.workflowPath}>
              {w.name}
            </option>
          ))}
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={brief.interactive}
          onChange={e => onChange({ ...brief, interactive: e.target.checked })}
        />
        Interactive (pause at checkpoints)
      </label>

      {error ? <div className="text-sm text-danger-300">{error}</div> : null}

      <Button type="button" className="w-full" disabled={submitting} onClick={onSubmit}>
        {submitting ? <Loader2 className="animate-spin" /> : null}
        {submitting ? 'Starting run…' : 'Start this run'}
      </Button>
      {wf ? (
        <p className="text-[11px] text-fg-subtle">{wf.description}</p>
      ) : null}
    </div>
  )
}
