import { Command } from 'commander'
import { apiGet, die } from '../http'

interface JobSummary {
  id: string
  type: string
  serviceName: string | null
  status: string
  phase: string
  currentWorkItem: string | null
  triggerSource: string
  prCount: number
  createdAt: string
  updatedAt: string
}

interface JobsResponse {
  jobs: JobSummary[]
  count: number
  error?: string
}

export const jobsCommand = new Command('jobs')
  .description('List all jobs')
  .option('--type <type>', 'Filter by job type (migration, feature, self-update)')
  .action(async (opts: { type?: string }) => {
    const query = opts.type ? `?type=${opts.type}` : ''
    const res = await apiGet<JobsResponse>(`/jobs${query}`)

    if (!res.ok) {
      die(res.data.error ?? `Server returned ${res.status}`)
    }

    const { jobs, count } = res.data

    if (count === 0) {
      console.log('\x1b[90mNo jobs found.\x1b[0m')
      return
    }

    console.log()
    console.log(`\x1b[1m${count} job${count !== 1 ? 's' : ''}\x1b[0m`)
    console.log()

    // Table header
    console.log(
      pad('ID', 40) +
      pad('TYPE', 12) +
      pad('STATUS', 22) +
      pad('PHASE', 16) +
      pad('SERVICE', 20) +
      'UPDATED'
    )
    console.log('\x1b[90m' + '─'.repeat(130) + '\x1b[0m')

    for (const j of jobs) {
      const statusColor = colorForStatus(j.status)
      console.log(
        pad(j.id, 40) +
        pad(j.type, 12) +
        `${statusColor}${pad(j.status, 22)}\x1b[0m` +
        pad(j.phase, 16) +
        pad(String(j.serviceName ?? '—'), 20) +
        formatTime(j.updatedAt)
      )
    }
    console.log()
  })

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len - 1) + ' ' : s + ' '.repeat(len - s.length)
}

function colorForStatus(status: string): string {
  if (status === 'complete') return '\x1b[32m'
  if (status === 'escalated' || status === 'failed') return '\x1b[31m'
  if (status.startsWith('awaiting')) return '\x1b[33m'
  return '\x1b[36m'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`

  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`

  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}
