import { describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'
import { createBitBucketScmPlugin } from '../../src/plugins/builtin/bitbucket'
import type { PluginDeps } from '../../src/plugins/types'

// Atlassian's API tokens (`ATATT…`) have a notorious asymmetry:
//   - REST API   accepts  `<email>:ATATT…`  (Basic auth)
//   - git HTTPS  rejects  `<email>:ATATT…`  — needs `x-bitbucket-api-token-auth:ATATT…`
//
// Users discover this only after `git clone` 401s following a
// successful `curl` against api.bitbucket.org, and chase ghosts for an
// hour. The plugin auto-derives the correct git username so the user
// only configures their email + token. These tests pin that contract.

function makeDeps(): PluginDeps {
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    fatal: vi.fn(), child: () => logger,
  } as unknown as Logger
  return { logger, runnerVersion: '0.0.0-test', tenantId: 'test' } as unknown as PluginDeps
}

async function init(config: Record<string, unknown>) {
  const deps = makeDeps()
  const plugin = createBitBucketScmPlugin({ config, logger: deps.logger as Logger })
  await plugin.init(config as never, deps)
  return { plugin, deps }
}

describe('bitbucket plugin — git clone URL username derivation', () => {
  it('rewrites email username to x-bitbucket-api-token-auth for ATATT tokens', async () => {
    const { plugin, deps } = await init({
      workspace: 'acme',
      coderUsername: 'alice@example.com',
      coderToken: 'ATATT3xFfGF0DEADBEEF=ABCDEF12',
    })

    const info = plugin.cloneInfo({ repo: 'svc' })

    expect(info.url).toBe('https://bitbucket.org/acme/svc.git')
    expect(info.username).toBe('x-bitbucket-api-token-auth')
    expect(info.password).toBe('ATATT3xFfGF0DEADBEEF=ABCDEF12')
    // The user is told this happened so they're not surprised.
    expect((deps.logger.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ gitUsername: 'x-bitbucket-api-token-auth' }),
      expect.stringContaining('x-bitbucket-api-token-auth'),
    )
  })

  it('leaves a non-email username untouched even with an ATATT token', async () => {
    // User who already knows the trick and configured the synthetic
    // username explicitly. We must not double-rewrite.
    const { plugin } = await init({
      workspace: 'acme',
      coderUsername: 'x-bitbucket-api-token-auth',
      coderToken: 'ATATT3xFfGF0DEADBEEF=ABCDEF12',
    })

    const info = plugin.cloneInfo({ repo: 'svc' })
    expect(info.url).toBe('https://bitbucket.org/acme/svc.git')
    expect(info.username).toBe('x-bitbucket-api-token-auth')
    expect(info.password).toBe('ATATT3xFfGF0DEADBEEF=ABCDEF12')
  })

  it('leaves an email username untouched for a non-ATATT (App Password) token', async () => {
    // Legacy app password: email + password is the *correct* shape for
    // both REST and git. We must not "fix" what isn't broken.
    const { plugin, deps } = await init({
      workspace: 'acme',
      coderUsername: 'alice@example.com',
      coderToken: 'ATBBdeadbeef-not-an-api-token',
    })

    const info = plugin.cloneInfo({ repo: 'svc' })
    expect(info.url).toBe('https://bitbucket.org/acme/svc.git')
    expect(info.username).toBe('alice@example.com')
    expect(info.password).toBe('ATBBdeadbeef-not-an-api-token')
    expect(deps.logger.info as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('leaves x-token-auth untouched (legacy repository access token)', async () => {
    const { plugin } = await init({
      workspace: 'acme',
      coderUsername: 'x-token-auth',
      coderToken: 'BBDC-some-repository-access-token',
    })

    const info = plugin.cloneInfo({ repo: 'svc' })
    expect(info.url).toBe('https://bitbucket.org/acme/svc.git')
    expect(info.username).toBe('x-token-auth')
    expect(info.password).toBe('BBDC-some-repository-access-token')
  })
})
