/**
 * `coro campaign` — campaign-aware introspection and live controls.
 *
 * Intake (creating a campaign) goes through `coro job` exactly like a normal
 * task; the planner agent triages task-vs-campaign and the runner promotes
 * the job to the campaign workflow when needed. These subcommands operate
 * on existing campaign Jobs.
 */

import { Command } from 'commander'
import { apiGet, apiPost, die } from '../http'

const CAMPAIGN_WORKFLOW_PATH = 'workflows/campaign/workflow.md'

interface PrMapping {
  prId: number
  workItem: string
  repoSlug: string
  openedAt: string
  mergedAt?: string
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalCostUsd: number
}

interface CampaignChild {
  name: string
  description: string
  params: Record<string, unknown>
  dependsOn: string[]
  trackerRef?: { provider: string; key: string; url: string }
  jobId?: string
  status: string
  startedAt?: string
  completedAt?: string
  summary: {
    jobId: string
    type: string
    status: string
    phase: string
    workflowPath: string
    tokenUsage: TokenUsage
    prMappings: PrMapping[]
    createdAt: string
    updatedAt: string
  } | null
}

interface JobSummary {
  id: string
  type: string
  workflowPath: string
  status: string
  phase: string
  createdAt: string
  updatedAt: string
  campaignChildren?: CampaignChild[]
  campaignParentId?: string
  params: Record<string, unknown>
  tokenUsage: TokenUsage
  error?: string
}

interface CampaignActionResponse {
  ok?: boolean
  action?: string
  child?: string
  error?: string
}

// ── Subcommands ─────────────────────────────────────────────────────────────

const listSubcommand = new Command('list')
  .description('List all campaign jobs')
  .action(async () => {
    const res = await apiGet<JobSummary[]>('/jobs')
    if (!res.ok) die((res.data as unknown as { error?: string }).error ?? `Server returned ${res.status}`)

    const all = Array.isArray(res.data) ? res.data : []
    const campaigns = all.filter(j => j.workflowPath === CAMPAIGN_WORKFLOW_PATH)

    if (campaigns.length === 0) {
      console.log('\x1b[90mNo campaign jobs found.\x1b[0m')
      return
    }

    console.log()
    console.log(`\x1b[1m${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}\x1b[0m`)
    console.log()
    console.log(
      pad('ID', 40) +
      pad('STATUS', 22) +
      pad('PHASE', 18) +
      pad('CHILDREN', 10) +
      'UPDATED'
    )
    console.log('\x1b[90m' + '─'.repeat(120) + '\x1b[0m')

    for (const c of campaigns) {
      const total = c.campaignChildren?.length ?? 0
      const done = c.campaignChildren?.filter(ch => ch.status === 'complete').length ?? 0
      console.log(
        pad(c.id, 40) +
        `${colorForStatus(c.status)}${pad(c.status, 22)}\x1b[0m` +
        pad(c.phase, 18) +
        pad(`${done}/${total}`, 10) +
        relativeTime(c.updatedAt)
      )
    }
    console.log()
  })

const showSubcommand = new Command('show')
  .description('Show a campaign job, its children, and the dependency graph')
  .requiredOption('--job <id>', 'Campaign job ID')
  .action(async (opts: { job: string }) => {
    const res = await apiGet<JobSummary>(`/jobs/${opts.job}`)
    if (!res.ok) die(res.data.error ?? `Job not found: ${opts.job}`)

    const j = res.data
    if (j.workflowPath !== CAMPAIGN_WORKFLOW_PATH) {
      die(`Job ${opts.job} is not a campaign (workflowPath=${j.workflowPath}).`)
    }

    console.log()
    console.log(`\x1b[1mCampaign:\x1b[0m ${j.id}`)
    console.log(`\x1b[1mStatus:\x1b[0m  ${colorForStatus(j.status)}${j.status}\x1b[0m`)
    console.log(`\x1b[1mPhase:\x1b[0m   ${j.phase}`)
    console.log(`\x1b[1mUpdated:\x1b[0m ${new Date(j.updatedAt).toLocaleString()}`)

    const children = j.campaignChildren ?? []
    if (children.length === 0) {
      console.log()
      console.log('\x1b[90mNo children registered yet (campaign-planner has not finalized).\x1b[0m')
      console.log()
      return
    }

    console.log()
    console.log(`\x1b[1mChildren (${children.length}):\x1b[0m`)
    console.log()
    console.log(
      pad('NAME', 30) +
      pad('STATUS', 14) +
      pad('PHASE', 18) +
      pad('TRACKER', 14) +
      pad('JOB ID', 30) +
      'PRs'
    )
    console.log('\x1b[90m' + '─'.repeat(130) + '\x1b[0m')

    for (const c of children) {
      const phase = c.summary?.phase ?? '—'
      const tracker = c.trackerRef?.key ?? '—'
      const jobId = c.jobId ?? '—'
      const prs = c.summary?.prMappings.length ?? 0
      console.log(
        pad(c.name, 30) +
        `${colorForChildStatus(c.status)}${pad(c.status, 14)}\x1b[0m` +
        pad(phase, 18) +
        pad(tracker, 14) +
        pad(jobId, 30) +
        String(prs)
      )
    }

    const withDeps = children.filter(c => c.dependsOn.length > 0)
    if (withDeps.length > 0) {
      console.log()
      console.log('\x1b[1mDependencies:\x1b[0m')
      for (const c of withDeps) {
        console.log(`  ${c.name} → depends on ${c.dependsOn.join(', ')}`)
      }
    }

    const aggregate = aggregateUsage(children)
    if (aggregate.totalCostUsd > 0 || aggregate.inputTokens > 0) {
      console.log()
      console.log('\x1b[1mAggregate token usage:\x1b[0m')
      console.log(`  Input:        ${aggregate.inputTokens.toLocaleString()}`)
      console.log(`  Output:       ${aggregate.outputTokens.toLocaleString()}`)
      console.log(`  Cache read:   ${aggregate.cacheReadInputTokens.toLocaleString()}`)
      console.log(`  Cache create: ${aggregate.cacheCreationInputTokens.toLocaleString()}`)
      console.log(`  Total cost:   $${aggregate.totalCostUsd.toFixed(4)}`)
    }

    console.log()
  })

const skipSubcommand = new Command('skip')
  .description('Skip a child of a campaign (marks it complete and unblocks dependents)')
  .requiredOption('--job <id>', 'Campaign job ID')
  .requiredOption('--child <name>', 'Child name to skip')
  .option('--reason <text>', 'Reason for skipping')
  .action(async (opts: { job: string; child: string; reason?: string }) => {
    const body: Record<string, unknown> = {}
    if (opts.reason) body['reason'] = opts.reason
    const res = await apiPost<CampaignActionResponse>(
      `/jobs/${opts.job}/children/${encodeURIComponent(opts.child)}/skip`,
      body,
    )
    if (!res.ok) die(res.data.error ?? `Server returned ${res.status}`)
    console.log(`\x1b[32m✓\x1b[0m Skipped child '${opts.child}' on campaign ${opts.job}.`)
  })

const rerunSubcommand = new Command('rerun')
  .description('Re-dispatch a child after a fix or transient failure')
  .requiredOption('--job <id>', 'Campaign job ID')
  .requiredOption('--child <name>', 'Child name to rerun')
  .option('--reason <text>', 'Reason for re-running')
  .action(async (opts: { job: string; child: string; reason?: string }) => {
    const body: Record<string, unknown> = {}
    if (opts.reason) body['reason'] = opts.reason
    const res = await apiPost<CampaignActionResponse>(
      `/jobs/${opts.job}/children/${encodeURIComponent(opts.child)}/rerun`,
      body,
    )
    if (!res.ok) die(res.data.error ?? `Server returned ${res.status}`)
    console.log(`\x1b[32m✓\x1b[0m Re-dispatched child '${opts.child}' on campaign ${opts.job}.`)
  })

const cancelSubcommand = new Command('cancel')
  .description('Cancel an in-flight or pending child (bookkeeping-only — running children finish)')
  .requiredOption('--job <id>', 'Campaign job ID')
  .requiredOption('--child <name>', 'Child name to cancel')
  .option('--reason <text>', 'Reason for cancelling')
  .action(async (opts: { job: string; child: string; reason?: string }) => {
    const body: Record<string, unknown> = {}
    if (opts.reason) body['reason'] = opts.reason
    const res = await apiPost<CampaignActionResponse>(
      `/jobs/${opts.job}/children/${encodeURIComponent(opts.child)}/cancel`,
      body,
    )
    if (!res.ok) die(res.data.error ?? `Server returned ${res.status}`)
    console.log(`\x1b[32m✓\x1b[0m Cancelled child '${opts.child}' on campaign ${opts.job}.`)
  })

export const campaignCommand = new Command('campaign')
  .description('Inspect and control campaign jobs (the AI promotes a job to a campaign in planning)')
  .addCommand(listSubcommand)
  .addCommand(showSubcommand)
  .addCommand(skipSubcommand)
  .addCommand(rerunSubcommand)
  .addCommand(cancelSubcommand)

// ── Helpers ─────────────────────────────────────────────────────────────────

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len - 1) + ' ' : s + ' '.repeat(len - s.length)
}

function colorForStatus(status: string): string {
  if (status === 'complete') return '\x1b[32m'
  if (status === 'escalated' || status === 'failed') return '\x1b[31m'
  if (status.startsWith('awaiting')) return '\x1b[33m'
  return '\x1b[36m'
}

function colorForChildStatus(status: string): string {
  if (status === 'complete') return '\x1b[32m'
  if (status === 'failed' || status === 'escalated') return '\x1b[31m'
  if (status === 'skipped') return '\x1b[90m'
  if (status === 'dispatched' || status === 'ready') return '\x1b[36m'
  return '\x1b[33m'
}

function relativeTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

function aggregateUsage(children: CampaignChild[]): TokenUsage {
  const sum: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
  }
  for (const c of children) {
    const u = c.summary?.tokenUsage
    if (!u) continue
    sum.inputTokens += u.inputTokens ?? 0
    sum.outputTokens += u.outputTokens ?? 0
    sum.cacheReadInputTokens += u.cacheReadInputTokens ?? 0
    sum.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0
    sum.totalCostUsd += u.totalCostUsd ?? 0
  }
  return sum
}
