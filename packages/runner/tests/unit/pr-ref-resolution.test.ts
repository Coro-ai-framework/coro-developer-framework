// Resolving "which job owns this PR event?"
//
// Regression origin: a GitHub PR approval was delivered by the poller and
// silently went nowhere. The job had parked via `await_event('pr:approved',
// prId: 5)`, which only wrote the legacy by-number table — the PR itself was
// opened through the provider's MCP server, not `scm_create_pr`, so no
// plugin-aware row existed. Resolution then fell back to a by-number search
// that matched a *Bitbucket* PR #5 in a completely different repo, belonging
// to an unrelated job. The real job stayed parked forever.
//
// PR numbers restart at 1 in every repository, so "#5" is never an identity
// on its own. These tests pin the three properties that make resolution safe:
// the exact lookup wins, the by-number fallback prefers the unambiguous row,
// and a candidate naming the wrong repo is rejected rather than woken.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import pino from 'pino'
import { SqliteStateBackend } from '../../src/state/sqlite-backend'
import {
  buildPrExternalRef,
  jobContradictsRef,
  resolveJobByExternalRef,
} from '../../src/plugins/refs'
import type { ExternalRef, Job } from '@coro-ai/cloud-protocol'
import { resolveIntelligenceRoot } from '../integration/repo-root'

const noopLogger = pino({ level: 'silent' })

const OUR_REPO = 'A5Labs-Prime/a5labs.dashboard-api-go'
const OTHER_REPO = 'a5labs.kyc.go'

function githubPrRef(repoKey: string, prId: number): ExternalRef {
  return { kind: 'pull_request', pluginId: 'github', repoKey, externalId: String(prId) }
}

describe('PR event → job resolution', () => {
  let tmpDir: string
  let backend: SqliteStateBackend

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-pr-ref-test-'))
    backend = new SqliteStateBackend(
      path.join(tmpDir, 'test.db'),
      resolveIntelligenceRoot(),
      noopLogger,
    )
    await backend.initialize()
  })

  afterEach(() => {
    backend.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** The production shape: our job parked on PR #5 with only a legacy mapping. */
  async function seedProductionScenario(): Promise<{ ours: Job; theirs: Job }> {
    const theirs = await backend.createJob({
      type: 'job',
      triggerSource: 'cli',
      params: { serviceName: 'kyc', repoSlug: OTHER_REPO },
    })
    // Their PR was opened through `scm_create_pr`, so it has a plugin-aware row.
    await backend.mapExternalRef(
      { kind: 'pull_request', pluginId: 'bitbucket', repoKey: OTHER_REPO, externalId: '5' },
      theirs.id,
    )

    const ours = await backend.createJob({
      type: 'job',
      triggerSource: 'cli',
      params: { serviceName: 'dashboard-api-go', repoSlug: OUR_REPO },
    })
    // Ours parked via `await_event`, which writes only the by-number table.
    await backend.mapPrToJob(5, ours.id)

    return { ours, theirs }
  }

  it('routes the approval to the job that owns the repo, not another repo with the same PR number', async () => {
    const { ours } = await seedProductionScenario()

    const resolved = await resolveJobByExternalRef(backend, githubPrRef(OUR_REPO, 5))

    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe(ours.id)
  })

  it('drops the event rather than waking an unrelated job when nothing owns the ref', async () => {
    const theirs = await backend.createJob({
      type: 'job',
      triggerSource: 'cli',
      params: { serviceName: 'kyc', repoSlug: OTHER_REPO },
    })
    await backend.mapPrToJob(5, theirs.id)

    // No job owns PR #5 in our repo. The by-number fallback finds theirs,
    // which names a different repo — waking it would be strictly wrong.
    const resolved = await resolveJobByExternalRef(backend, githubPrRef(OUR_REPO, 5))

    expect(resolved).toBeNull()
  })

  it('prefers the exact plugin-aware row over any by-number guess', async () => {
    const { ours } = await seedProductionScenario()
    await backend.mapExternalRef(githubPrRef(OUR_REPO, 5), ours.id)

    const resolved = await resolveJobByExternalRef(backend, githubPrRef(OUR_REPO, 5))

    expect(resolved!.id).toBe(ours.id)
  })

  it('still resolves a PR registered only through the plugin-aware table', async () => {
    const job = await backend.createJob({
      type: 'job',
      triggerSource: 'cli',
      params: { serviceName: 'svc', repoSlug: 'acme/widget' },
    })
    await backend.mapExternalRef(githubPrRef('acme/widget', 12), job.id)

    const resolved = await resolveJobByExternalRef(backend, githubPrRef('acme/widget', 12))

    expect(resolved!.id).toBe(job.id)
  })

  it('resolves a legacy job that records no repo at all', async () => {
    // Nothing to contradict — these must keep working.
    const job = await backend.createJob({
      type: 'job',
      triggerSource: 'cli',
      params: { serviceName: 'svc' },
    })
    await backend.mapPrToJob(31, job.id)

    const resolved = await resolveJobByExternalRef(backend, githubPrRef('acme/widget', 31))

    expect(resolved!.id).toBe(job.id)
  })
})

describe('jobContradictsRef', () => {
  function job(params: Record<string, unknown>, prMappings: Job['prMappings'] = []): Job {
    return { params, prMappings } as Job
  }

  it('accepts differing spellings of the same repo', () => {
    const ref = githubPrRef(OUR_REPO, 5)
    expect(jobContradictsRef(job({ repoSlug: 'a5labs.dashboard-api-go' }), ref)).toBe(false)
    expect(jobContradictsRef(job({ repoSlug: OUR_REPO }), ref)).toBe(false)
    expect(jobContradictsRef(job({ repo: `https://github.com/${OUR_REPO}.git` }), ref)).toBe(false)
  })

  it('rejects a genuinely different repo', () => {
    expect(jobContradictsRef(job({ repoSlug: OTHER_REPO }), githubPrRef(OUR_REPO, 5))).toBe(true)
  })

  it('matches against any of the job\'s PR mappings, not just its params', () => {
    const multiRepo = job({ repoSlug: 'acme/first' }, [
      { prId: 5, repoSlug: 'acme/second', workItem: 'w', openedAt: '' },
    ])
    expect(jobContradictsRef(multiRepo, githubPrRef('acme/second', 5))).toBe(false)
    expect(jobContradictsRef(multiRepo, githubPrRef('acme/first', 5))).toBe(false)
    expect(jobContradictsRef(multiRepo, githubPrRef('acme/third', 5))).toBe(true)
  })

  it('never rejects when there is nothing to compare', () => {
    expect(jobContradictsRef(job({ serviceName: 'svc' }), githubPrRef(OUR_REPO, 5))).toBe(false)
    expect(
      jobContradictsRef(job({ repoSlug: OUR_REPO }), {
        kind: 'pull_request', pluginId: 'github', externalId: '5',
      }),
    ).toBe(false)
  })
})

// The poller and the park path must derive byte-identical refs, or the exact
// lookup misses and every event degrades to the by-number fallback.
describe('buildPrExternalRef', () => {
  const github = { manifest: { id: 'github' } }
  const bitbucket = { manifest: { id: 'bitbucket' } }
  const plugins = {
    resolveByRemote: (url: string) =>
      (/github/i.test(url) ? github : undefined) as never,
    default: () => bitbucket as never,
  }

  function job(params: Record<string, unknown>, prMappings: Job['prMappings'] = []): Job {
    return { params, prMappings } as Job
  }

  it('addresses the PR by the job\'s repo', () => {
    const ref = buildPrExternalRef(job({ repoSlug: OUR_REPO }), 5, plugins)
    expect(ref).toEqual({
      kind: 'pull_request',
      pluginId: 'bitbucket',
      repoKey: OUR_REPO,
      externalId: '5',
    })
  })

  it('picks the plugin that claims the remote over the registry default', () => {
    const ref = buildPrExternalRef(job({ repoSlug: 'https://github.com/acme/widget' }), 5, plugins)
    expect(ref!.pluginId).toBe('github')
  })

  it('prefers the mapping for this specific PR on a multi-repo job', () => {
    const multiRepo = job({ repoSlug: 'acme/params-repo' }, [
      { prId: 4, repoSlug: 'acme/other', workItem: 'w', openedAt: '' },
      { prId: 5, repoSlug: 'acme/wanted', workItem: 'w', openedAt: '' },
    ])
    expect(buildPrExternalRef(multiRepo, 5, plugins)!.repoKey).toBe('acme/wanted')
  })

  it('returns null when the job names no repo', () => {
    expect(buildPrExternalRef(job({ serviceName: 'svc' }), 5, plugins)).toBeNull()
  })
})
