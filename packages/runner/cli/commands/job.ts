import { Command } from 'commander'
import { apiPost, baseUrl, die } from '../http'
import { streamJobLogs } from '../job-stream'

const IMPLEMENTATION_WORKFLOW_PATH = 'workflows/job/workflow.md'

interface JobResponse {
  jobId: string
  type: string
  status: string
  streamUrl: string
  error?: string
}

export const jobCommand = new Command('job')
  .description('Start a generic implementation job')
  .option('--repo <slug>', 'Repository slug')
  .option('--reviewers <list>', 'PR reviewers (comma-separated usernames)')
  .option('--description <text>', 'Job description')
  .option('--service-name <name>', 'Service name (defaults to repo slug)')
  .option('--git-provider <provider>', 'Git provider: github or bitbucket (defaults to the configured provider from ~/.coro/config.json)')
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
      console.log(`\x1b[36m▸\x1b[0m Starting implementation job from Jira ticket: ${opts.jiraTicket}`)
      body = {
        type: 'job',
        workflowPath: IMPLEMENTATION_WORKFLOW_PATH,
        jiraTicketId: opts.jiraTicket,
      }
    } else {
      if (!opts.repo) die('--repo is required (or use --jira-ticket)')
      if (!opts.reviewers) die('--reviewers is required (or use --jira-ticket)')
      if (!opts.description) die('--description is required (or use --jira-ticket)')

      const reviewers = opts.reviewers.split(',').map(r => r.trim()).filter(Boolean)
      const serviceName = opts.serviceName ?? opts.repo

      console.log(`\x1b[36m▸\x1b[0m Starting implementation job: ${serviceName}`)
      console.log(`  Repo:        ${opts.repo}`)
      if (opts.gitProvider) console.log(`  Provider:    ${opts.gitProvider}`)
      console.log(`  Reviewers:   ${reviewers.join(', ')}`)
      console.log(`  Description: ${opts.description.slice(0, 80)}`)
      console.log()

      body = {
        type: 'job',
        workflowPath: IMPLEMENTATION_WORKFLOW_PATH,
        repo: opts.repo,
        reviewers,
        description: opts.description,
        serviceName,
        ...(opts.gitProvider ? { gitProvider: opts.gitProvider } : {}),
      }
    }

    const res = await apiPost<JobResponse>('/jobs', body)

    if (!res.ok) {
      die(res.data.error ?? `Server returned ${res.status}`)
    }

    console.log(`\x1b[32m✓\x1b[0m Job created: ${res.data.jobId}`)
    console.log(`  Status: ${res.data.status}`)
    console.log(`  Stream: ${baseUrl()}${res.data.streamUrl}`)
    console.log()

    if (opts.stream) {
      console.log('\x1b[90m─── Live log stream (Ctrl+C to detach) ───\x1b[0m')
      streamJobLogs(res.data.jobId)
    }
  })