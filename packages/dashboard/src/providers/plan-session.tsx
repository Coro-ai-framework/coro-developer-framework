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
import { parseBrief } from '../lib/intake-brief'
import { runIntakeStream, toIntakeMessages } from '../lib/intake-stream'
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

function nextId(prefix: string): string {
  return `${prefix}-${mintSessionId()}`
}

function isLimitMessage(message: string): boolean {
  return message.startsWith('Session turn limit') || message.startsWith('Session token budget')
}

interface PlanSessionState {
  sessionId: string
  items: ActivityItem[]
  busy: boolean
  partialText: string
  error: string | null
  noLlm: boolean
  turnCount: number
  totalTokens: number
  modelChoice: { provider: string; model: string }
}

export interface PlanSessionApi extends PlanSessionState {
  send: (text: string, opts?: { forceBrief?: boolean }) => Promise<void>
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
  limitReached: boolean
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
    error: null,
    noLlm: false,
    turnCount: draft?.turnCount ?? 0,
    totalTokens: draft?.totalTokens ?? 0,
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
  const [error, setError] = useState<string | null>(null)
  const [noLlm, setNoLlm] = useState(false)
  const [turnCount, setTurnCount] = useState(() => bootState().turnCount)
  const [totalTokens, setTotalTokens] = useState(() => bootState().totalTokens)
  const [modelChoice, setModelChoice] = useState(() => bootState().modelChoice)
  const [limitReached, setLimitReached] = useState(false)
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
      version: 2,
      sessionId,
      items,
      modelChoice,
      turnCount,
      totalTokens,
    }
    if (busy) {
      const timer = window.setTimeout(() => saveNewRunDraft(draft), 250)
      return () => window.clearTimeout(timer)
    }
    saveNewRunDraft(draft)
  }, [sessionId, items, modelChoice, turnCount, totalTokens, busy])

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
    const next = mintSessionId()
    boot = {
      sessionId: next,
      items: [],
      busy: false,
      partialText: '',
      error: null,
      noLlm: false,
      turnCount: 0,
      totalTokens: 0,
      modelChoice: modelChoiceRef.current,
    }
    sessionIdRef.current = next
    itemsRef.current = []
    setSessionId(next)
    setItems([])
    setBusy(false)
    setPartialText('')
    setError(null)
    setNoLlm(false)
    setTurnCount(0)
    setTotalTokens(0)
    setLimitReached(false)
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

  const send = useCallback(async (text: string, opts?: { forceBrief?: boolean }) => {
    if (busyRef.current) return
    const trimmed = text.trim()
    if (!trimmed && !opts?.forceBrief) return

    busyRef.current = true
    setBusy(true)
    setPartialText('')
    setError(null)

    const additions: ActivityItem[] = []
    if (trimmed) {
      additions.push({ kind: 'message', id: nextId('msg'), role: 'user', text: trimmed })
    }
    if (opts?.forceBrief) {
      additions.push({
        kind: 'message',
        id: nextId('msg'),
        role: 'user',
        text: 'Please emit your best <brief> now with what we have so far.',
      })
    }

    const snapshot = commitItems(prev => [...prev, ...additions])

    const messages = toIntakeMessages(snapshot)
    if (!messages.some(m => m.role === 'user' && m.content.trim())) {
      busyRef.current = false
      setBusy(false)
      setError('Nothing to send.')
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const history = deriveRunHistoryHints(jobsRef.current)
    let assistantText = ''

    try {
      const result = await runIntakeStream({
        sessionId: sessionIdRef.current,
        messages,
        context: {
          recentRepos: history.recentRepos,
          recentReviewers: history.recentReviewers,
          availableWorkflows: workflowsRef.current,
          userLocale: navigator.language,
        },
        modelChoice: modelChoiceRef.current.model ? modelChoiceRef.current : undefined,
        signal: controller.signal,
        onEvent: event => {
          if (event.type === 'token' && event.text) {
            assistantText += event.text
            setPartialText(prev => prev + event.text)
          } else if (event.type === 'tool_start' || event.type === 'tool_end') {
            commitItems(prev => applyIntakeEvent(prev, event))
          } else if (event.type === 'done') {
            commitItems(prev => applyIntakeEvent(prev, event))
            if (event.usage?.totalTokens) setTotalTokens(prev => prev + event.usage!.totalTokens)
          } else if (event.type === 'error') {
            commitItems(prev => applyIntakeEvent(prev, event))
            if (event.message) {
              if (event.reason === 'no-llm') setNoLlm(true)
              if (isLimitMessage(event.message)) setLimitReached(true)
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
      const committed = assistantText.trim()
      commitItems(prev => {
        const settled = settleRunningEntries(prev)
        if (!committed) return settled
        const withMessage: ActivityItem[] = [
          ...settled,
          { kind: 'message', id: nextId('msg'), role: 'assistant', text: committed },
        ]
        const parsed = parseBrief(
          committed,
          workflowsRef.current.map(w => w.workflowPath),
        )
        if (!parsed) return withMessage
        const superseded = withMessage.map(item => {
          if (item.kind !== 'card' || item.card.type !== 'brief') return item
          const data = item.card.data as { state?: string }
          if (data.state !== 'draft') return item
          return { ...item, card: { ...item.card, data: { ...data, state: 'superseded' } } }
        })
        return [
          ...superseded,
          {
            kind: 'card',
            id: nextId('card'),
            card: { type: 'brief', data: { brief: parsed, state: 'draft' } },
          },
        ]
      })
      setPartialText('')
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
      error,
      noLlm,
      turnCount,
      totalTokens,
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
      limitReached,
      hasProgress,
    }),
    [
      sessionId,
      items,
      busy,
      partialText,
      error,
      noLlm,
      turnCount,
      totalTokens,
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
      limitReached,
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
