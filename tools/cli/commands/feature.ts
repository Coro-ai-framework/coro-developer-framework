import { Command } from 'commander'
import { apiPost, baseUrl, die } from '../http'
import { connectSse } from '../sse-client'

interface FeatureResponse {
  jobId: string
  type: string
  status: string
  streamUrl: string
  error?: string
}

export const featureCommand = new Command('feature')
  .description('Start a feature implementation job')
  .option('--repo <slug>', 'Repository slug')
  .option('--reviewers <list>', 'PR reviewers (comma-separated usernames)')
  .option('--description <text>', 'Feature description')
  .option('--service-name <name>', 'Service name (defaults to repo slug)')
  .option('--git-provider <provider>', 'Git provider: github or bitbucket (defaults to the configured provider from ~/.a5/config.json)')
  .option('--jira-ticket <id>', 'Jira ticket ID (triggers Jira-driven workflow)')
  .option('--no-stream', 'Do not stream logs after dispatch')
  .action(async (opts: {
    repo?: string
    reviewers?: string
    description?: string
    serviceName?: string
    gitProvider?: string
    jiraTicket?: string
    stream: boolean
  }) => {
    let body: Record<string, unknown>

    if (opts.jiraTicket) {
      console.log(`\x1b[36m▸\x1b[0m Starting feature from Jira ticket: ${opts.jiraTicket}`)
      body = { jiraTicketId: opts.jiraTicket }
    } else {
      if (!opts.repo) die('--repo is required (or use --jira-ticket)')
      if (!opts.reviewers) die('--reviewers is required (or use --jira-ticket)')
      if (!opts.description) die('--description is required (or use --jira-ticket)')

      const reviewers = opts.reviewers!.split(',').map(r => r.trim()).filter(Boolean)
      const serviceName = opts.serviceName ?? opts.repo!

      console.log(`\x1b[36m▸\x1b[0m Starting feature: ${serviceName}`)
      console.log(`  Repo:        ${opts.repo}`)
      if (opts.gitProvider) console.log(`  Provider:    ${opts.gitProvider}`)
      console.log(`  Reviewers:   ${reviewers.join(', ')}`)
      console.log(`  Description: ${opts.description!.slice(0, 80)}`)
      console.log()

      body = {
        repo: opts.repo,
        reviewers,
        description: opts.description,
        serviceName,
        // Only include when set so the server falls back to the configured
        // provider in ~/.a5/config.json when the flag is omitted.
        ...(opts.gitProvider ? { gitProvider: opts.gitProvider } : {}),
      }
    }

    const res = await apiPost<FeatureResponse>('/jobs/feature', body)

    if (!res.ok) {
      die(res.data.error ?? `Server returned ${res.status}`)
    }

    console.log(`\x1b[32m✓\x1b[0m Job created: ${res.data.jobId}`)
    console.log(`  Status: ${res.data.status}`)
    console.log(`  Stream: ${baseUrl()}${res.data.streamUrl}`)
    console.log()

    if (opts.stream) {
      console.log('\x1b[90m─── Live log stream (Ctrl+C to detach) ───\x1b[0m')
      streamLogs(res.data.jobId)
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
