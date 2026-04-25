import { Command } from 'commander'
import { apiPost, die } from '../http'

interface MessageResponse {
  sent?: boolean
  jobId?: string
  error?: string
}

export const messageCommand = new Command('message')
  .description('Send a message to a running agent')
  .requiredOption('--job <id>', 'Job ID')
  .argument('<text>', 'Message text to send to the agent')
  .action(async (text: string, opts: { job: string }) => {
    const res = await apiPost<MessageResponse>(`/jobs/${opts.job}/message`, {
      message: text,
    })

    if (!res.ok) {
      die(res.data.error ?? `Server returned ${res.status}`)
    }

    console.log(`\x1b[32m✓\x1b[0m Message sent to agent (job: ${opts.job})`)
  })
