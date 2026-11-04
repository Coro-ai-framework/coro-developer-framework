import { Command } from 'commander'
import { apiGet, apiPost, die } from '../http'

export const reviewCommand = new Command('review')
  .description('Review a pull request. Rounds run until the PR merges or closes. Coro never merges it.')

reviewCommand
  .command('list')
  .description('List reviews on this runner')
  .option('--status <status>', 'Filter by status')
  .action(async (opts: { status?: string }) => {
    const query = opts.status ? `?status=${encodeURIComponent(opts.status)}` : ''
    const res = await apiGet<unknown[]>(`/reviews${query}`)
    if (!res.ok) die(`Server returned ${res.status}`)
    console.log(JSON.stringify(res.data, null, 2))
  })

reviewCommand
  .command('show')
  .argument('<id>', 'Review id')
  .action(async (id: string) => {
    const res = await apiGet(`/reviews/${encodeURIComponent(id)}`)
    if (!res.ok) die(`Server returned ${res.status}`)
    console.log(JSON.stringify(res.data, null, 2))
  })

reviewCommand
  .command('run')
  .description('Start a review, or run one round in CI with --once')
  .requiredOption('--pr <url>', 'Pull request URL or owner/repo#n')
  .option('--once', 'Headless: one round, state stored on the PR, no server')
  .option('--fail-on <level>', 'With --once, exit 2 when an open finding is at this severity (blocker)')
  .action(async (opts: { pr: string; once?: boolean; failOn?: string }) => {
    if (opts.once) {
      const { runHeadless } = await import('./review-once')
      const code = await runHeadless(opts.pr, opts.failOn)
      process.exit(code)
    }
    const res = await apiPost<{ id?: string; error?: string }>('/reviews', { prUrl: opts.pr })
    if (!res.ok || !res.data.id) die(res.data.error ?? 'Could not start review')
    console.log(res.data.id)
  })

reviewCommand
  .command('pause')
  .argument('<id>')
  .action(async (id: string) => {
    const res = await apiPost(`/reviews/${encodeURIComponent(id)}/pause`, {})
    if (!res.ok) die(`Server returned ${res.status}`)
    console.log(JSON.stringify(res.data))
  })

reviewCommand
  .command('resume')
  .argument('<id>')
  .action(async (id: string) => {
    const res = await apiPost(`/reviews/${encodeURIComponent(id)}/resume`, {})
    if (!res.ok) die(`Server returned ${res.status}`)
    console.log(JSON.stringify(res.data))
  })

reviewCommand
  .command('verdict')
  .argument('<id>')
  .option('--submit', 'Post the held verdict')
  .option('--discard', 'Drop the held verdict')
  .action(async (id: string, opts: { submit?: boolean; discard?: boolean }) => {
    const action = opts.discard ? 'discard' : 'submit'
    const res = await apiPost(`/reviews/${encodeURIComponent(id)}/verdict`, { action })
    if (!res.ok) die(`Server returned ${res.status}`)
    console.log(JSON.stringify(res.data))
  })
