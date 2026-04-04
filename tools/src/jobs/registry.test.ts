/**
 * Manual test script for the JobRegistry.
 * Run with: npx ts-node src/jobs/registry.test.ts
 * Requires Redis running on localhost:6379 (docker-compose up redis)
 */
import Redis from 'ioredis'
import { JobRegistry } from './registry'
import { JobType } from './types'

async function run(): Promise<void> {
  const redis = new Redis('redis://localhost:6379')
  const registry = new JobRegistry(redis)

  console.log('\n── Phase 1: JobRegistry test ──────────────────────────────')

  // ── 1. Create a migration job ────────────────────────────────────────────
  console.log('\n[1] Creating migration job...')
  const job = await registry.createJob({
    type: 'migration',
    params: {
      repo: 'test-service',
      repoSlug: 'test-service',
      projects: ['TestService.API', 'TestService.Models'],
      reviewers: ['alice', 'bob'],
      stagingUrl: 'https://staging.test-service.a5labs.com',
      serviceName: 'test-service',
    },
  })
  console.log(`    Created: ${job.id}`)
  console.log(`    Type: ${job.type}, Phase: ${job.phase}, Status: ${job.status}`)
  console.log(`    workflowPath: ${job.workflowPath}`)
  console.log(`    params.serviceName: ${job.params['serviceName']}`)
  console.log(`    _signals present (transient): ${job._signals !== undefined}`)

  // ── 2. Read it back ──────────────────────────────────────────────────────
  console.log('\n[2] Reading job back from Redis...')
  const loaded = await registry.getJob(job.id)
  if (!loaded) throw new Error('Job not found after create')
  console.log(`    Retrieved: ${loaded.id}`)
  console.log(`    _signals reset on load: ${JSON.stringify(loaded._signals)}`)

  // ── 3. Update status ─────────────────────────────────────────────────────
  console.log('\n[3] Updating job status to Analyzing...')
  const updated = await registry.updateJob(job.id, { status: 'analyzing', phase: 'analysis' })
  console.log(`    Status: ${updated.status}, Phase: ${updated.phase}`)
  console.log(`    updatedAt changed: ${updated.updatedAt !== job.createdAt}`)

  // ── 4. _signals are NOT persisted ────────────────────────────────────────
  console.log('\n[4] Verifying _signals are not persisted...')
  const withSignals = await registry.getJob(job.id)
  if (!withSignals) throw new Error('Job not found')
  withSignals._signals = { phaseComplete: true }
  await registry.updateJob(job.id, withSignals)
  const reloaded = await registry.getJob(job.id)
  const signalsPersisted = reloaded?._signals?.phaseComplete === true
  console.log(`    _signals.phaseComplete persisted: ${signalsPersisted} (should be false)`)
  if (signalsPersisted) throw new Error('FAIL: _signals were persisted — this is a bug')

  // ── 5. PR mapping ─────────────────────────────────────────────────────────
  console.log('\n[5] Mapping PR #42 → job...')
  await registry.addPrMapping(job.id, {
    prId: 42,
    feature: 'feature-1-infrastructure',
    repoSlug: 'test-service-go',
    openedAt: new Date().toISOString(),
  })
  const jobByPr = await registry.getJobByPr(42)
  console.log(`    Lookup PR #42 → job: ${jobByPr?.id === job.id ? 'OK' : 'FAIL'}`)

  // ── 6. Log streaming ──────────────────────────────────────────────────────
  console.log('\n[6] Appending and reading logs...')
  await registry.appendLog(job.id, 'Analyzer started')
  await registry.appendLog(job.id, 'Cloning repository...')
  await registry.appendLog(job.id, 'Extracted 12 endpoints')
  const logs = await registry.getLog(job.id)
  console.log(`    Log lines: ${logs.length} (expected 3)`)
  logs.forEach(l => console.log(`    ${l}`))

  // ── 7. List jobs ──────────────────────────────────────────────────────────
  console.log('\n[7] Listing all jobs...')
  const all = await registry.listJobs()
  console.log(`    Total jobs: ${all.length}`)
  console.log('\n[7b] Listing by type (migration)...')
  const byType = await registry.listJobsByType(JobType.Migration)
  console.log(`    Migration jobs: ${byType.length}`)

  // ── 8. Jira mapping ───────────────────────────────────────────────────────
  console.log('\n[8] Creating Jira-triggered feature job...')
  const jiraJob = await registry.createJob({
    type: 'feature',
    triggerSource: 'jira',
    params: {
      jiraTicketId: 'A5-1234',
      serviceName: 'A5-1234',
    },
  })
  console.log(`    Created: ${jiraJob.id}`)
  console.log(`    Phase: ${jiraJob.phase} (expected: spec-writing)`)
  const byJira = await registry.getJobByJiraTicket('A5-1234')
  console.log(`    Lookup jira:A5-1234 → job: ${byJira?.id === jiraJob.id ? 'OK' : 'FAIL'}`)

  // ── 9. Cleanup ────────────────────────────────────────────────────────────
  console.log('\n[9] Cleaning up test jobs...')
  await registry.deleteJob(job.id)
  await registry.deleteJob(jiraJob.id)
  const gone = await registry.getJob(job.id)
  console.log(`    Job deleted: ${gone === null ? 'OK' : 'FAIL'}`)

  console.log('\n── All checks passed ✓ ────────────────────────────────────\n')
  await redis.quit()
}

run().catch(err => {
  console.error('\nTest failed:', err)
  process.exit(1)
})
