import { Command } from 'commander'
import { apiPost, baseUrl, die } from '../http'
import { connectSse } from '../sse-client'

interface MigrateResponse {
  jobId: string
  type: string
  status: string
  streamUrl: string
  error?: string
}

export const migrateCommand = new Command('migrate')
  .description('Start a .NET → Go migration job')
  .requiredOption('--repo <slug>', 'BitBucket repository slug')
  .requiredOption('--projects <list>', '.NET projects to migrate (comma-separated)')
  .requiredOption('--reviewers <list>', 'PR reviewers (comma-separated usernames)')
  .requiredOption('--staging-url <url>', 'Staging base URL for comparison testing')
  .option('--service-name <name>', 'Service name (defaults to repo slug)')
  .option('--no-stream', 'Do not stream logs after dispatch')
  .action(async (opts: {
    repo: string
    projects: string
    reviewers: string
    stagingUrl: string
    serviceName?: string
    stream: boolean
  }) => {
    const projects = opts.projects.split(',').map(p => p.trim()).filter(Boolean)
    const reviewers = opts.reviewers.split(',').map(r => r.trim()).filter(Boolean)
    const serviceName = opts.serviceName ?? opts.repo

    if (projects.length === 0) die('--projects must contain at least one project')
    if (reviewers.length === 0) die('--reviewers must contain at least one reviewer')

    console.log(`\x1b[36m▸\x1b[0m Starting migration: ${serviceName}`)
    console.log(`  Repo:      ${opts.repo}`)
    console.log(`  Projects:  ${projects.join(', ')}`)
    console.log(`  Reviewers: ${reviewers.join(', ')}`)
    console.log(`  Staging:   ${opts.stagingUrl}`)
    console.log()

    const res = await apiPost<MigrateResponse>('/jobs/migrate', {
      repo: opts.repo,
      projects,
      reviewers,
      stagingUrl: opts.stagingUrl,
      serviceName,
    })

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
