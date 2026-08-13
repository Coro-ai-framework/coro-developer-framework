import { baseUrl } from './http'
import { connectSse } from './sse-client'

/**
 * Attach to a job's SSE log stream after dispatching it, and keep the
 * process alive until the stream closes or the user detaches with Ctrl+C.
 *
 * Shared by every command that dispatches something and then follows it.
 * `coro logs` deliberately does not use this — it owns extra presentation
 * (line formatting, `--tail`) that a post-dispatch follow does not need.
 */
export function streamJobLogs(jobId: string): void {
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
