// ── Local SCM plugin ─────────────────────────────────────────────────────────
//
// Local mode is the zero-configuration path a first-time user takes, so its
// failure modes are the ones a new install hits first. The properties pinned
// here are the ones that make it a real provider rather than a stub: the
// branch actually lands in the user's repository, review comments round-trip,
// merging does not touch their working tree, and the simulated PR store
// cannot be steered out of `~/.coro/local-scm/`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import pino from 'pino'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import type { ScmPluginRuntime } from '../../src/plugins/types'

const logger = pino({ level: 'silent' })

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-C', cwd, ...args],
    { encoding: 'utf-8' },
  ).trim()
}

describe('local SCM plugin', () => {
  let tmpHome: string
  let priorHome: string | undefined
  let createLocalScmPlugin: (args: {
    config: Record<string, unknown>
    logger: typeof logger
  }) => ScmPluginRuntime
  let storeRoot: string

  beforeAll(async () => {
    // The store root is resolved from `os.homedir()` when the module loads, so
    // $HOME has to be redirected before the import.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-local-scm-home-'))
    priorHome = process.env.HOME
    process.env.HOME = tmpHome
    storeRoot = path.join(tmpHome, '.coro', 'local-scm')
    ;({ createLocalScmPlugin } = await import('../../src/plugins/builtin/local'))
  })

  afterAll(() => {
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  let workspace: string
  let originRepo: string
  let checkout: string
  let plugin: ScmPluginRuntime

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-local-scm-'))

    // The user's repository: a normal, non-bare checkout on their machine.
    originRepo = path.join(workspace, 'my-service')
    fs.mkdirSync(originRepo)
    git(originRepo, 'init', '--initial-branch=main')
    fs.writeFileSync(path.join(originRepo, 'README.md'), 'hello\n')
    git(originRepo, 'add', '.')
    git(originRepo, 'commit', '-m', 'initial')

    // The job's throwaway clone, which is where the agent works.
    checkout = path.join(workspace, 'job-checkout')
    execFileSync('git', ['clone', originRepo, checkout], { encoding: 'utf-8' })
    git(checkout, 'checkout', '-b', 'coro/add-feature')
    fs.writeFileSync(path.join(checkout, 'feature.txt'), 'work\n')
    git(checkout, 'add', '.')
    git(checkout, 'commit', '-m', 'add feature')

    plugin = createLocalScmPlugin({ config: {}, logger })
    await plugin.init({}, { logger, fetch: globalThis.fetch })
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(storeRoot, { recursive: true, force: true })
  })

  async function openPr(): Promise<ExternalRef> {
    return plugin.createPr({
      repoSlug: originRepo,
      sourceBranch: 'coro/add-feature',
      targetBranch: 'main',
      title: 'Add feature',
      description: 'body',
      sourceCheckoutDir: checkout,
    })
  }

  it('pushes the job branch into the user repository', async () => {
    const ref = await openPr()

    expect(ref.pluginId).toBe('local')
    expect(ref.repoKey).toBe(originRepo)
    // The branch — not the JSON record — is the actual deliverable.
    const sha = git(originRepo, 'rev-parse', 'coro/add-feature')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(git(checkout, 'rev-parse', 'coro/add-feature')).toBe(sha)
  })

  it('refuses to open a pull request without a job checkout to push from', async () => {
    await expect(
      plugin.createPr({
        repoSlug: originRepo,
        sourceBranch: 'coro/add-feature',
        targetBranch: 'main',
        title: 'Add feature',
        description: 'body',
      }),
    ).rejects.toThrow(/no job checkout/i)
  })

  it('rejects a repository reference that is not a local git checkout', async () => {
    await expect(
      plugin.createPr({
        repoSlug: 'acme/my-service',
        sourceBranch: 'coro/add-feature',
        targetBranch: 'main',
        title: 'Add feature',
        description: 'body',
        sourceCheckoutDir: checkout,
      }),
    ).rejects.toThrow(/must be absolute/i)
  })

  it('round-trips review comments and replies', async () => {
    const ref = await openPr()

    const comment = await plugin.postPrComment!(ref, 'Please rename this')
    const reply = await plugin.replyToComment!(ref, comment.id, 'Renamed')

    const comments = await plugin.listPrComments!(ref)
    expect(comments.map(c => c.body)).toEqual(['Please rename this', 'Renamed'])
    expect(reply.parentId).toBe(comment.id)

    const status = await plugin.getPrStatus(ref)
    expect(status.commentCount).toBe(2)
  })

  it('surfaces a reply to a comment that does not exist', async () => {
    const ref = await openPr()
    await expect(plugin.replyToComment!(ref, '99', 'orphan')).rejects.toThrow(/no comment 99/)
  })

  it('records approvals', async () => {
    const ref = await openPr()
    await plugin.approvePr!(ref)
    expect((await plugin.getPrStatus(ref)).approvalCount).toBe(1)
  })

  it('leaves the user repository untouched when the pull request is merged', async () => {
    const ref = await openPr()
    const mainBefore = git(originRepo, 'rev-parse', 'main')

    await plugin.mergePr!(ref)

    // Merging is the human's job; Coro only records the state so agents can
    // stop waiting. Rewriting a branch the user may have checked out would be
    // destructive and is deliberately not done.
    expect(git(originRepo, 'rev-parse', 'main')).toBe(mainBefore)
    expect(git(originRepo, 'status', '--porcelain')).toBe('')
    expect((await plugin.getPrStatus(ref)).state).toBe('merged')
  })

  it('keeps the pull-request store inside the coro directory', async () => {
    await openPr()

    const files = fs.readdirSync(storeRoot)
    expect(files).toHaveLength(1)
    // The repo key is a filesystem path; it must be flattened into a single
    // file name rather than recreating the path under the store root.
    expect(files[0]).not.toContain(path.sep)
    expect(fs.existsSync(path.join(storeRoot, files[0]!))).toBe(true)
  })
})
