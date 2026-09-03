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
import { displayContent } from '../components/activity/message-block'
import type { ActivityItem } from '../components/activity/types'
import { parseFindings, looksLikeFindingsReport } from '../lib/intake-findings'
import {
  asActivityItems,
  getInvestigation,
  investigationHasProgress,
  investigationTitleFromItems,
  INVESTIGATION_LIST_PAGE_SIZE,
  listInvestigations,
  mergeInvestigationSummaries,
  putInvestigation,
  toInvestigationSummary,
  type InvestigationStatus,
  type InvestigationSummary,
} from '../lib/intake-investigation'
import { parseReadiness, type Readiness } from '../lib/intake-readiness'
import { parseRun } from '../lib/intake-run'
import { runIntakeStream, toIntakeMessages } from '../lib/intake-stream'
import {
  clearNewRunDraftStorage,
  clearOrphanedIntakeKeys,
  loadNewRunDraft,
  mintSessionId,
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

let bootSessionId: string | null = null
function initialSessionId(): string {
  if (!bootSessionId) bootSessionId = mintSessionId()
  return bootSessionId
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
  startNewConversation: (opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => Promise<void>
  openInvestigation: (id: string) => Promise<void>
  loadMoreInvestigations: () => Promise<void>
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
  hydrated: boolean
  investigations: InvestigationSummary[]
  investigationsTotal: number
  investigationsLoading: boolean
  investigationsLoadingMore: boolean
}

const PlanSessionContext = createContext<PlanSessionApi | null>(null)

export function PlanSessionProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState(initialSessionId)
  const [items, setItems] = useState<ActivityItem[]>([])
  const [busy, setBusy] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [partialThinking, setPartialThinking] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [noLlm, setNoLlm] = useState(false)
  const [turnCount, setTurnCount] = useState(0)
  const [totalTokens, setTotalTokens] = useState(0)
  const [contextUsed, setContextUsed] = useState(0)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [modelChoice, setModelChoice] = useState({ provider: '', model: '' })
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [scmConnected, setScmConnected] = useState(true)
  const [hydrated, setHydrated] = useState(false)
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([])
  const [investigationsTotal, setInvestigationsTotal] = useState(0)
  const [investigationsLoading, setInvestigationsLoading] = useState(true)
  const [investigationsLoadingMore, setInvestigationsLoadingMore] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const itemsRef = useRef(items)
  const workflowsRef = useRef(workflows)
  const jobsRef = useRef(jobs)
  const modelChoiceRef = useRef(modelChoice)
  const sessionIdRef = useRef(sessionId)
  const readinessRef = useRef(readiness)
  const turnCountRef = useRef(turnCount)
  const tokensRef = useRef(totalTokens)
  const contextUsedRef = useRef(contextUsed)
  const investigationsRef = useRef(investigations)
  const persistChainRef = useRef(Promise.resolve())
  workflowsRef.current = workflows
  jobsRef.current = jobs
  modelChoiceRef.current = modelChoice
  sessionIdRef.current = sessionId
  itemsRef.current = items
  readinessRef.current = readiness
  turnCountRef.current = turnCount
  tokensRef.current = totalTokens
  contextUsedRef.current = contextUsed
  investigationsRef.current = investigations

  const commitItems = useCallback((updater: (prev: ActivityItem[]) => ActivityItem[]) => {
    const next = updater(itemsRef.current)
    itemsRef.current = next
    setItems(next)
    return next
  }, [])

  const rememberSummary = useCallback((summary: InvestigationSummary) => {
    const existed = investigationsRef.current.some(row => row.id === summary.id)
    const next = mergeInvestigationSummaries(investigationsRef.current, summary)
    investigationsRef.current = next
    setInvestigations(next)
    if (!existed) setInvestigationsTotal(total => total + 1)
  }, [])

  const persistNow = useCallback(async (opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => {
    const id = sessionIdRef.current
    const currentItems = itemsRef.current
    if (!investigationHasProgress(currentItems) && opts?.status !== 'dispatched') return
    try {
      const result = await putInvestigation(id, {
        items: currentItems,
        readiness: readinessRef.current,
        modelChoice: modelChoiceRef.current,
        turnCount: turnCountRef.current,
        tokens: tokensRef.current,
        contextUsed: contextUsedRef.current,
        title: investigationTitleFromItems(currentItems),
        status: opts?.status ?? 'active',
        ...(opts?.dispatchedJobId ? { dispatchedJobId: opts.dispatchedJobId } : {}),
      })
      if (result.session) rememberSummary(toInvestigationSummary(result.session))
    } catch {
      // Persistence must not block chatting; the next turn retries.
    }
  }, [rememberSummary])

  const enqueuePersist = useCallback((opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => {
    persistChainRef.current = persistChainRef.current.then(() => persistNow(opts)).catch(() => undefined)
    return persistChainRef.current
  }, [persistNow])

  const applyRecord = useCallback((record: {
    id: string
    items: unknown[]
    turnCount: number
    tokens: number
    contextUsed: number
    readiness: Readiness | null
    modelChoice?: { provider: string; model: string }
  }) => {
    const nextItems = asActivityItems(record.items)
    sessionIdRef.current = record.id
    itemsRef.current = nextItems
    bootSessionId = record.id
    setSessionId(record.id)
    setItems(nextItems)
    setTurnCount(record.turnCount)
    setTotalTokens(record.tokens)
    setContextUsed(record.contextUsed)
    setReadiness(record.readiness)
    if (record.modelChoice?.model) setModelChoice(record.modelChoice)
    busyRef.current = false
    setBusy(false)
    setPartialText('')
    setPartialThinking('')
    setError(null)
  }, [])

  const mintEmpty = useCallback(() => {
    const next = mintSessionId()
    sessionIdRef.current = next
    itemsRef.current = []
    bootSessionId = next
    setSessionId(next)
    setItems([])
    busyRef.current = false
    setBusy(false)
    setPartialText('')
    setPartialThinking('')
    setError(null)
    setNoLlm(false)
    setTurnCount(0)
    setTotalTokens(0)
    setContextUsed(0)
    setReadiness(null)
  }, [])

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
    let cancelled = false
    async function hydrateFromServer() {
      setInvestigationsLoading(true)
      try {
        const draft = loadNewRunDraft()
        let list = await listInvestigations({ limit: INVESTIGATION_LIST_PAGE_SIZE, offset: 0 })
        if (cancelled) return
        if (draft && investigationHasProgress(draft.items) && list.total === 0) {
          await putInvestigation(draft.sessionId, {
            items: draft.items,
            readiness: draft.readiness,
            modelChoice: draft.modelChoice,
            turnCount: draft.turnCount,
            tokens: draft.totalTokens,
            contextUsed: draft.contextUsed,
            title: investigationTitleFromItems(draft.items),
            status: 'active',
          })
          list = await listInvestigations({ limit: INVESTIGATION_LIST_PAGE_SIZE, offset: 0 })
        }
        clearNewRunDraftStorage()
        if (cancelled) return
        setInvestigations(list.sessions)
        investigationsRef.current = list.sessions
        setInvestigationsTotal(list.total)
        const recentActive = list.sessions.find(row => row.status === 'active')
        if (recentActive) {
          const full = await getInvestigation(recentActive.id)
          if (cancelled) return
          applyRecord(full)
        }
      } catch {
        clearNewRunDraftStorage()
      } finally {
        if (!cancelled) {
          setInvestigationsLoading(false)
          setHydrated(true)
        }
      }
    }
    void hydrateFromServer()
    return () => {
      cancelled = true
    }
  }, [applyRecord])

  useEffect(() => {
    if (!hydrated) return
    if (!investigationHasProgress(items)) return
    const timer = window.setTimeout(() => {
      void enqueuePersist()
    }, busy ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [hydrated, sessionId, items, modelChoice, turnCount, totalTokens, contextUsed, readiness, busy, enqueuePersist])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    busyRef.current = false
    setBusy(false)
  }, [])

  const startNewConversation = useCallback(async (opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => {
    abortRef.current?.abort()
    abortRef.current = null
    await enqueuePersist(opts)
    mintEmpty()
  }, [enqueuePersist, mintEmpty])

  const openInvestigation = useCallback(async (id: string) => {
    if (id === sessionIdRef.current) return
    abortRef.current?.abort()
    abortRef.current = null
    if (investigationHasProgress(itemsRef.current)) await enqueuePersist()
    const full = await getInvestigation(id)
    applyRecord(full)
  }, [applyRecord, enqueuePersist])

  const loadMoreInvestigations = useCallback(async () => {
    if (investigationsRef.current.length >= investigationsTotal) return
    setInvestigationsLoadingMore(true)
    try {
      const page = await listInvestigations({
        limit: INVESTIGATION_LIST_PAGE_SIZE,
        offset: investigationsRef.current.length,
      })
      const seen = new Set(investigationsRef.current.map(row => row.id))
      const next = [...investigationsRef.current, ...page.sessions.filter(row => !seen.has(row.id))]
      investigationsRef.current = next
      setInvestigations(next)
      setInvestigationsTotal(page.total)
    } finally {
      setInvestigationsLoadingMore(false)
    }
  }, [investigationsTotal])

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
      if (!displayContent('assistant', pending)) return
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
        const visible = pending ? displayContent('assistant', pending) : ''
        const tagged = committed ? parseFindings(committed) : null
        const heuristic = !tagged && visible && looksLikeFindingsReport(visible) ? visible : null
        const findingsMarkdown = tagged ?? heuristic

        let next: ActivityItem[] =
          visible && !heuristic
            ? [...settled, { kind: 'message', id: nextId('msg'), role: 'assistant', text: pending }]
            : settled

        if (findingsMarkdown) {
          next = next.map(item => {
            if (item.kind !== 'card' || item.card.type !== 'findings') return item
            const data = item.card.data as { state?: string }
            if (data.state !== 'current') return item
            return { ...item, card: { ...item.card, data: { ...data, state: 'superseded' } } }
          })
          next = [
            ...next,
            {
              kind: 'card',
              id: nextId('card'),
              card: { type: 'findings', data: { markdown: findingsMarkdown, state: 'current' } },
            },
          ]
        }

        if (!committed) return next
        const parsed = parseRun(
          committed,
          workflowsRef.current.map(w => w.workflowPath),
        )
        if (!parsed) return next

        // The whole point of the investigation is that a run arrives when the
        // work is understood. An unrequested run emitted mid-investigation is
        // the behaviour we removed, so hold it back and say why — asking again
        // is one click.
        if (!opts?.generateRun && turnReadiness?.state === 'investigating') {
          const open = turnReadiness.openQuestions[0]
          return [
            ...next,
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

        const superseded = next.map(item => {
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

  const hasProgress = investigationHasProgress(items)

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
      startNewConversation,
      openInvestigation,
      loadMoreInvestigations,
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
      hydrated,
      investigations,
      investigationsTotal,
      investigationsLoading,
      investigationsLoadingMore,
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
      startNewConversation,
      openInvestigation,
      loadMoreInvestigations,
      updateCard,
      markCardDispatched,
      appendNotice,
      workflows,
      jobs,
      scmConnected,
      hasProgress,
      hydrated,
      investigations,
      investigationsTotal,
      investigationsLoading,
      investigationsLoadingMore,
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
