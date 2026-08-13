// ── REST API contract — `/api/v1/teams/:teamId/jobs/*` ───────────────────────
//
// Zod schemas + TS types for the cloud control plane's job REST surface.
// Phase B implements the server using these schemas at the boundary
// (request parsing). Phase D imports the same schemas in the cloud
// `JobsClient` so dashboard / CLI calls share one source of truth for
// shape, route, and method.
//
// Design rules:
//   1. INPUTS (path params, query params, request bodies) are strictly
//      validated. Forward-compat is opted-in per schema via `.passthrough()`
//      on fields where we expect to add optional members.
//   2. OUTPUTS (response bodies) are typed via the protocol interfaces
//      (`Job`, `Proposal`, …) rather than schema-validated, because they
//      are constructed server-side from already-typed objects — validating
//      them at egress would just duplicate the TS compiler's work.
//   3. The endpoint catalogue (`JOBS_REST_ROUTES`) is the single source
//      of truth for method + path; the Express server mounts off it and
//      the typed client builds URLs from it.

import { z } from 'zod'
import type { Job } from './job-types'

// ── Shared schemas ────────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.string(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const TeamPathParamsSchema = z.object({
  teamId: z.string().min(1),
})
export type TeamPathParams = z.infer<typeof TeamPathParamsSchema>

export const JobPathParamsSchema = z.object({
  teamId: z.string().min(1),
  jobId: z.string().min(1),
})
export type JobPathParams = z.infer<typeof JobPathParamsSchema>

/**
 * Gateway routing hint surfaced on resume/pause/message responses.
 * - `job`   — delivered to the runner already running this jobId
 * - `team`  — delivered to a team runner that picked it up on connect
 * - `queued`— no runner online, frame buffered until next register
 */
export const GatewayRouteSchema = z.enum(['job', 'team', 'queued'])
export type GatewayRoute = z.infer<typeof GatewayRouteSchema>

// ── POST /jobs — create ──────────────────────────────────────────────────────

/**
 * Mirrors `CreateJobRequest` in `runner/src/jobs/creation.ts`. Kept loose
 * (`.passthrough()`) so a new optional field added on the runner side
 * does not require a synchronous schema bump here.
 */
export const JobCreateBodySchema = z
  .object({
    workflowPath: z.string().min(1).optional(),
    triggerSource: z.enum(['cli', 'webhook', 'manual', 'campaign']).optional(),
    repo: z.string().optional(),
    serviceName: z.string().optional(),
    description: z.string().optional(),
    reviewers: z.array(z.string()).optional(),
    gitProvider: z.enum(['bitbucket', 'github']).optional(),
    jiraTicketId: z.string().optional(),
    interactive: z.boolean().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    type: z.enum(['job', 'campaign', 'self-update', 'retrospective']).optional(),
  })
  .passthrough()
export type JobCreateBody = z.infer<typeof JobCreateBodySchema>
export type JobCreateResponse = Job & { warning?: string }

// ── GET /jobs — list ─────────────────────────────────────────────────────────

export type JobListResponse = Job[]

// ── GET /jobs/:jobId — get ───────────────────────────────────────────────────

export type JobGetResponse = Job

// ── PATCH /jobs/:jobId — update ──────────────────────────────────────────────
//
// Body is `Partial<Job>`. We do not zod-validate it here: callers should
// be typed via the `Job` interface and the server applies it through the
// state backend, which is the authoritative validator.

export type JobUpdateResponse = Job

// ── POST /jobs/:jobId/dispatch ───────────────────────────────────────────────

export const JobDispatchResponseSchema = z.object({
  dispatched: z.literal(true),
  jobId: z.string(),
})
export type JobDispatchResponse = z.infer<typeof JobDispatchResponseSchema>

// ── POST /jobs/:jobId/resume ─────────────────────────────────────────────────

export const JobResumeBodySchema = z
  .object({
    prompt: z.string().optional(),
  })
  .passthrough()
export type JobResumeBody = z.infer<typeof JobResumeBodySchema>

export const JobResumeResponseSchema = z.object({
  resumed: z.literal(true),
  jobId: z.string(),
  route: GatewayRouteSchema,
})
export type JobResumeResponse = z.infer<typeof JobResumeResponseSchema>

// ── POST /jobs/:jobId/cancel ─────────────────────────────────────────────────

export const JobCancelBodySchema = z
  .object({
    reason: z.string().optional(),
  })
  .passthrough()
export type JobCancelBody = z.infer<typeof JobCancelBodySchema>

export const JobCancelResponseSchema = z.object({
  cancelled: z.literal(true),
  jobId: z.string(),
  status: z.string(),
})
export type JobCancelResponse = z.infer<typeof JobCancelResponseSchema>

// ── POST /jobs/:jobId/pause ──────────────────────────────────────────────────

export const JobPauseBodySchema = z
  .object({
    reason: z.string().optional(),
  })
  .passthrough()
export type JobPauseBody = z.infer<typeof JobPauseBodySchema>

export const JobPauseResponseSchema = z.object({
  paused: z.literal(true),
  jobId: z.string(),
  route: GatewayRouteSchema,
})
export type JobPauseResponse = z.infer<typeof JobPauseResponseSchema>

// ── POST /jobs/:jobId/message ────────────────────────────────────────────────

export const JobMessageBodySchema = z.object({
  message: z.string().min(1),
})
export type JobMessageBody = z.infer<typeof JobMessageBodySchema>

export const JobMessageResponseSchema = z.object({
  accepted: z.literal(true),
  jobId: z.string(),
  route: GatewayRouteSchema,
})
export type JobMessageResponse = z.infer<typeof JobMessageResponseSchema>

// ── POST /jobs/:jobId/logs — append log lines ────────────────────────────────

export const JobLogAppendBodySchema = z.object({
  lines: z.array(z.string()),
})
export type JobLogAppendBody = z.infer<typeof JobLogAppendBodySchema>

// ── GET /jobs/:jobId/stream — SSE log + status events ────────────────────────
//
// Server-Sent Event `data:` payloads. The transport framing (`data: …\n\n`,
// `: heartbeat\n\n` comments) is handled by the SSE plumbing; this schema
// describes what the parsed JSON inside each `data:` frame looks like.

export const SseLogEventSchema = z.object({
  type: z.literal('log'),
  line: z.string(),
})
export const SseStatusEventSchema = z.object({
  type: z.literal('status'),
  status: z.string(),
})
export const SseStreamEventSchema = z.discriminatedUnion('type', [
  SseLogEventSchema,
  SseStatusEventSchema,
])
export type SseStreamEvent = z.infer<typeof SseStreamEventSchema>

// ── Endpoint catalogue ───────────────────────────────────────────────────────
//
// Source of truth for HTTP method + path. The server mounts routes off
// the suffix (under `REST_BASE_PATH`); the client builds URLs by
// substituting `:teamId` / `:jobId` into the path template.

/** Base path prefix; per-route `path` values are relative to this. */
export const REST_BASE_PATH = '/api/v1/teams/:teamId/jobs'

export const JOBS_REST_ROUTES = {
  list:     { method: 'GET'    as const, path: ''                  },
  create:   { method: 'POST'   as const, path: ''                  },
  get:      { method: 'GET'    as const, path: '/:jobId'           },
  update:   { method: 'PATCH'  as const, path: '/:jobId'           },
  delete:   { method: 'DELETE' as const, path: '/:jobId'           },
  dispatch: { method: 'POST'   as const, path: '/:jobId/dispatch'  },
  resume:   { method: 'POST'   as const, path: '/:jobId/resume'    },
  cancel:   { method: 'POST'   as const, path: '/:jobId/cancel'    },
  pause:    { method: 'POST'   as const, path: '/:jobId/pause'     },
  message:  { method: 'POST'   as const, path: '/:jobId/message'   },
  logs:     { method: 'POST'   as const, path: '/:jobId/logs'      },
  stream:   { method: 'GET'    as const, path: '/:jobId/stream'    },
} as const

export type JobsRestRouteKey = keyof typeof JOBS_REST_ROUTES
