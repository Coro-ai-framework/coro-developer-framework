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
import { applyIntakeEvent, ensurePermissionCards, type PermissionCardData } from '../components/activity/adapters/intake'
import { settleRunningEntries } from '../components/activity/group'
import { displayContent } from '../components/activity/message-block'
import type { ActivityItem } from '../components/activity/types'
import { parseFindings, looksLikeFindingsReport, currentFindingsMarkdown } from '../lib/intake-findings'
import {
  asActivityItems,
  deleteInvestigation,
  getInvestigation,
  getToolAccess,
  investigationHasProgress,
  investigationTitleFromItems,
  putInvestigation,
  putToolAccess,
  respondToPermission,
  type IntakePermissionRequest,
  type InvestigationStatus,
  type ToolAccessPatch,
  type ToolAccessView,
} from '../lib/intake-investigation'
import { parseReadiness, type Readiness } from '../lib/intake-readiness'
import { recoverIntakeReply } from '../lib/recover-intake-reply'
import { inspectRun } from '../lib/intake-run'
import { withReviewCard } from '../lib/intake-review'
import { runIntakeStream, toIntakeMessages } from '../lib/intake-stream'
import { mintSessionId } from '../lib/new-run-draft'
import { deriveRunHistoryHints } from '../lib/run-history'
import { ApiError, requestJson } from '../lib/http'
import { ensureDispatchedRunCard, jobForInvestigation } from '../lib/linked-run'
import type { ConfigResponse } from '../pages/Settings/SettingsContext'
import type { Job } from '../types'
import type { WorkflowOption } from '../workflows'
import { useRefreshWorklist } from './worklist'

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

/**
 * Ids minted in this tab for a conversation that does not exist yet. Opening
 * one starts it blank instead of asking the runner for a row it cannot have.
 */
const freshConversationIds = new Set<string>()

/** A new conversation id. Navigate to it to start a blank conversation. */
export function mintConversationId(): string {
  const id = mintSessionId()
  freshConversationIds.add(id)
  return id
}

/** Review ids the conversation's review cards started; persisted so the work list can nest them. */
function reviewIdsFromItems(items: ActivityItem[]): string[] {
  const ids: string[] = []
  for (const item of items) {
    if (item.kind !== 'card' || item.card.type !== 'review') continue
    const reviewId = (item.card.data as { reviewId?: unknown }).reviewId
    if (typeof reviewId === 'string' && reviewId && !ids.includes(reviewId)) ids.push(reviewId)
  }
  return ids
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
  /** Stop reaches a stream this page opened. A reloaded in-flight turn has no local fetch to detach. */
  canStop: boolean
  openInvestigation: (id: string) => Promise<void>
  removeInvestigation: (id: string) => Promise<void>
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
  respondToPermission: (requestId: string, body: { decision: 'once' | 'conversation' | 'always' | 'deny'; rule?: string; mode?: 'ask' | 'allow'; message?: string }) => Promise<void>
  toolAccess: ToolAccessView | null
  updateToolAccess: (patch: ToolAccessPatch) => Promise<void>
  workflows: WorkflowOption[]
  jobs: Job[]
  scmConnected: boolean
  hasProgress: boolean
  hydrated: boolean
  /** True while a conversation switch is fetching. */
  switching: boolean
  /** The conversation the URL asked for could not be loaded. */
  openError: { id: string; message: string } | null
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

/**
 * The session's stable actions. The full session value changes on every
 * streamed token; surfaces that only need to act (the work list) read this
 * instead so a streaming turn does not re-render them.
 */
export interface PlanSessionActions {
  removeInvestigation: (id: string) => Promise<void>
}

const PlanSessionActionsContext = createContext<PlanSessionActions | null>(null)

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
  /** The latest run each known conversation dispatched, as the runner recorded it. */
  const [dispatchedByConversation, setDispatchedByConversation] = useState<Record<string, string>>({})
  const [canStop, setCanStop] = useState(false)
  const [awaitingServerTurn, setAwaitingServerTurn] = useState(false)
  const [toolAccess, setToolAccess] = useState<ToolAccessView | null>(null)
  const [openError, setOpenError] = useState<{ id: string; message: string } | null>(null)

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
  const dispatchedByConversationRef = useRef(dispatchedByConversation)
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
  /** The conversation a switch is loading, while the GET is in flight. */
  const switchingToRef = useRef<string | null>(null)
  workflowsRef.current = workflows
  jobsRef.current = jobs
  modelChoiceRef.current = modelChoice
  sessionIdRef.current = sessionId
  itemsRef.current = items
  readinessRef.current = readiness
  turnCountRef.current = turnCount
  tokensRef.current = totalTokens
  contextUsedRef.current = contextUsed
  dispatchedByConversationRef.current = dispatchedByConversation
  const refreshWorklist = useRefreshWorklist()

  const commitItems = useCallback((updater: (prev: ActivityItem[]) => ActivityItem[]) => {
    const next = updater(itemsRef.current)
    itemsRef.current = next
    setItems(next)
    return next
  }, [])

  /**
   * Tracks conversations with a turn in flight, including ones the developer
   * switched away from. The work list shows the same thing from the runner;
   * nudging it here makes a turn starting or ending show up immediately.
   */
  const markRunning = useCallback((id: string, running: boolean) => {
    const was = runningIdsRef.current.has(id)
    if (was === running) return
    const next = new Set(runningIdsRef.current)
    if (running) next.add(id)
    else next.delete(id)
    runningIdsRef.current = next
    refreshWorklist()
  }, [refreshWorklist])

  const rememberDispatched = useCallback((id: string, dispatchedJobId: string | null | undefined) => {
    if (!dispatchedJobId || dispatchedByConversationRef.current[id] === dispatchedJobId) return
    const next = { ...dispatchedByConversationRef.current, [id]: dispatchedJobId }
    dispatchedByConversationRef.current = next
    setDispatchedByConversation(next)
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
        reviewIds: reviewIdsFromItems(opts.items),
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
      if (result.session) {
        rememberDispatched(opts.id, result.session.dispatchedJobId)
        refreshWorklist()
      }
    } catch (err) {
      // Autosave must not block chatting; the next turn retries. Dispatch
      // used to treat a swallowed 413 as success and then navigate away,
      // which is how a started run vanished from the conversation.
      console.warn('Failed to persist investigation snapshot', err)
    }
  }, [refreshWorklist, rememberDispatched])

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
      opts?.dispatchedJobId ?? dispatchedByConversationRef.current[sessionId],
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
    turns?: unknown
    streaming?: boolean
    turnCount: number
    tokens: number
    contextUsed: number
    readiness: Readiness | null
    modelChoice?: { provider: string; model: string }
    pendingPermissions?: IntakePermissionRequest[]
    dispatchedJobId?: string | null
  }) => {
    skipNextPersistRef.current = true
    turnGenerationRef.current += 1
    setSwitching(false)
    rememberDispatched(record.id, record.dispatchedJobId)
    switchingToRef.current = null
    // Mid-turn, the live transcript is ahead of the stored one — the row was
    // written when the conversation was parked and the turn has been running
    // since. Re-attach to it so the feed picks up where the agent actually is.
    // A reload has no live turn. `streaming` means the runner is still in it;
    // otherwise the recorded reply is folded in so the snapshot is not the
    // last thing the feed shows.
    const live = liveTurnsRef.current.get(record.id)
    const waiting = Boolean(record.streaming) && !live
    const stored = asActivityItems(record.items)
    const recovered = !live && !waiting
      ? recoverIntakeReply(
          stored,
          record.turns,
          workflowsRef.current.map(workflow => workflow.workflowPath),
        )
      : null
    const baseItems = live ? live.items : (recovered?.items ?? stored)
    const nextItems = record.pendingPermissions?.length
      ? ensurePermissionCards(baseItems, record.pendingPermissions)
      : baseItems
    sessionIdRef.current = record.id
    itemsRef.current = nextItems
    bootSessionId = record.id
    setSessionId(record.id)
    setItems(nextItems)
    setTurnCount(record.turnCount)
    setTotalTokens(record.tokens + (live?.tokens ?? 0))
    setContextUsed(live ? live.contextUsed : record.contextUsed)
    setReadiness(recovered?.readiness ?? record.readiness)
    if (record.modelChoice?.model) setModelChoice(record.modelChoice)
    abortRef.current = live?.controller ?? null
    busyRef.current = Boolean(live) || waiting
    setBusy(Boolean(live) || waiting)
    setCanStop(Boolean(live))
    setAwaitingServerTurn(waiting)
    if (!live) markRunning(record.id, waiting)
    setPartialText(live?.partialText ?? '')
    setPartialThinking(live?.partialThinking ?? '')
    setError(null)
  }, [markRunning, rememberDispatched])

  const mintEmpty = useCallback((id?: string) => {
    turnGenerationRef.current += 1
    setSwitching(false)
    // Forget the in-flight controller without aborting it. The turn belongs
    // to the conversation being parked and finishes into it; killing the
    // fetch here is what used to throw away a reply already paid for.
    abortRef.current = null
    switchingToRef.current = null
    const next = id ?? mintSessionId()
    sessionIdRef.current = next
    itemsRef.current = []
    bootSessionId = next
    setSessionId(next)
    setItems([])
    busyRef.current = false
    setBusy(false)
    setCanStop(false)
    setAwaitingServerTurn(false)
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
    void requestJson<ConfigResponse>('/config').then(data => {
      const tier =
        data.config?.llm?.aliases?.['tier:planning'] ?? data.config?.llm?.aliases?.['planning']
      if (!tier?.model) return
      setModelChoice(prev => (prev.model ? prev : { provider: tier.provider ?? '', model: tier.model }))
    }).catch(() => {
      // Non-fatal — the picker still works without a default.
    })
  }, [])

  // Which conversation is open is decided by the URL (`/plans/:id`), so there
  // is nothing to restore here; the provider is ready as soon as it mounts.
  useEffect(() => {
    setHydrated(true)
  }, [])

  // A refresh drops the browser stream. The runner keeps the turn, and GET
  // reports `streaming` until it records. Poll that, then fold the reply in.
  useEffect(() => {
    if (!awaitingServerTurn) return
    const generation = turnGenerationRef.current
    const sessionAtStart = sessionIdRef.current
    let stopped = false
    const tick = async () => {
      if (stopped || turnGenerationRef.current !== generation) return
      try {
        const full = await getInvestigation(sessionAtStart)
        if (stopped || turnGenerationRef.current !== generation || sessionIdRef.current !== sessionAtStart) return
        if (full.streaming) {
          markRunning(sessionAtStart, true)
          if (full.pendingPermissions?.length) {
            commitItems(prev => ensurePermissionCards(prev, full.pendingPermissions!))
          }
          return
        }
        applyRecord(full)
      } catch {
        // A blip must not look like the turn ended.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [awaitingServerTurn, sessionId, applyRecord, markRunning, commitItems])

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
      dispatchedByConversation[sessionId],
    )
    if (!linked) return
    const current = itemsRef.current
    const next = ensureDispatchedRunCard(current, linked)
    if (next === current) return
    commitItems(() => next)
  }, [commitItems, dispatchedByConversation, hydrated, jobs, sessionId, switching])

  const respond = useCallback(async (
    requestId: string,
    body: { decision: 'once' | 'conversation' | 'always' | 'deny'; rule?: string; mode?: 'ask' | 'allow'; message?: string },
  ) => {
    const optimistic = body.decision === 'deny' ? 'denied' : 'allowed'
    commitItems(prev => prev.map(item => {
      if (item.kind !== 'card' || item.id !== `perm-${requestId}`) return item
      const data = item.card.data as PermissionCardData
      return { ...item, card: { ...item.card, data: { ...data, status: optimistic, by: 'developer' } } }
    }))
    try {
      await respondToPermission(sessionIdRef.current, requestId, body)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        commitItems(prev => prev.map(item => {
          if (item.kind !== 'card' || item.id !== `perm-${requestId}`) return item
          const data = item.card.data as PermissionCardData
          return { ...item, card: { ...item.card, data: { ...data, status: 'expired' } } }
        }))
      }
    }
  }, [commitItems])

  const updateToolAccess = useCallback(async (patch: ToolAccessPatch) => {
    const view = await putToolAccess(sessionIdRef.current, patch)
    setToolAccess(view)
  }, [])

  const cancel = useCallback(() => {
    // A turn rediscovered after refresh has no fetch on this page. Clearing
    // busy there would let a follow-up message race the one still running.
    if (!abortRef.current) return
    for (const item of itemsRef.current) {
      if (item.kind !== 'card' || item.card.type !== 'permission') continue
      const data = item.card.data as PermissionCardData
      if (data.status !== 'pending') continue
      void respond(data.request.requestId, { decision: 'deny', message: 'The developer stopped this turn.' })
    }
    abortRef.current.abort()
    abortRef.current = null
    busyRef.current = false
    setBusy(false)
    setCanStop(false)
  }, [respond])

  const openInvestigation = useCallback(async (id: string) => {
    if (id === sessionIdRef.current) {
      setOpenError(null)
      // Back to the conversation already on screen while a switch away was
      // still loading: drop that switch, or its record lands under this URL.
      if (switchingToRef.current !== null) {
        switchingToRef.current = null
        turnGenerationRef.current += 1
        setSwitching(false)
      }
      return
    }
    if (id === switchingToRef.current) return
    turnGenerationRef.current += 1
    abortRef.current = null
    const generation = turnGenerationRef.current
    setOpenError(null)
    if (investigationHasProgress(itemsRef.current)) enqueuePersist()
    if (freshConversationIds.has(id)) {
      freshConversationIds.delete(id)
      mintEmpty(id)
      return
    }
    setSwitching(true)
    switchingToRef.current = id
    // Drain queued writes first — one of them may be a turn that just
    // finished in another conversation, and this GET could otherwise read the
    // row it is about to replace.
    await persistChainRef.current
    try {
      const full = await getInvestigation(id)
      // A later switch won while this GET was in flight. Applying now would
      // drag the developer back into a conversation they already left.
      if (turnGenerationRef.current !== generation) return
      applyRecord(full)
    } catch (err) {
      if (turnGenerationRef.current !== generation) return
      if (err instanceof ApiError && err.status === 404) {
        // An id nobody has written to yet: a link to a new conversation.
        mintEmpty(id)
        return
      }
      // Never fall back to a blank conversation under this id: the first
      // autosave would overwrite the row that failed to load.
      setOpenError({ id, message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (turnGenerationRef.current === generation) {
        switchingToRef.current = null
        setSwitching(false)
      }
    }
  }, [applyRecord, enqueuePersist, mintEmpty])

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
    if (isCurrent) mintEmpty()
    refreshWorklist()
  }, [markRunning, mintEmpty, refreshWorklist])

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
    setCanStop(true)
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
    let superseded = false
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
          } else if (event.type === 'permission_request') {
            flushThinking()
            flushAssistantBubble()
            commitTurn(prev => applyIntakeEvent(prev, event))
          } else if (event.type === 'permission_resolved') {
            commitTurn(prev => applyIntakeEvent(prev, event))
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
            if (event.reason === 'turn-in-progress') {
              superseded = true
              return
            }
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
      if (superseded) {
        const current = onScreen() ? itemsRef.current : live.items
        const rolled = current.filter((item, index) => {
          if (index !== current.length - 1) return true
          return !(item.kind === 'message' && item.role === 'user' && item.text === outgoing)
        })
        live.items = rolled
        liveTurnsRef.current.delete(sessionAtStart)
        if (onScreen()) {
          itemsRef.current = rolled
          setItems(rolled)
          setPartialText('')
          setPartialThinking('')
          busyRef.current = true
          setBusy(true)
          setCanStop(false)
          abortRef.current = null
          setAwaitingServerTurn(true)
        }
        markRunning(sessionAtStart, true)
        return false
      }
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
        const inspected = inspectRun(
          committed,
          workflowsRef.current.map(w => w.workflowPath),
        )
        if (!inspected) return next
        if (!inspected.ok) {
          // The reply already tells the developer to look below for the run,
          // so a rejected block must say so rather than leave nothing there.
          return [
            ...next,
            {
              kind: 'notice',
              id: nextId('notice'),
              tone: 'warning',
              text: `Couldn't show the run: ${inspected.reason}. Ask again, or use "Generate run".`,
            },
          ]
        }
        const parsed = inspected.run

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
      const finalItems = withReviewCard(
        finalize(stillVisible ? itemsRef.current : live.items),
        committed,
        nextId('card'),
      )
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
        setCanStop(false)
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

  useEffect(() => {
    let cancelled = false
    void getToolAccess(sessionId)
      .then(view => { if (!cancelled) setToolAccess(view) })
      .catch(() => { if (!cancelled) setToolAccess(null) })
    return () => { cancelled = true }
  }, [sessionId, busy])

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
      canStop,
      openInvestigation,
      removeInvestigation,
      setModelChoice,
      updateCard,
      markCardDispatched,
      persistSnapshot,
      appendNotice,
      setKnownWorkflows: setWorkflows,
      setJobs,
      setScmConnected,
      respondToPermission: respond,
      toolAccess,
      updateToolAccess,
      workflows,
      jobs,
      scmConnected,
      hasProgress,
      hydrated,
      switching,
      openError,
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
      canStop,
      openInvestigation,
      removeInvestigation,
      updateCard,
      markCardDispatched,
      persistSnapshot,
      appendNotice,
      respond,
      toolAccess,
      updateToolAccess,
      workflows,
      jobs,
      scmConnected,
      hasProgress,
      hydrated,
      switching,
      openError,
    ],
  )

  const actions = useMemo<PlanSessionActions>(() => ({ removeInvestigation }), [removeInvestigation])

  return (
    <PlanSessionActionsContext.Provider value={actions}>
      <PlanSessionContext.Provider value={value}>{children}</PlanSessionContext.Provider>
    </PlanSessionActionsContext.Provider>
  )
}

export function usePlanSession(): PlanSessionApi {
  const context = useContext(PlanSessionContext)
  if (!context) {
    throw new Error('usePlanSession must be used inside PlanSessionProvider')
  }
  return context
}

export function usePlanSessionActions(): PlanSessionActions {
  const context = useContext(PlanSessionActionsContext)
  if (!context) throw new Error('usePlanSessionActions must be used inside PlanSessionProvider')
  return context
}
