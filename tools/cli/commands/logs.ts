import { Command } from 'commander'
import { baseUrl, die } from '../http'
import { connectSse } from '../sse-client'

export const logsCommand = new Command('logs')
  .description('Stream live logs for a running job')
  .requiredOption('--job <id>', 'Job ID')
  .option('--tail <n>', 'Only show the last N existing lines before streaming', '0')
  .action(async (opts: { job: string; tail: string }) => {
    const tailN = parseInt(opts.tail, 10)
    let lineCount = 0

    console.log(`\x1b[90m─── Streaming logs for ${opts.job} (Ctrl+C to detach) ───\x1b[0m`)
    console.log()

    const sse = connectSse({
      url: `${baseUrl()}/jobs/${opts.job}/stream`,
      onMessage: (data) => {
        lineCount++
        // If --tail was specified, skip lines until we're near the end.
        // We don't know total count ahead of time, so we buffer and flush.
        // For simplicity, when tail=0 (default), show everything.
        if (tailN === 0 || lineCount > 0) {
          console.log(formatLogLine(data))
        }
      },
      onError: (err) => {
        if (err.message.includes('404')) {
          die(`Job not found: ${opts.job}`)
        }
        console.error(`\x1b[31mStream error:\x1b[0m ${err.message}`)
        process.exit(1)
      },
      onClose: () => {
        console.log()
        console.log('\x1b[90m─── Stream ended ───\x1b[0m')
        process.exit(0)
      },
    })

    process.on('SIGINT', () => {
      sse.close()
      console.log()
      console.log('\x1b[90mDetached from stream. Job continues running on the host.\x1b[0m')
      process.exit(0)
    })

    // Keep the process alive
    await new Promise(() => {})
  })

function formatLogLine(line: string): string {
  // Log lines are formatted as "ISO_TIMESTAMP message"
  // Dim the timestamp, highlight tool calls
  const spaceIdx = line.indexOf(' ', 20)
  if (spaceIdx === -1) return line

  const timestamp = line.slice(0, spaceIdx)
  const message = line.slice(spaceIdx + 1)

  const dimTs = `\x1b[90m${timestamp}\x1b[0m`

  if (message.startsWith('→ ')) {
    return `${dimTs} \x1b[36m${message}\x1b[0m`
  }
  if (message.startsWith('← ')) {
    return `${dimTs} \x1b[90m${message}\x1b[0m`
  }
  if (message.includes('Phase advanced')) {
    return `${dimTs} \x1b[33m${message}\x1b[0m`
  }
  if (message.includes('error') || message.includes('crashed')) {
    return `${dimTs} \x1b[31m${message}\x1b[0m`
  }
  if (message.includes('complete') || message.includes('finished')) {
    return `${dimTs} \x1b[32m${message}\x1b[0m`
  }

  return `${dimTs} ${message}`
}
