import { Command } from 'commander'
import { apiGet, die } from '../http'

interface JobDetail {
  id: string
  type: string
  status: string
  phase: string
  workflowPath: string
  triggerSource: string
  currentFeature: string | null
  params: Record<string, unknown>
  prMappings: Array<{
    prId: number
    feature: string
    repoSlug: string
    openedAt: string
    mergedAt?: string
  }>
  sessionId?: string
  awaitingEvent?: string
  awaitingPrId?: number
  escalationMessage?: string
  createdAt: string
  updatedAt: string
  error?: string
}

export const statusCommand = new Command('status')
  .description('Show detailed status of a job')
  .requiredOption('--job <id>', 'Job ID')
  .action(async (opts: { job: string }) => {
    const res = await apiGet<JobDetail>(`/jobs/${opts.job}`)

    if (!res.ok) {
      die(res.data.error ?? `Job not found: ${opts.job}`)
    }

    const j = res.data
    const statusColor = colorForStatus(j.status)

    console.log()
    console.log(`\x1b[1mJob:\x1b[0m ${j.id}`)
    console.log(`\x1b[1mType:\x1b[0m ${j.type}`)
    console.log(`\x1b[1mStatus:\x1b[0m ${statusColor}${j.status}\x1b[0m`)
    console.log(`\x1b[1mPhase:\x1b[0m ${j.phase}`)
    console.log(`\x1b[1mWorkflow:\x1b[0m ${j.workflowPath}`)
    console.log(`\x1b[1mTrigger:\x1b[0m ${j.triggerSource}`)

    if (j.params['serviceName']) {
      console.log(`\x1b[1mService:\x1b[0m ${j.params['serviceName']}`)
    }

    if (j.currentFeature) {
      console.log(`\x1b[1mFeature:\x1b[0m ${j.currentFeature}`)
    }

    if (j.awaitingEvent) {
      console.log(`\x1b[1mAwaiting:\x1b[0m ${j.awaitingEvent}${j.awaitingPrId ? ` (PR #${j.awaitingPrId})` : ''}`)
    }

    if (j.escalationMessage) {
      console.log(`\x1b[1mEscalation:\x1b[0m \x1b[33m${j.escalationMessage}\x1b[0m`)
    }

    console.log(`\x1b[1mCreated:\x1b[0m ${formatTime(j.createdAt)}`)
    console.log(`\x1b[1mUpdated:\x1b[0m ${formatTime(j.updatedAt)}`)

    if (j.prMappings.length > 0) {
      console.log()
      console.log(`\x1b[1mPull Requests (${j.prMappings.length}):\x1b[0m`)
      for (const pr of j.prMappings) {
        const merged = pr.mergedAt ? `\x1b[32m merged ${formatTime(pr.mergedAt)}\x1b[0m` : '\x1b[33m open\x1b[0m'
        console.log(`  PR #${pr.prId} — ${pr.feature} (${pr.repoSlug}) ${merged}`)
      }
    }

    console.log()
  })

function colorForStatus(status: string): string {
  if (status === 'complete') return '\x1b[32m'
  if (status === 'escalated' || status === 'failed') return '\x1b[31m'
  if (status.startsWith('awaiting')) return '\x1b[33m'
  return '\x1b[36m'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString()
}
