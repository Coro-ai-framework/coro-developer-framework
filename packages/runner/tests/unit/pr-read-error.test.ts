import { describe, it, expect } from 'vitest'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import { GitHubError } from '../../src/clients/github'
import { describePrReadError } from '../../src/reviews/pr-read-error'

const ref: ExternalRef = {
  kind: 'pull_request',
  pluginId: 'github',
  repoKey: 'acme-corp/private-api',
  externalId: '103',
  url: 'https://github.com/acme-corp/private-api/pull/103',
}

describe('describePrReadError', () => {
  it('tells the user to reconnect when the saved token is rejected', () => {
    const message = describePrReadError(new GitHubError(401, '{"message":"Bad credentials"}'), ref, 'GitHub')
    expect(message).toContain('GitHub rejected the saved credentials')
    expect(message).toContain('Settings → Integrations → GitHub')
  })

  it('reads a 404 as the wrong account rather than a missing pull request', () => {
    const message = describePrReadError(new GitHubError(404, '{"message":"Not Found"}'), ref, 'GitHub')
    expect(message).toContain('cannot see https://github.com/acme-corp/private-api/pull/103')
    expect(message).toContain('can access acme-corp')
    expect(message).toContain('approve the GitHub CLI')
  })

  it('keeps the provider message for other failures', () => {
    expect(describePrReadError(new GitHubError(502, 'Bad Gateway'), ref, 'GitHub'))
      .toBe('Could not read https://github.com/acme-corp/private-api/pull/103: GitHub 502: Bad Gateway')
  })
})
