import { Command } from 'commander'
import { apiPost, baseUrl, die } from '../http'
import { connectSse } from '../sse-client'

interface ResumeResponse {
  jobId?: string
  status?: string
  error?: string
}

export const resumeCommand = new Command('resume')
  .description('Manually resume a parked job (simulate a webhook event)')
  .requiredOption('--job <id>', 'Job ID to resume')
  .option('--event <key>', 'Event key to inject (default: manual-resume)', 'manual-resume')
  .option('--no-stream', 'Do not stream logs after resume')
  .action(async (opts: { job: string; event: string; stream: boolean }) => {
    console.log(`\x1b[36m▸\x1b[0m Resuming job: ${opts.job}`)
    console.log(`  Event: ${opts.event}`)
    console.log()

    const res = await apiPost<ResumeResponse>(`/jobs/${opts.job}/resume`, {
      eventKey: opts.event,
    })

    if (!res.ok) {
      die(res.data.error ?? `Server returned ${res.status}`)
    }

    console.log(`\x1b[32m✓\x1b[0m Job resumed`)
    console.log()

    if (opts.stream) {
      console.log('\x1b[90m─── Live log stream (Ctrl+C to detach) ───\x1b[0m')
      streamLogs(opts.job)
    }
  })

function streamLogs(jobId: string): void {
  const sse = connectSse({
    url: `${baseUrl()}/jobs/${jobId}/stream`,
    onMessage: (data) => console.log(data),
    onError: (err) => {
      console.error(`\x1b[31mStream error:\x1b[0m ${err.message}`)
      process.exit(1)
    },
    onClose: () => {
      console.log('\n\x1b[90m─── Stream ended ───\x1b[0m')
      process.exit(0)
    },
  })

  process.on('SIGINT', () => {
    sse.close()
    console.log('\n\x1b[90mDetached from stream. Job continues running on the host.\x1b[0m')
    process.exit(0)
  })
}
