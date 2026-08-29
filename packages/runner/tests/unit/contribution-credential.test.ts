// Regression origin: an oss-contribution job dispatched by a retrospective
// finished its work, then could not push it. The retrospective had created the
// fork with `upstream.token` (account A), while the job's git credential
// helper answered with the SCM plugin's token (account B), so GitHub refused
// the push to A's fork with a 403 naming B. The work was already committed by
// the time anything found out.
//
// The identity is keyed by repository rather than by job type because the
// credential helper is a separate process that never sees a job.

import { describe, expect, it } from 'vitest'
import {
  contributionCredentialCovers,
  resolveContributionCredential,
} from '../../src/config/contribution-credential'

const UPSTREAM = {
  repoUrl: 'https://github.com/Coro-ai-framework/coro-developer-framework',
  forkOwner: 'kkbrs',
  token: 'ghp_contribution',
}

describe('resolveContributionCredential', () => {
  it('claims both the fork and the upstream repo', () => {
    const credential = resolveContributionCredential(UPSTREAM)

    expect(credential).toEqual({
      host: 'github.com',
      owner: 'kkbrs',
      // The PR is cross-repository: created against upstream with a head
      // branch on the fork, so that call needs the account owning the head.
      repoSlugs: [
        'kkbrs/coro-developer-framework',
        'coro-ai-framework/coro-developer-framework',
      ],
      username: 'x-access-token',
      password: 'ghp_contribution',
    })
  })

  it('derives the fork slug the way ensureFork looks for it', () => {
    // `GitHubClient.ensureFork` looks for `<forkOwner>/<upstream repo name>`
    // and refuses to adopt anything else at that address. If this derivation
    // drifted, a job would authenticate as one account against a fork created
    // by another — the original defect.
    const credential = resolveContributionCredential({
      ...UPSTREAM,
      repoUrl: 'git@github.com:Coro-ai-framework/coro-developer-framework.git',
    })
    expect(credential?.repoSlugs).toContain('kkbrs/coro-developer-framework')
  })

  it('stays undefined without a separate token, because the plugin identity is already correct', () => {
    // No token means the fork was created with the SCM plugin's own token, so
    // there is nothing to swap. Inventing an override here would be the bug.
    expect(resolveContributionCredential({ ...UPSTREAM, token: undefined })).toBeUndefined()
    expect(resolveContributionCredential({ ...UPSTREAM, token: '  ' })).toBeUndefined()
  })

  it('stays undefined without a fork owner, since the fork is then under the plugin owner', () => {
    expect(resolveContributionCredential({ ...UPSTREAM, forkOwner: undefined })).toBeUndefined()
  })

  it('stays undefined when the install has not opted into contribution', () => {
    expect(resolveContributionCredential(undefined)).toBeUndefined()
    expect(resolveContributionCredential({ ...UPSTREAM, repoUrl: '' })).toBeUndefined()
  })

  it('does not list the same slug twice when the fork owner is the upstream owner', () => {
    const credential = resolveContributionCredential({
      ...UPSTREAM,
      forkOwner: 'Coro-ai-framework',
    })
    expect(credential?.repoSlugs).toEqual(['coro-ai-framework/coro-developer-framework'])
  })

  it('reads the host from the repo URL so a GHE install is not mistaken for github.com', () => {
    const credential = resolveContributionCredential({
      ...UPSTREAM,
      repoUrl: 'https://github.acme-corp.dev/coro/coro',
    })
    expect(credential?.host).toBe('github.acme-corp.dev')
  })
})

describe('contributionCredentialCovers', () => {
  const credential = resolveContributionCredential(UPSTREAM)!

  it('covers the fork and upstream, case-insensitively and with or without .git', () => {
    expect(contributionCredentialCovers(credential, 'kkbrs/coro-developer-framework')).toBe(true)
    expect(contributionCredentialCovers(credential, 'KKBRS/Coro-Developer-Framework.git')).toBe(true)
    expect(contributionCredentialCovers(credential, '/kkbrs/coro-developer-framework/')).toBe(true)
    expect(
      contributionCredentialCovers(credential, 'Coro-ai-framework/coro-developer-framework'),
    ).toBe(true)
  })

  it('leaves every other repository on the SCM plugin identity', () => {
    expect(contributionCredentialCovers(credential, 'A5Labs-Prime/some-service')).toBe(false)
    // Same repo name, different account: a fork of a fork is not this fork.
    expect(contributionCredentialCovers(credential, 'someone-else/coro-developer-framework'))
      .toBe(false)
  })

  it('refuses a bare repo name, which resolves against the plugin owner', () => {
    expect(contributionCredentialCovers(credential, 'coro-developer-framework')).toBe(false)
  })

  it('requires the host to match when the caller knows it', () => {
    expect(contributionCredentialCovers(credential, 'kkbrs/coro-developer-framework', 'github.com'))
      .toBe(true)
    expect(
      contributionCredentialCovers(credential, 'kkbrs/coro-developer-framework', 'gitlab.com'),
    ).toBe(false)
  })

  it('is false without a credential, so callers need no null check', () => {
    expect(contributionCredentialCovers(undefined, 'kkbrs/coro-developer-framework')).toBe(false)
  })
})
