import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { applyIntakeEvent } from '../components/activity/adapters/intake'
import { settleRunningEntries } from '../components/activity/group'
import type { ActivityItem } from '../components/activity/types'
import { parseReadiness, type Readiness } from '../lib/intake-readiness'
import { parseRun } from '../lib/intake-run'
import { discardIntakeSession, runIntakeStream, toIntakeMessages } from '../lib/intake-stream'
import {
  clearNewRunDraftStorage,
  clearOrphanedIntakeKeys,
  loadNewRunDraft,
  mintSessionId,
  saveNewRunDraft,
  type NewRunDraft,
} from '../lib/new-run-draft'
import { deriveRunHistoryHints } from '../lib/run-history'
import { requestJson } from '../lib/http'
import type { ConfigResponse } from '../pages/Settings/SettingsContext'
import type { Job } from '../types'
import type { WorkflowOption } from '../workflows'

/**
 * What the "Generate run" control sends. Plan mode investigates until the
 * work is clear rather than racing to a run, so asking for one is an
 * explicit developer act — and it stays a request, not a command, because
 * the agent is told to name what it had to assume.
 */
const GENERATE_RUN_REQUEST =
  'Generate the run now from what we have. If anything is still unresolved, say in one line what it is and what you assumed.'

function nextId(prefix: string): string {
  return `${prefix}-${mintSessionId()}`
}

interface PlanSessionState {
  sessionId: string
  items: ActivityItem[]
  busy: boolean
  partialText: string
  partialThinking: string
  error: string | null
  noLlm: boolean
  turnCount: number
  totalTokens: number
  contextUsed: number
  readiness: Readiness | null
  modelChoice: { provider: string; model: string }
}

export interface PlanSessionApi extends PlanSessionState {
  send: (text: string, opts?: { generateRun?: boolean }) => Promise<void>
  cancel: () => void
  reset: () => void
  setModelChoice: (next: { provider: string; model: string }) => void
  updateCard: (itemId: string, data: unknown) => void
  markCardDispatched: (itemId: string, jobId: string) => void
  appendNotice: (notice: { tone: 'info' | 'warning' | 'error'; text: string; action?: { label: string; to: string } }) => void
  setKnownWorkflows: (workflows: WorkflowOption[]) => void
  setJobs: (jobs: Job[]) => void
  setScmConnected: (connected: boolean) => void
  workflows: WorkflowOption[]
  jobs: Job[]
  scmConnected: boolean
  hasProgress: boolean
}

const PlanSessionContext = createContext<PlanSessionApi | null>(null)

function initialState(): PlanSessionState {
  const draft = loadNewRunDraft()
  return {
    sessionId: draft?.sessionId ?? mintSessionId(),
    items: draft?.items ?? [],
    busy: false,
    partialText: '',
    partialThinking: '',
    error: null,
    noLlm: false,
    turnCount: draft?.turnCount ?? 0,
    totalTokens: draft?.totalTokens ?? 0,
    contextUsed: draft?.contextUsed ?? 0,
    readiness: draft?.readiness ?? null,
    modelChoice: draft?.modelChoice ?? { provider: '', model: '' },
  }
}

let boot: PlanSessionState | null = null

function bootState(): PlanSessionState {
  if (!boot) boot = initialState()
  return boot
}

export function PlanSessionProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState(() => bootState().sessionId)
  const [items, setItems] = useState<ActivityItem[]>(() => bootState().items)
  const [busy, setBusy] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [partialThinking, setPartialThinking] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [noLlm, setNoLlm] = useState(false)
  const [turnCount, setTurnCount] = useState(() => bootState().turnCount)
  const [totalTokens, setTotalTokens] = useState(() => bootState().totalTokens)
  const [contextUsed, setContextUsed] = useState(() => bootState().contextUsed)
  const [readiness, setReadiness] = useState<Readiness | null>(() => bootState().readiness)
  const [modelChoice, setModelChoice] = useState(() => bootState().modelChoice)
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [scmConnected, setScmConnected] = useState(true)

  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const itemsRef = useRef(items)
  const workflowsRef = useRef(workflows)
  const jobsRef = useRef(jobs)
  const modelChoiceRef = useRef(modelChoice)
  const sessionIdRef = useRef(sessionId)
  workflowsRef.current = workflows
  jobsRef.current = jobs
  modelChoiceRef.current = modelChoice
  sessionIdRef.current = sessionId

  useEffect(() => {
    clearOrphanedIntakeKeys()
  }, [])

  useEffect(() => {
    void requestJson<ConfigResponse>('/config').then(data => {
      const tier =
        data.config?.llm?.aliases?.['tier:planning'] ?? data.config?.llm?.aliases?.['planning']
      if (!tier?.model) return
      setModelChoice(prev => (prev.model ? prev : { provider: tier.provider ?? '', model: tier.model }))
    }).catch(() => {
      // Non-fatal — the picker still works without a default.
    })
  }, [])

  useEffect(() => {
    const draft: NewRunDraft = {
      version: 3,
      sessionId,
      items,
      modelChoice,
      turnCount,
      totalTokens,
      contextUsed,
      readiness,
    }
    if (busy) {
      const timer = window.setTimeout(() => saveNewRunDraft(draft), 250)
      return () => window.clearTimeout(timer)
    }
    saveNewRunDraft(draft)
  }, [sessionId, items, modelChoice, turnCount, totalTokens, contextUsed, readiness, busy])

  const commitItems = useCallback((updater: (prev: ActivityItem[]) => ActivityItem[]) => {
    const next = updater(itemsRef.current)
    itemsRef.current = next
    setItems(next)
    return next
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    busyRef.current = false
    setBusy(false)
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    busyRef.current = false
    discardIntakeSession(sessionIdRef.current)
    const next = mintSessionId()
    boot = {
      sessionId: next,
      items: [],
      busy: false,
      partialText: '',
      partialThinking: '',
      error: null,
      noLlm: false,
      turnCount: 0,
      totalTokens: 0,
      contextUsed: 0,
      readiness: null,
      modelChoice: modelChoiceRef.current,
    }
    sessionIdRef.current = next
    itemsRef.current = []
    setSessionId(next)
    setItems([])
    setBusy(false)
    setPartialText('')
    setPartialThinking('')
    setError(null)
    setNoLlm(false)
    setTurnCount(0)
    setTotalTokens(0)
    setContextUsed(0)
    setReadiness(null)
    clearNewRunDraftStorage()
  }, [])

  const appendNotice = useCallback(
    (notice: { tone: 'info' | 'warning' | 'error'; text: string; action?: { label: string; to: string } }) => {
      commitItems(prev => [
        ...prev,
        {
          kind: 'notice',
          id: nextId('notice'),
          tone: notice.tone,
          text: notice.text,
          ...(notice.action ? { action: notice.action } : {}),
        },
      ])
    },
    [commitItems],
  )

  const send = useCallback(async (text: string, opts?: { generateRun?: boolean }) => {
    if (busyRef.current) return
    const trimmed = text.trim()
    if (!trimmed && !opts?.generateRun) return

    busyRef.current = true
    setBusy(true)
    setPartialText('')
    setPartialThinking('')
    setError(null)

    // One outgoing message per turn, so the browser transcript and the
    // runner's session stay in step even when the developer types something
    // and clicks Generate run in the same breath.
    const outgoing = opts?.generateRun
      ? [trimmed, GENERATE_RUN_REQUEST].filter(Boolean).join('\n\n')
      : trimmed

    const transcript = toIntakeMessages(itemsRef.current)
    commitItems(prev => [...prev, { kind: 'message', id: nextId('msg'), role: 'user', text: outgoing }])

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const history = deriveRunHistoryHints(jobsRef.current)
    let assistantText = ''
    let committedAssistantLength = 0
    let thinkingBuffer = ''

    const flushThinking = () => {
      const thought = thinkingBuffer.trim()
      thinkingBuffer = ''
      setPartialThinking('')
      if (!thought) return
      commitItems(prev => [...prev, { kind: 'thought', id: nextId('thought'), text: thought }])
    }

    const flushAssistantBubble = () => {
      const pending = assistantText.slice(committedAssistantLength).trim()
      committedAssistantLength = assistantText.length
      setPartialText('')
      if (!pending) return
      commitItems(prev => [...prev, { kind: 'message', id: nextId('msg'), role: 'assistant', text: pending }])
    }

    try {
      const result = await runIntakeStream({
        sessionId: sessionIdRef.current,
        message: outgoing,
        transcript,
        context: {
          recentRepos: history.recentRepos,
          recentReviewers: history.recentReviewers,
          availableWorkflows: workflowsRef.current,
          userLocale: navigator.language,
        },
        modelChoice: modelChoiceRef.current.model ? modelChoiceRef.current : undefined,
        signal: controller.signal,
        onEvent: event => {
          if (event.type === 'thinking' && event.text) {
            flushAssistantBubble()
            thinkingBuffer += event.text
            setPartialThinking(thinkingBuffer)
          } else if (event.type === 'token' && event.text) {
            flushThinking()
            assistantText += event.text
            setPartialText(assistantText.slice(committedAssistantLength))
          } else if (event.type === 'tool_start' || event.type === 'tool_end') {
            if (event.type === 'tool_start') {
              flushThinking()
              flushAssistantBubble()
            }
            commitItems(prev => applyIntakeEvent(prev, event))
          } else if (event.type === 'done') {
            commitItems(prev => applyIntakeEvent(prev, event))
            if (event.usage?.totalTokens) setTotalTokens(prev => prev + event.usage!.totalTokens)
            if (event.contextTokens != null) setContextUsed(event.contextTokens)
          } else if (event.type === 'error') {
            commitItems(prev => applyIntakeEvent(prev, event))
            if (event.message) {
              if (event.reason === 'no-llm') setNoLlm(true)
              setError(event.message)
              commitItems(prev => [
                ...prev,
                { kind: 'notice', id: nextId('notice'), tone: 'error', text: event.message ?? 'Plan mode failed' },
              ])
            }
          }
        },
      })

      if (result.noLlm) {
        setNoLlm(true)
        setError(result.error ?? 'No LLM provider configured')
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Keep whatever text arrived; not an error.
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        commitItems(prev => [...prev, { kind: 'notice', id: nextId('notice'), tone: 'error', text: message }])
      }
    } finally {
      flushThinking()
      const committed = assistantText.trim()
      const turnReadiness = committed ? parseReadiness(committed) : null
      setReadiness(turnReadiness)
      commitItems(prev => {
        const settled = settleRunningEntries(prev)
        const pending = assistantText.slice(committedAssistantLength).trim()
        const withMessage: ActivityItem[] = pending
          ? [...settled, { kind: 'message', id: nextId('msg'), role: 'assistant', text: pending }]
          : settled
        if (!committed) return withMessage
        const parsed = parseRun(
          committed,
          workflowsRef.current.map(w => w.workflowPath),
        )
        if (!parsed) return withMessage

        // The whole point of the investigation is that a run arrives when the
        // work is understood. An unrequested run emitted mid-investigation is
        // the behaviour we removed, so hold it back and say why — asking again
        // is one click.
        if (!opts?.generateRun && turnReadiness?.state === 'investigating') {
          const open = turnReadiness.openQuestions[0]
          return [
            ...withMessage,
            {
              kind: 'notice',
              id: nextId('notice'),
              tone: 'info',
              text: open
                ? `Held back a run — still unresolved: ${open}. Use "Generate run" to get one anyway.`
                : 'Held back a run — the investigation is not finished. Use "Generate run" to get one anyway.',
            },
          ]
        }

        const superseded = withMessage.map(item => {
          if (item.kind !== 'card' || item.card.type !== 'run') return item
          const data = item.card.data as { state?: string }
          if (data.state !== 'draft') return item
          return { ...item, card: { ...item.card, data: { ...data, state: 'superseded' } } }
        })
        return [
          ...superseded,
          {
            kind: 'card',
            id: nextId('card'),
            card: { type: 'run', data: { run: parsed, state: 'draft' } },
          },
        ]
      })
      setPartialText('')
      setPartialThinking('')
      setTurnCount(c => c + 1)
      busyRef.current = false
      setBusy(false)
      abortRef.current = null
    }
  }, [commitItems])

  const updateCard = useCallback((itemId: string, data: unknown) => {
    commitItems(prev =>
      prev.map(item =>
        item.kind === 'card' && item.id === itemId ? { ...item, card: { ...item.card, data } } : item,
      ),
    )
  }, [commitItems])

  const markCardDispatched = useCallback((itemId: string, jobId: string) => {
    commitItems(prev =>
      prev.map(item => {
        if (item.kind !== 'card' || item.id !== itemId) return item
        const data = item.card.data as Record<string, unknown>
        return { ...item, card: { ...item.card, data: { ...data, state: 'dispatched', jobId } } }
      }),
    )
  }, [commitItems])

  const hasProgress = items.some(i => i.kind === 'message' && i.role === 'user') || items.some(i => i.kind === 'card')

  const value = useMemo<PlanSessionApi>(
    () => ({
      sessionId,
      items,
      busy,
      partialText,
      partialThinking,
      error,
      noLlm,
      turnCount,
      totalTokens,
      contextUsed,
      readiness,
      modelChoice,
      send,
      cancel,
      reset,
      setModelChoice,
      updateCard,
      markCardDispatched,
      appendNotice,
      setKnownWorkflows: setWorkflows,
      setJobs,
      setScmConnected,
      workflows,
      jobs,
      scmConnected,
      hasProgress,
    }),
    [
      sessionId,
      items,
      busy,
      partialText,
      partialThinking,
      error,
      noLlm,
      turnCount,
      totalTokens,
      contextUsed,
      readiness,
      modelChoice,
      send,
      cancel,
      reset,
      updateCard,
      markCardDispatched,
      appendNotice,
      workflows,
      jobs,
      scmConnected,
      hasProgress,
    ],
  )

  return <PlanSessionContext.Provider value={value}>{children}</PlanSessionContext.Provider>
}

export function usePlanSession(): PlanSessionApi {
  const context = useContext(PlanSessionContext)
  if (!context) {
    throw new Error('usePlanSession must be used inside PlanSessionProvider')
  }
  return context
}
