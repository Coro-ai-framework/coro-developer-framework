// ── WebSocket protocol types ──────────────────────────────────────────────────
//
// Shared between cloud gateway and runner WebSocketTransport.
// All messages are JSON-serialized WebSocket text frames.
//
// Request/response correlation uses `messageId` for RPC-style calls.
// Fire-and-forget messages omit `messageId`.

import type { JobInput, Job, Proposal, ProposalStatus, PrMapping } from '../jobs/types'
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

export interface WsEventResume {
  type: 'event:resume'
  jobId: string
  prompt?: string
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
  | WsEventResume
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
