import { Command } from 'commander'
import { apiPost, die } from '../http'

interface CancelResponse {
  cancelled?: boolean
  jobId?: string
  status?: string
  error?: string
}

export const cancelCommand = new Command('cancel')
  .description('Cancel a job so it stops at the next safe boundary and does not resume automatically')
  .requiredOption('--job <id>', 'Job ID')
  .option('--reason <text>', 'Optional cancellation reason to append to the job log')
  .action(async (opts: { job: string; reason?: string }) => {
    const res = await apiPost<CancelResponse>(`/jobs/${opts.job}/cancel`, {
      ...(opts.reason ? { reason: opts.reason } : {}),
    })

    if (!res.ok) {
      die(res.data.error ?? `Server returned ${res.status}`)
    }

    console.log(`\x1b[32m✓\x1b[0m Job cancelled (job: ${opts.job})`)
  })
