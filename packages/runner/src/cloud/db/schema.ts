// SPDX-License-Identifier: LicenseRef-Coro-Commercial-1.0

import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
  primaryKey,
  real,
} from 'drizzle-orm/pg-core'

// ── Enums ─────────────────────────────────────────────────────────────────────

export const teamRoleEnum = pgEnum('team_role', ['admin', 'member'])
export const jobTypeEnum = pgEnum('job_type', ['job', 'self-update', 'retrospective'])
export const triggerSourceEnum = pgEnum('trigger_source', ['cli', 'jira', 'internal'])
export const proposalStatusEnum = pgEnum('proposal_status', ['pending', 'approved', 'rejected'])
export const webhookProviderEnum = pgEnum('webhook_provider', ['bitbucket', 'github', 'jira'])

// ── Users ─────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  oauthProvider: text('oauth_provider'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Teams ─────────────────────────────────────────────────────────────────────

export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Team members ──────────────────────────────────────────────────────────────

export const teamMembers = pgTable('team_members', {
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: teamRoleEnum('role').notNull().default('member'),
  invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
  joinedAt: timestamp('joined_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('team_members_pk').on(t.teamId, t.userId),
])

// ── Runner tokens ─────────────────────────────────────────────────────────────

export const runnerTokens = pgTable('runner_tokens', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

// ── Jobs ──────────────────────────────────────────────────────────────────────

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  type: jobTypeEnum('type').notNull(),
  workflowPath: text('workflow_path').notNull(),
  params: jsonb('params').notNull().$type<Record<string, unknown>>(),
  triggerSource: triggerSourceEnum('trigger_source').notNull().default('cli'),

  status: text('status').notNull(),
  phase: text('phase').notNull(),
  currentWorkItem: text('current_feature'),

  workItems: jsonb('features').notNull().$type<unknown[]>().default([]),
  workItemLoopCount: integer('feature_loop_count').notNull().default(0),

  prMappings: jsonb('pr_mappings').notNull().$type<unknown[]>().default([]),
  insights: jsonb('insights').notNull().$type<unknown[]>().default([]),

  // Token usage
  tokenUsageInput: integer('token_usage_input').notNull().default(0),
  tokenUsageOutput: integer('token_usage_output').notNull().default(0),
  tokenUsageCacheRead: integer('token_usage_cache_read').notNull().default(0),
  tokenUsageCacheCreation: integer('token_usage_cache_creation').notNull().default(0),
  tokenUsageCostUsd: real('token_usage_cost_usd').notNull().default(0),
  phaseUsage: jsonb('phase_usage').notNull().$type<unknown[]>().default([]),

  sessionId: text('session_id'),
  // Conversation replay history for stateless executors (e.g. OpenAI / Gemini)
  // that don't support server-side session resume. Persisted as JSON; only the
  // executor that wrote it interprets the contents on resume. Anthropic-backed
  // jobs leave this null and resume by sessionId alone. See Phase 8.1 of the
  // multi-provider plan and `Job.conversationHistory` in jobs/types.ts.
  conversationHistory: jsonb('conversation_history').$type<unknown[] | null>(),
  awaitingEvent: text('awaiting_event'),
  awaitingPrId: integer('awaiting_pr_id'),
  escalationMessage: text('escalation_message'),
  pendingPrompt: text('pending_prompt'),

  // Previously persisted only in the in-memory Job blob; needed for
  // multi-day jobs that reload from Postgres. `artifacts` is the post_artifact
  // payloads; `awaitingNextPhase` / `approvedAdvanceFromPhase` carry
  // interactive-checkpoint hand-off state across restarts.
  artifacts: jsonb('artifacts').notNull().$type<unknown[]>().default([]),
  awaitingNextPhase: text('awaiting_next_phase'),
  approvedAdvanceFromPhase: text('approved_advance_from_phase'),

  // Campaign coordination. `campaignChildren` is null on task jobs; non-null
  // and possibly empty on campaign jobs (presence is the discriminator).
  // `campaignParentId` is the back-pointer from a child Job to its campaign,
  // indexed for efficient `listChildJobs(parentId)` queries.
  campaignChildren: jsonb('campaign_children').$type<unknown[] | null>(),
  campaignParentId: text('campaign_parent_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('jobs_team_id_idx').on(t.teamId),
  index('jobs_team_status_idx').on(t.teamId, t.status),
  index('jobs_type_idx').on(t.type),
  index('jobs_campaign_parent_idx').on(t.campaignParentId),
])

// ── Job logs ──────────────────────────────────────────────────────────────────

export const jobLogs = pgTable('job_logs', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  lineNumber: integer('line_number').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('job_logs_job_id_idx').on(t.jobId),
  uniqueIndex('job_logs_job_line_idx').on(t.jobId, t.lineNumber),
])

// ── Proposals ─────────────────────────────────────────────────────────────────

export const proposals = pgTable('proposals', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  jobId: text('job_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  rationale: text('rationale').notNull(),
  description: text('description').notNull(),
  status: proposalStatusEnum('status').notNull().default('pending'),
  files: jsonb('files').notNull().$type<unknown[]>().default([]),
  reviewedBy: text('reviewed_by'),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('proposals_tenant_id_idx').on(t.tenantId),
  index('proposals_tenant_status_idx').on(t.tenantId, t.status),
])

// ── Plan-mode investigations ──────────────────────────────────────────────────
//
// Durable New Run conversations. `data` is the full Investigation JSON;
// `status` / `updated_at` exist so listing does not have to unpack every blob
// for sort, and `team_id` scopes hybrid installs the same way jobs do.

export const investigations = pgTable('investigations', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull().$type<Record<string, unknown>>(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('investigations_team_updated_idx').on(t.teamId, t.updatedAt),
])

// ── PR mappings ───────────────────────────────────────────────────────────────
//
// Primary key is composite `(teamId, prId)` so two teams sharing the cloud
// DB can map the same numeric PR id (across different repositories) to
// different jobs without collision. Earlier revisions used `prId` as the
// global PK which caused cross-team aliasing — see plan/team-mode P1/G6.

export const prMappings = pgTable('pr_mappings', {
  prId: integer('pr_id').notNull(),
  jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ name: 'pr_mappings_pk', columns: [t.teamId, t.prId] }),
  index('pr_mappings_team_idx').on(t.teamId),
])

// ── Jira mappings ─────────────────────────────────────────────────────────────
//
// Same rationale as `prMappings`: composite PK `(teamId, ticketId)` so
// two teams using the same Jira keyspace don't overwrite each other's
// mappings. The cross-team risk is lower than for PR ids (Jira keys are
// usually unique per company), but the schema treats both consistently.

export const jiraMappings = pgTable('jira_mappings', {
  ticketId: text('ticket_id').notNull(),
  jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ name: 'jira_mappings_pk', columns: [t.teamId, t.ticketId] }),
  index('jira_mappings_team_idx').on(t.teamId),
])

// ── External ref mappings (plugin-aware, P5+) ─────────────────────────────────
//
// Single home for every plugin-rooted lookup the runner cares about
// (PR ids, ticket keys, future kinds). Replaces both `prMappings`
// and `jiraMappings` over the deprecation window — those two tables
// stay around for one release as fallbacks (read-side adapters in
// `PostgresStateBackend.getJobByPr` / `getJobByJiraTicket` look here
// first and fall back).
//
// Composite PK `(teamId, pluginId, kind, repoKey, externalId)`:
//   - `teamId` for tenant isolation (same as the other mapping
//     tables — two teams with the same provider must not collide).
//   - `pluginId` so the same external id under different plugins
//     stays distinct (`github` PR 42 vs `bitbucket` PR 42).
//   - `kind` discriminates `pull_request` / `ticket` / future kinds.
//   - `repoKey` is REQUIRED for `pull_request` (enforced at the
//     runtime layer via `repoKeyForStorage`). For kinds where repo
//     is not meaningful, the column stores the empty string.

export const externalRefMappings = pgTable('external_ref_mappings', {
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  kind: text('kind').notNull(),
  repoKey: text('repo_key').notNull().default(''),
  externalId: text('external_id').notNull(),
  jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({
    name: 'external_ref_mappings_pk',
    columns: [t.teamId, t.pluginId, t.kind, t.repoKey, t.externalId],
  }),
  index('external_ref_mappings_team_idx').on(t.teamId),
  index('external_ref_mappings_job_idx').on(t.jobId),
])

// ── Webhook configs ───────────────────────────────────────────────────────────
//
// Legacy table: keyed by `(teamId, provider)` where `provider` is the
// `webhookProviderEnum`. P4 deprecates this in favour of
// `tenant_plugin_webhooks` (below) which is plugin-aware (the cloud
// no longer needs to know what `provider` even means). Both tables
// coexist for one release so existing tenants keep working while the
// runner can be configured against either; P9 drops this one and the
// enum.

export const webhookConfigs = pgTable('webhook_configs', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  provider: webhookProviderEnum('provider').notNull(),
  secret: text('secret').notNull(),
  endpointUrl: text('endpoint_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('webhook_configs_team_provider_idx').on(t.teamId, t.provider),
])

// ── Tenant plugin webhooks ────────────────────────────────────────────────────
//
// The cloud control plane is provider-agnostic post-P4: it accepts
// `POST /webhook/:teamId/:pluginId`, loads the row keyed by `(teamId,
// pluginId)` here, validates the HMAC using `algorithm`/`header`/`format`,
// and forwards the raw payload to the runner over WS. The runner's
// plugin's `normalizeInbound` does all shape-aware work; the cloud
// holds zero plugin knowledge.
//
// Fields mirror the four pieces every HMAC scheme exposes — algorithm
// (one of the three we support today), the header where the signature
// lives, the secret, and the wire `format` (e.g. `sha256=<hex>` for
// GitHub, `<plain>` for "no HMAC, rely on URL secret"). Plugins that
// don't authenticate via HMAC at all (Jira webhook variant) set
// `algorithm = 'none'` — the verifier short-circuits to "ok".

export const tenantPluginWebhooks = pgTable('tenant_plugin_webhooks', {
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  algorithm: text('algorithm').notNull(),
  header: text('header').notNull(),
  secret: text('secret').notNull(),
  format: text('format').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'tenant_plugin_webhooks_pk', columns: [t.teamId, t.pluginId] }),
  index('tenant_plugin_webhooks_team_idx').on(t.teamId),
])
