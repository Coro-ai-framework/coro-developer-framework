import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
  real,
} from 'drizzle-orm/pg-core'

// ── Enums ─────────────────────────────────────────────────────────────────────

export const teamRoleEnum = pgEnum('team_role', ['admin', 'member'])
export const jobTypeEnum = pgEnum('job_type', ['migration', 'feature', 'self-update'])
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
  currentFeature: text('current_feature'),

  features: jsonb('features').notNull().$type<unknown[]>().default([]),
  featureLoopCount: integer('feature_loop_count').notNull().default(0),

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
  awaitingEvent: text('awaiting_event'),
  awaitingPrId: integer('awaiting_pr_id'),
  escalationMessage: text('escalation_message'),
  pendingPrompt: text('pending_prompt'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('jobs_team_id_idx').on(t.teamId),
  index('jobs_team_status_idx').on(t.teamId, t.status),
  index('jobs_type_idx').on(t.type),
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

// ── PR mappings ───────────────────────────────────────────────────────────────

export const prMappings = pgTable('pr_mappings', {
  prId: integer('pr_id').primaryKey(),
  jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
})

// ── Jira mappings ─────────────────────────────────────────────────────────────

export const jiraMappings = pgTable('jira_mappings', {
  ticketId: text('ticket_id').primaryKey(),
  jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
})

// ── Webhook configs ───────────────────────────────────────────────────────────

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
