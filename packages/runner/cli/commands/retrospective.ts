/**
 * `coro retrospective` — cross-job self-analysis.
 *
 * Dispatch a run that reads this install's own job history, finds patterns
 * its agents keep struggling with, and proposes fixes. The run pauses for
 * your approval before anything is shipped, so `run` is safe to invoke and
 * then walk away from.
 */

import { Command } from 'commander'
import { apiGet, apiPost, baseUrl, die } from '../http'
import { streamJobLogs } from '../job-stream'

interface DispatchResponse {
  jobId: string
  status: string
  streamUrl: string
  error?: string
  message?: string
}

interface RetrospectiveSummary {
  jobId: string
  status: string
  phase: string
  createdAt: string
  jobWindow: number
  costUsd: number
  awaitingApproval: boolean
  findings: Array<{ id: string; title: string; category: string; severity: string }>
  outcomes: Array<{ findingId: string; destination: string; prUrl?: string; reason?: string }>
  error?: string
}

const TIER_FLAGS = ['tenant', 'upstream-intelligence', 'upstream-code'] as const

const runSubcommand = new Command('run')
  .description('Start a retrospective over recent jobs')
  .option('--window <n>', 'How many recent jobs to analyse (5–100)', '25')
  .option(
    '--tiers <list>',
    `Where approved findings may go: ${TIER_FLAGS.join(',')} (comma-separated)`,
    'tenant',
  )
  .option('--no-stream', 'Do not stream logs after dispatch')
  .action(async (opts: { window: string; tiers: string; stream: boolean }) => {
    const jobWindow = Number.parseInt(opts.window, 10)
    if (!Number.isFinite(jobWindow)) die(`--window must be a number, got "${opts.window}"`)

    const requested = opts.tiers.split(',').map(t => t.trim()).filter(Boolean)
    const unknown = requested.filter(t => !(TIER_FLAGS as readonly string[]).includes(t))
    if (unknown.length > 0) {
      die(`Unknown tier(s): ${unknown.join(', ')}. Valid tiers: ${TIER_FLAGS.join(', ')}`)
    }

    const tiers = {
      tenant: requested.includes('tenant'),
      upstreamIntelligence: requested.includes('upstream-intelligence'),
      upstreamCode: requested.includes('upstream-code'),
    }

    console.log(`\x1b[36m▸\x1b[0m Starting retrospective over the last ${jobWindow} jobs`)
    console.log(`  Ships to:    ${requested.join(', ') || 'analysis only'}`)
    console.log()

    const res = await apiPost<DispatchResponse>('/retrospectives', { jobWindow, tiers })
    if (!res.ok) {
      die(res.data.message ?? res.data.error ?? `Server returned ${res.status}`)
    }

    console.log(`\x1b[32m✓\x1b[0m Retrospective created: ${res.data.jobId}`)
    console.log(`  Status: ${res.data.status}`)
    console.log(`  Stream: ${baseUrl()}${res.data.streamUrl}`)
    console.log()
    console.log(
      '\x1b[90mThe run pauses for your approval after analysis. Review the findings, then\n' +
      `resume with: coro message --job ${res.data.jobId} --text "APPROVED: finding-1, finding-2"\x1b[0m`,
    )
    console.log()

    if (opts.stream) {
      console.log('\x1b[90m─── Live log stream (Ctrl+C to detach) ───\x1b[0m')
      streamJobLogs(res.data.jobId)
    }
  })

const listSubcommand = new Command('list')
  .description('List past retrospectives with their findings and outcomes')
  .action(async () => {
    const res = await apiGet<RetrospectiveSummary[]>('/retrospectives')
    if (!res.ok) {
      die((res.data as unknown as { error?: string }).error ?? `Server returned ${res.status}`)
    }

    const runs = Array.isArray(res.data) ? res.data : []
    if (runs.length === 0) {
      console.log('\x1b[90mNo retrospectives yet. Start one with `coro retrospective run`.\x1b[0m')
      return
    }

    console.log()
    for (const run of runs) {
      const shipped = run.outcomes.filter(o => o.prUrl).length
      console.log(`\x1b[1m${run.jobId}\x1b[0m`)
      console.log(
        `  ${run.status}${run.awaitingApproval ? ' \x1b[33m(awaiting your approval)\x1b[0m' : ''}` +
        ` · window ${run.jobWindow} · $${run.costUsd.toFixed(2)}` +
        ` · ${run.findings.length} finding(s) · ${shipped} shipped`,
      )
      for (const finding of run.findings) {
        const outcome = run.outcomes.find(o => o.findingId === finding.id)
        const landed = outcome?.prUrl ?? outcome?.reason ?? (outcome ? outcome.destination : 'not shipped')
        console.log(`    ${severityMark(finding.severity)} ${finding.title} \x1b[90m[${finding.category}] → ${landed}\x1b[0m`)
      }
      console.log()
    }
  })

export const retrospectiveCommand = new Command('retrospective')
  .description('Analyse recent jobs for systemic agent problems and propose fixes')
  .addCommand(runSubcommand)
  .addCommand(listSubcommand)

function severityMark(severity: string): string {
  if (severity === 'high') return '\x1b[31m●\x1b[0m'
  if (severity === 'medium') return '\x1b[33m●\x1b[0m'
  return '\x1b[90m●\x1b[0m'
}
