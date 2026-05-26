import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Send, Sparkles } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import Field from './forms/field'
import { jsonRequest, requestJson, ApiError } from '../lib/http'
import { parseBrief, type BriefDraft } from '../lib/intake-brief'
import { deriveRunHistoryHints, findSimilarRuns } from '../lib/run-history'
import { useIntakeStream, type IntakeChatMessage } from '../hooks/useIntakeStream'
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
  const [brief, setBrief] = useState<BriefDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const userTurns = useMemo(() => messages.filter(m => m.role === 'user').length, [messages])

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
      )

      if (result.noLlm) return

      const assistantText = (result.assistantText || partial).trim()
      if (assistantText) {
        setMessages(prev => [...prev, { role: 'assistant', content: assistantText }])
      }
      setPartial('')

      const parsed = parseBrief(assistantText, workflowPaths)
      if (parsed) {
        setBrief(parsed)
      } else if (userTurns + 1 >= MAX_TURNS_WITHOUT_BRIEF) {
        setSubmitError('We could not get to a clean brief. Try the form with your description prefilled.')
      }
    },
    [messages, send, history, workflows, workflowPaths, partial, userTurns],
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
        reviewers: brief.reviewers,
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
            <ChatBubble key={i} role={m.role} content={m.content} />
          ))}
          {partial ? <ChatBubble role="assistant" content={partial} streaming /> : null}
          {streaming ? (
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
            className="flex gap-2"
          >
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Describe what you want Coro to do…"
              disabled={streaming}
            />
            <Button type="submit" disabled={streaming || !input.trim()}>
              <Send />
            </Button>
          </form>
          <div className="mt-2 flex justify-end">
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

function ChatBubble({
  role,
  content,
  streaming = false,
}: {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}) {
  return (
    <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
          role === 'user'
            ? 'bg-accent-500/15 text-fg'
            : 'border border-line bg-canvas/60 text-fg-muted',
          streaming && 'animate-pulse',
        )}
      >
        {content}
      </div>
    </div>
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
          value={brief.reviewers.join(', ')}
          onChange={e =>
            onChange({
              ...brief,
              reviewers: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
            })
          }
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
