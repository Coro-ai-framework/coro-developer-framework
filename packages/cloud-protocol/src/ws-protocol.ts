// ── WebSocket protocol types ──────────────────────────────────────────────────
//
// Shared between cloud gateway and runner WebSocketTransport.
// All messages are JSON-serialized WebSocket text frames.
//
// Request/response correlation uses `messageId` for RPC-style calls.
// Fire-and-forget messages omit `messageId`.

import type { JobInput, Job, Proposal, ProposalStatus, PrMapping } from './job-types'
import type { InboundEvent } from './events'

// ── Runner → Cloud messages ──────────────────────────────────────────────────

export interface WsRunnerRegister {
  type: 'runner:register'
  runnerId: string
  hostname: string
  capabilities?: string[]
}

export interface WsRunnerHeartbeat {
  type: 'runner:heartbeat'
  runnerId: string
  currentJobId?: string
  uptimeMs: number
}

// ── Runner → Cloud: state RPC requests ───────────────────────────────────────

export interface WsJobCreate {
  type: 'job:create'
  messageId: string
  data: JobInput
}

export interface WsJobGet {
  type: 'job:get'
  messageId: string
  jobId: string
}

// `patch: Partial<Job>` carries every Job field additively, including the
// stateless-executor `conversationHistory` blob (Phase 8.1). Older runners
// that don't recognise a field strip it on the receiving zod parse — adding
// new optional Job fields is wire-compatible.
export interface WsJobUpdate {
  type: 'job:update'
  messageId: string
  jobId: string
  patch: Partial<Job>
}

export interface WsJobList {
  type: 'job:list'
  messageId: string
}

export interface WsJobDelete {
  type: 'job:delete'
  messageId: string
  jobId: string
}

export interface WsJobLog {
  type: 'job:log'
  messageId?: string
  jobId: string
  lines: string[]
}

export interface WsJobLogGet {
  type: 'job:logGet'
  messageId: string
  jobId: string
  start?: number
  end?: number
}

export interface WsJobLogLength {
  type: 'job:logLength'
  messageId: string
  jobId: string
}

export interface WsJobPrMapping {
  type: 'job:prMapping'
  messageId: string
  prId: number
  jobId: string
}

export interface WsJobPrMappingAdd {
  type: 'job:prMappingAdd'
  messageId: string
  jobId: string
  mapping: PrMapping
}

export interface WsJobPrMerged {
  type: 'job:prMerged'
  messageId: string
  jobId: string
  prId: number
  mergedAt: string
}

export interface WsJobByPr {
  type: 'job:byPr'
  messageId: string
  prId: number
}

export interface WsJiraMapping {
  type: 'job:jiraMapping'
  messageId: string
  ticketId: string
  jobId: string
}

export interface WsJobByJira {
  type: 'job:byJira'
  messageId: string
  ticketId: string
}

export interface WsRepoMapping {
  type: 'job:repoMapping'
  messageId: string
  repoSlug: string
  jobId: string
}

// ── External-ref RPCs (P5+) ──────────────────────────────────────────────────
//
// Plugin-aware lookups go through these. The cloud handler resolves
// against `external_ref_mappings`; legacy `job:prMapping` /
// `job:byPr` etc. remain on the wire so one-release downgrade is
// possible.

export interface WsRefDescriptor {
  kind: string
  pluginId: string
  repoKey: string
  externalId: string
}

export interface WsJobMapExternalRef {
  type: 'job:mapExternalRef'
  messageId: string
  ref: WsRefDescriptor
  jobId: string
}

export interface WsJobByExternalRef {
  type: 'job:byExternalRef'
  messageId: string
  ref: WsRefDescriptor
}

export interface WsJobPark {
  type: 'job:park'
  messageId?: string
  jobId: string
  awaitedEvent: string
}

export interface WsJobComplete {
  type: 'job:complete'
  messageId?: string
  jobId: string
}

export interface WsProposalCreate {
  type: 'proposal:create'
  messageId: string
  data: Omit<Proposal, 'id'>
}

export interface WsProposalList {
  type: 'proposal:list'
  messageId: string
  tenantId: string
  status?: ProposalStatus
}

export interface WsProposalGet {
  type: 'proposal:get'
  messageId: string
  tenantId: string
  proposalId: string
}

export interface WsProposalUpdate {
  type: 'proposal:update'
  messageId: string
  tenantId: string
  proposalId: string
  updates: Partial<Proposal>
}

export interface WsJobListByType {
  type: 'job:listByType'
  messageId: string
  jobType: string
}

export interface WsJobListChildren {
  type: 'job:listChildren'
  messageId: string
  parentJobId: string
}

/** Union of all runner → cloud messages */
export type RunnerMessage =
  | WsRunnerRegister
  | WsRunnerHeartbeat
  | WsJobCreate
  | WsJobGet
  | WsJobUpdate
  | WsJobList
  | WsJobListByType
  | WsJobListChildren
  | WsJobDelete
  | WsJobLog
  | WsJobLogGet
  | WsJobLogLength
  | WsJobPrMapping
  | WsJobPrMappingAdd
  | WsJobPrMerged
  | WsJobByPr
  | WsJiraMapping
  | WsJobByJira
  | WsRepoMapping
  | WsJobMapExternalRef
  | WsJobByExternalRef
  | WsJobPark
  | WsJobComplete
  | WsProposalCreate
  | WsProposalList
  | WsProposalGet
  | WsProposalUpdate

// ── Cloud → Runner messages ──────────────────────────────────────────────────

export interface WsRpcResponse {
  type: 'rpc:response'
  messageId: string
  ok: boolean
  data?: unknown
  error?: string
}

export interface WsEventWebhook {
  type: 'event:webhook'
  event: InboundEvent
}

/**
 * Generic plugin-routed webhook frame (P4+).
 *
 * The cloud has zero provider knowledge: it forwards the raw HTTP
 * body and headers verbatim, tagged with the `pluginId` the request
 * URL named. The runner side resolves the matching plugin runtime
 * and calls its `normalizeInbound` to produce an
 * {@link InboundEvent} with `source: 'plugin'`.
 *
 * `rawBody` is base64-encoded so the WS frame stays text-safe
 * regardless of the original `Content-Type` (Bitbucket sends JSON
 * but other providers sometimes send `application/x-www-form-urlencoded`).
 */
export interface WsEventPluginWebhook {
  type: 'event:pluginWebhook'
  pluginId: string
  /** Lowercased header map. Multi-valued headers collapsed to first value. */
  headers: Record<string, string>
  /** Base64-encoded raw HTTP body. */
  rawBodyBase64: string
  receivedAt: string
}

export interface WsEventResume {
  type: 'event:resume'
  jobId: string
  prompt?: string
}

export interface WsEventCancel {
  type: 'event:cancel'
  jobId: string
  reason?: string
}

export interface WsEventPause {
  type: 'event:pause'
  jobId: string
  reason?: string
}

export interface WsEventMessage {
  type: 'event:message'
  jobId: string
  message: string
}

export interface WsProposalApply {
  type: 'proposal:apply'
  proposalId: string
  files: Array<{ path: string; content: string }>
}

export interface WsRunnerPing {
  type: 'runner:ping'
}

export interface WsEventDispatch {
  type: 'event:dispatch'
  jobId: string
}

/** Union of all cloud → runner messages */
export type CloudMessage =
  | WsRpcResponse
  | WsEventWebhook
  | WsEventPluginWebhook
  | WsEventResume
  | WsEventCancel
  | WsEventPause
  | WsEventMessage
  | WsEventDispatch
  | WsProposalApply
  | WsRunnerPing

// ── Helpers ──────────────────────────────────────────────────────────────────

/** All possible message types on the wire */
export type WsMessage = RunnerMessage | CloudMessage

/** Messages that expect a response (have messageId) */
export type RpcRequest = Extract<RunnerMessage, { messageId: string }>

// ── Constants ────────────────────────────────────────────────────────────────

/** Heartbeat interval (runner sends every N ms) */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** If no heartbeat received within this period, runner is considered offline */
export const HEARTBEAT_TIMEOUT_MS = 90_000

/** RPC timeout — how long the runner waits for a response from cloud */
export const RPC_TIMEOUT_MS = 30_000

/** Max RPC retries */
export const RPC_MAX_RETRIES = 3

/** Log batching interval — runner buffers log lines for this long before sending */
export const LOG_BATCH_INTERVAL_MS = 100
