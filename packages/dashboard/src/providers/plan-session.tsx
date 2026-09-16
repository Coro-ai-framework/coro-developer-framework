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
import { parseFindings, looksLikeFindingsReport, currentFindingsMarkdown } from '../lib/intake-findings'
import {
  asActivityItems,
  deleteInvestigation,
  dropInvestigationSummary,
  getInvestigation,
  investigationHasProgress,
  investigationTitleFromItems,
  investigationToResume,
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
import { ensureDispatchedRunCard, jobForInvestigation } from '../lib/linked-run'
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
  /** False when the turn was refused (already busy, nothing to send). */
  send: (text: string, opts?: { generateRun?: boolean }) => Promise<boolean>
  cancel: () => void
  startNewConversation: (opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => Promise<void>
  openInvestigation: (id: string) => Promise<void>
  removeInvestigation: (id: string) => Promise<void>
  loadMoreInvestigations: () => Promise<void>
  setModelChoice: (next: { provider: string; model: string }) => void
  updateCard: (itemId: string, data: unknown) => void
  markCardDispatched: (itemId: string, jobId: string) => void
  persistSnapshot: (opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => Promise<void>
  appendNotice: (notice: { tone: 'info' | 'warning' | 'error'; text: string; action?: { label: string; to: string } }) => void
  setKnownWorkflows: (workflows: WorkflowOption[]) => void
  setJobs: (jobs: Job[]) => void
  setScmConnected: (connected: boolean) => void
  workflows: WorkflowOption[]
  jobs: Job[]
  scmConnected: boolean
  hasProgress: boolean
  hydrated: boolean
  /** True while a conversation switch is fetching. */
  switching: boolean
  /**
   * Conversations with a turn in flight — including ones the developer has
   * switched away from, since those turns keep running.
   */
  runningIds: string[]
  investigations: InvestigationSummary[]
  investigationsTotal: number
  investigationsLoading: boolean
  investigationsLoadingMore: boolean
}

/**
 * A turn that is still streaming, held per conversation.
 *
 * A turn outlives the conversation being on screen — switching away does not
 * stop it — so returning to one mid-turn has to re-attach to this rather than
 * re-read the row it was parked with. Without it the developer comes back to a
 * frozen transcript while the agent is demonstrably still working.
 */
interface LiveTurn {
  items: ActivityItem[]
  partialText: string
  partialThinking: string
  /** Billed tokens this turn has reported so far. */
  tokens: number
  contextUsed: number
  /** Kept so Stop still reaches the turn after a switch away and back. */
  controller: AbortController
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
  const [switching, setSwitching] = useState(false)
  const [runningIds, setRunningIds] = useState<string[]>([])
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
  const skipNextPersistRef = useRef(false)
  const deletedIdsRef = useRef(new Set<string>())
  const runningIdsRef = useRef<Set<string>>(new Set())
  const liveTurnsRef = useRef(new Map<string, LiveTurn>())
  /**
   * Bumped when the visible conversation changes (new / open / reset).
   * An in-flight `send()` compares against it to know whether its
   * conversation is still the one on screen: writes to React state stop,
   * but the turn itself keeps going and is persisted to the conversation
   * that started it. See `send`.
   */
  const turnGenerationRef = useRef(0)
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

  const markRunning = useCallback((id: string, running: boolean) => {
    const next = new Set(runningIdsRef.current)
    if (running) next.add(id)
    else next.delete(id)
    runningIdsRef.current = next
    setRunningIds([...next])
  }, [])

  const rememberSummary = useCallback((summary: InvestigationSummary) => {
    if (deletedIdsRef.current.has(summary.id)) return
    const existed = investigationsRef.current.some(row => row.id === summary.id)
    const next = mergeInvestigationSummaries(investigationsRef.current, summary)
    investigationsRef.current = next
    setInvestigations(next)
    if (!existed) setInvestigationsTotal(total => total + 1)
  }, [])

  const persistNow = useCallback(async (opts: {
    id: string
    items: ActivityItem[]
    readiness: Readiness | null
    modelChoice: { provider: string; model: string }
    turnCount: number
    tokens: number
    contextUsed: number
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => {
    if (deletedIdsRef.current.has(opts.id)) return
    if (!investigationHasProgress(opts.items) && opts.status !== 'dispatched') return
    try {
      const result = await putInvestigation(opts.id, {
        items: opts.items,
        readiness: opts.readiness,
        findings: currentFindingsMarkdown(opts.items),
        modelChoice: opts.modelChoice,
        turnCount: opts.turnCount,
        tokens: opts.tokens,
        contextUsed: opts.contextUsed,
        title: investigationTitleFromItems(opts.items),
        // Autosave omits status so a follow-up question cannot downgrade a
        // dispatched investigation back to active. First insert still
        // becomes active via mergeInvestigation's default.
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.dispatchedJobId ? { dispatchedJobId: opts.dispatchedJobId } : {}),
      })
      if (deletedIdsRef.current.has(opts.id)) {
        await deleteInvestigation(opts.id).catch(() => undefined)
        return
      }
      if (result.session) rememberSummary(toInvestigationSummary(result.session))
    } catch (err) {
      // Autosave must not block chatting; the next turn retries. Dispatch
      // used to treat a swallowed 413 as success and then navigate away,
      // which is how a started run vanished from the conversation.
      console.warn('Failed to persist investigation snapshot', err)
    }
  }, [rememberSummary])

  const enqueueSnapshot = useCallback((snapshot: Parameters<typeof persistNow>[0]) => {
    persistChainRef.current = persistChainRef.current.then(() => persistNow(snapshot)).catch(() => undefined)
    return persistChainRef.current
  }, [persistNow])

  const enqueuePersist = useCallback((opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => {
    const sessionId = sessionIdRef.current
    const linked = jobForInvestigation(
      jobsRef.current,
      sessionId,
      opts?.dispatchedJobId ?? investigationsRef.current.find(row => row.id === sessionId)?.dispatchedJobId,
    )
    const dispatchedJobId = opts?.dispatchedJobId ?? linked?.id
    return enqueueSnapshot({
      // Snapshot at enqueue time. mintEmpty() can clear the refs before the
      // PUT runs; the parked conversation must still be the one we persist.
      id: sessionId,
      // A turn still streaming has entries marked `running`. Storing them
      // that way leaves a conversation that reopens with a spinner it will
      // never resolve, so the stored copy is always settled — the live turn
      // re-persists the real outcome when it finishes.
      items: settleRunningEntries(itemsRef.current),
      readiness: readinessRef.current,
      modelChoice: modelChoiceRef.current,
      turnCount: turnCountRef.current,
      tokens: tokensRef.current,
      contextUsed: contextUsedRef.current,
      ...(opts?.status ? { status: opts.status } : dispatchedJobId ? { status: 'dispatched' } : {}),
      ...(dispatchedJobId ? { dispatchedJobId } : {}),
    })
  }, [enqueueSnapshot])

  const persistSnapshot = useCallback((opts?: {
    status?: InvestigationStatus
    dispatchedJobId?: string
  }) => enqueuePersist(opts), [enqueuePersist])

  const applyRecord = useCallback((record: {
    id: string
    items: unknown[]
    turnCount: number
    tokens: number
    contextUsed: number
    readiness: Readiness | null
    modelChoice?: { provider: string; model: string }
  }) => {
    skipNextPersistRef.current = true
    turnGenerationRef.current += 1
    setSwitching(false)
    // Mid-turn, the live transcript is ahead of the stored one — the row was
    // written when the conversation was parked and the turn has been running
    // since. Re-attach to it so the feed picks up where the agent actually is.
    const live = liveTurnsRef.current.get(record.id)
    const nextItems = live ? live.items : asActivityItems(record.items)
    sessionIdRef.current = record.id
    itemsRef.current = nextItems
    bootSessionId = record.id
    setSessionId(record.id)
    setItems(nextItems)
    setTurnCount(record.turnCount)
    setTotalTokens(record.tokens + (live?.tokens ?? 0))
    setContextUsed(live ? live.contextUsed : record.contextUsed)
    setReadiness(record.readiness)
    if (record.modelChoice?.model) setModelChoice(record.modelChoice)
    abortRef.current = live?.controller ?? null
    busyRef.current = Boolean(live)
    setBusy(Boolean(live))
    setPartialText(live?.partialText ?? '')
    setPartialThinking(live?.partialThinking ?? '')
    setError(null)
  }, [])

  const mintEmpty = useCallback(() => {
    turnGenerationRef.current += 1
    setSwitching(false)
    // Forget the in-flight controller without aborting it. The turn belongs
    // to the conversation being parked and finishes into it; killing the
    // fetch here is what used to throw away a reply already paid for.
    abortRef.current = null
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
    const generationAtStart = turnGenerationRef.current
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
            findings: currentFindingsMarkdown(draft.items),
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
        const resume = investigationToResume(list.sessions)
        if (resume) {
          const full = await getInvestigation(resume.id)
          if (cancelled) return
          // New conversation / an in-flight first turn already owns the pane.
          // Applying the last Recents row here is what made "New conversation"
          // open on leftover tool chips.
          if (turnGenerationRef.current !== generationAtStart) return
          if (busyRef.current) return
          if (investigationHasProgress(itemsRef.current)) return
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
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false
      return
    }
    if (!investigationHasProgress(items)) return
    const timer = window.setTimeout(() => {
      void enqueuePersist()
    }, busy ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [hydrated, sessionId, items, modelChoice, turnCount, totalTokens, contextUsed, readiness, busy, enqueuePersist])

  // The job exists even when the snapshot PUT never stored a run card
  // (payload-too-large). Rebuild the card from the live job so Recents and
  // the chat agree after a refresh.
  useEffect(() => {
    if (!hydrated || switching) return
    const linked = jobForInvestigation(
      jobs,
      sessionId,
      investigations.find(row => row.id === sessionId)?.dispatchedJobId,
    )
    if (!linked) return
    const current = itemsRef.current
    const next = ensureDispatchedRunCard(current, linked)
    if (next === current) return
    commitItems(() => next)
  }, [commitItems, hydrated, investigations, jobs, sessionId, switching])

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
    // mintEmpty swaps the session id, which is what stops the in-flight turn
    // writing here; the bump additionally invalidates any switch or hydrate
    // still resolving, so neither can drop a conversation onto the blank one.
    turnGenerationRef.current += 1
    const pending = enqueuePersist(opts)
    mintEmpty()
    await pending
  }, [enqueuePersist, mintEmpty])

  const openInvestigation = useCallback(async (id: string) => {
    if (id === sessionIdRef.current) return
    turnGenerationRef.current += 1
    abortRef.current = null
    const generation = turnGenerationRef.current
    setSwitching(true)
    if (investigationHasProgress(itemsRef.current)) enqueuePersist()
    // Drain queued writes first — one of them may be a turn that just
    // finished in another conversation, and this GET could otherwise read the
    // row it is about to replace.
    await persistChainRef.current
    try {
      const full = await getInvestigation(id)
      // A later switch — another row, or New conversation — won while this
      // GET was in flight. Applying now would drag the developer back into
      // a conversation they already left.
      if (turnGenerationRef.current !== generation) return
      applyRecord(full)
    } catch (err) {
      if (turnGenerationRef.current !== generation) return
      // The switch did not happen. Say so in the conversation still on
      // screen rather than leaving the click looking like a no-op.
      const message = err instanceof Error ? err.message : String(err)
      commitItems(prev => [
        ...prev,
        {
          kind: 'notice',
          id: nextId('notice'),
          tone: 'error',
          text: `Could not open that conversation — ${message}`,
        },
      ])
    } finally {
      if (turnGenerationRef.current === generation) setSwitching(false)
    }
  }, [applyRecord, commitItems, enqueuePersist])

  const removeInvestigation = useCallback(async (id: string) => {
    deletedIdsRef.current.add(id)
    const isCurrent = id === sessionIdRef.current
    // Discarding the conversation is the one case where its turn should not
    // survive: there is nothing left to adopt it, on screen or not.
    liveTurnsRef.current.get(id)?.controller.abort()
    if (isCurrent) {
      abortRef.current?.abort()
      abortRef.current = null
    }
    markRunning(id, false)
    try {
      await deleteInvestigation(id)
    } catch (err) {
      deletedIdsRef.current.delete(id)
      throw err
    }
    const remaining = dropInvestigationSummary(investigationsRef.current, id)
    investigationsRef.current = remaining
    setInvestigations(remaining)
    setInvestigationsTotal(total => Math.max(0, total - 1))
    if (isCurrent) mintEmpty()
    if (remaining.length >= INVESTIGATION_LIST_PAGE_SIZE) return
    try {
      const page = await listInvestigations({
        limit: INVESTIGATION_LIST_PAGE_SIZE,
        offset: remaining.length,
      })
      const seen = new Set(remaining.map(row => row.id))
      const next = [...remaining, ...page.sessions.filter(row => !seen.has(row.id))]
      investigationsRef.current = next
      setInvestigations(next)
      setInvestigationsTotal(page.total)
    } catch {
      // The row is already gone from the rail.
    }
  }, [markRunning, mintEmpty])

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

  const send = useCallback(async (text: string, opts?: { generateRun?: boolean }): Promise<boolean> => {
    if (busyRef.current) return false
    const trimmed = text.trim()
    if (!trimmed && !opts?.generateRun) return false

    const sessionAtStart = sessionIdRef.current
    const modelAtStart = modelChoiceRef.current
    const turnCountAtStart = turnCountRef.current
    const tokensAtStart = tokensRef.current
    /**
     * Whether this turn's conversation is the one on screen. Session ids are
     * minted UUIDs and never reused, so this goes false on a switch away and
     * true again on the way back — which is the point: the turn resumes
     * writing to the feed instead of finishing invisibly.
     */
    const onScreen = () => sessionIdRef.current === sessionAtStart

    busyRef.current = true
    setBusy(true)
    markRunning(sessionAtStart, true)
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

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // The turn's own copy of the transcript, readable by whoever comes back
    // to this conversation while it is still streaming.
    const live: LiveTurn = {
      items: itemsRef.current,
      partialText: '',
      partialThinking: '',
      tokens: 0,
      contextUsed: contextUsedRef.current,
      controller,
    }
    liveTurnsRef.current.set(sessionAtStart, live)

    // On screen, the turn writes through to the provider so edits that land
    // mid-turn from elsewhere — a run-card field, a notice — are not
    // clobbered. Off screen it extends its own copy, because `items` then
    // belongs to a different conversation.
    const commitTurn = (updater: (prev: ActivityItem[]) => ActivityItem[]) => {
      const visible = onScreen()
      live.items = updater(visible ? itemsRef.current : live.items)
      if (!visible) return
      itemsRef.current = live.items
      setItems(live.items)
    }
    commitTurn(prev => [...prev, { kind: 'message', id: nextId('msg'), role: 'user', text: outgoing }])

    const history = deriveRunHistoryHints(jobsRef.current)
    let assistantText = ''
    let committedAssistantLength = 0
    let thinkingBuffer = ''

    const flushThinking = () => {
      const thought = thinkingBuffer.trim()
      thinkingBuffer = ''
      live.partialThinking = ''
      if (onScreen()) setPartialThinking('')
      if (!thought) return
      commitTurn(prev => [...prev, { kind: 'thought', id: nextId('thought'), text: thought }])
    }

    const flushAssistantBubble = () => {
      const pending = assistantText.slice(committedAssistantLength).trim()
      committedAssistantLength = assistantText.length
      live.partialText = ''
      if (onScreen()) setPartialText('')
      if (!pending) return
      if (!displayContent('assistant', pending)) return
      commitTurn(prev => [...prev, { kind: 'message', id: nextId('msg'), role: 'assistant', text: pending }])
    }

    try {
      const result = await runIntakeStream({
        sessionId: sessionAtStart,
        message: outgoing,
        transcript,
        context: {
          recentRepos: history.recentRepos,
          recentReviewers: history.recentReviewers,
          availableWorkflows: workflowsRef.current,
          userLocale: navigator.language,
        },
        modelChoice: modelAtStart.model ? modelAtStart : undefined,
        signal: controller.signal,
        onEvent: event => {
          if (event.type === 'thinking' && event.text) {
            flushAssistantBubble()
            thinkingBuffer += event.text
            live.partialThinking = thinkingBuffer
            if (onScreen()) setPartialThinking(thinkingBuffer)
          } else if (event.type === 'token' && event.text) {
            flushThinking()
            assistantText += event.text
            live.partialText = assistantText.slice(committedAssistantLength)
            if (onScreen()) setPartialText(live.partialText)
          } else if (event.type === 'tool_start' || event.type === 'tool_end') {
            if (event.type === 'tool_start') {
              flushThinking()
              flushAssistantBubble()
            }
            commitTurn(prev => applyIntakeEvent(prev, event))
          } else if (event.type === 'done') {
            commitTurn(prev => applyIntakeEvent(prev, event))
            if (event.usage?.totalTokens) {
              live.tokens += event.usage.totalTokens
              if (onScreen()) setTotalTokens(prev => prev + event.usage!.totalTokens)
            }
            if (event.contextTokens != null) {
              live.contextUsed = event.contextTokens
              if (onScreen()) setContextUsed(event.contextTokens)
            }
          } else if (event.type === 'error') {
            commitTurn(prev => applyIntakeEvent(prev, event))
            if (event.message) {
              if (onScreen()) {
                if (event.reason === 'no-llm') setNoLlm(true)
                setError(event.message)
              }
              commitTurn(prev => [
                ...prev,
                { kind: 'notice', id: nextId('notice'), tone: 'error', text: event.message ?? 'Plan mode failed' },
              ])
            }
          }
        },
      })

      if (result.noLlm && onScreen()) {
        setNoLlm(true)
        setError(result.error ?? 'No LLM provider configured')
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Keep whatever text arrived; not an error.
      } else {
        const message = err instanceof Error ? err.message : String(err)
        if (onScreen()) setError(message)
        commitTurn(prev => [...prev, { kind: 'notice', id: nextId('notice'), tone: 'error', text: message }])
      }
    } finally {
      flushThinking()
      const committed = assistantText.trim()
      const turnReadiness = committed ? parseReadiness(committed) : null

      const finalize = (prev: ActivityItem[]): ActivityItem[] => {
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
      }

      const stillVisible = onScreen()
      const finalItems = finalize(stillVisible ? itemsRef.current : live.items)
      live.items = finalItems
      liveTurnsRef.current.delete(sessionAtStart)

      if (stillVisible) {
        itemsRef.current = finalItems
        setItems(finalItems)
        setReadiness(turnReadiness)
        setPartialText('')
        setPartialThinking('')
        setTurnCount(c => c + 1)
        busyRef.current = false
        setBusy(false)
        abortRef.current = null
      } else {
        // The developer moved on. Write the finished exchange into the
        // conversation that ran it, so reopening it shows the reply instead
        // of a turn that appears to have vanished. Counters come from the
        // values this turn started with; the runner's own session is
        // authoritative and overrides them server-side when it is still warm.
        void enqueueSnapshot({
          id: sessionAtStart,
          items: finalItems,
          readiness: turnReadiness,
          modelChoice: modelAtStart,
          turnCount: turnCountAtStart + 1,
          tokens: tokensAtStart + live.tokens,
          contextUsed: live.contextUsed,
        })
      }
      markRunning(sessionAtStart, false)
    }
    return true
  }, [enqueueSnapshot, markRunning])

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
      removeInvestigation,
      loadMoreInvestigations,
      setModelChoice,
      updateCard,
      markCardDispatched,
      persistSnapshot,
      appendNotice,
      setKnownWorkflows: setWorkflows,
      setJobs,
      setScmConnected,
      workflows,
      jobs,
      scmConnected,
      hasProgress,
      hydrated,
      switching,
      runningIds,
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
      removeInvestigation,
      loadMoreInvestigations,
      updateCard,
      markCardDispatched,
      persistSnapshot,
      appendNotice,
      workflows,
      jobs,
      scmConnected,
      hasProgress,
      hydrated,
      switching,
      runningIds,
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
