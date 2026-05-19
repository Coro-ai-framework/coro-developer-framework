import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import pino from 'pino'
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { buildPhaseHooks } from '../src/hooks'

// These tests pin the PreToolUse hook's behaviour for Bash. The hook is the
// only thing standing between an agent and arbitrary writes outside the job
// working dir, so it must (a) catch real attempts to escape, and (b) not
// reject everyday shell idioms (heredocs, /dev/null redirects, system bins,
// `//` Go comments).

const WORKING = '/tmp/coro-job-working/job-test'
const INTEL = '/tmp/coro-job-working/job-test/_intelligence'
const MEMORY = path.join(INTEL, 'memory')

function makeHook() {
  const logger = pino({ level: 'silent' })
  const hooks = buildPhaseHooks({
    liveJobRef: () => ({ phase: 'coding' }),
    workingDir: WORKING,
    coroIntelligenceDir: INTEL,
    logger,
  })
  return hooks.PreToolUse[0].hooks[0] as HookCallback
}

async function runBash(hook: HookCallback, command: string): Promise<HookJSONOutput> {
  return await hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      // Fields below are unused by the hook; cast through unknown for typing.
    } as unknown as Parameters<HookCallback>[0],
    'tool-use-id',
    { signal: new AbortController().signal },
  ) as HookJSONOutput
}

function isAllowed(out: HookJSONOutput): boolean {
  return !out.hookSpecificOutput || out.hookSpecificOutput.permissionDecision !== 'deny'
}

describe('Bash PreToolUse hook', () => {
  let hook: HookCallback
  beforeEach(() => { hook = makeHook() })

  it('allows redirects to /dev/null', async () => {
    const out = await runBash(hook, 'go build ./... 2>/dev/null')
    expect(isAllowed(out)).toBe(true)
  })

  it('allows reading system binaries', async () => {
    const out = await runBash(hook, 'which go && /usr/bin/env node --version')
    expect(isAllowed(out)).toBe(true)
  })

  it('allows /tmp and $TMPDIR-style scratch use', async () => {
    const out = await runBash(hook, 'cp file.go /tmp/scratch.go && ls /private/var/folders/abc')
    expect(isAllowed(out)).toBe(true)
  })

  it('does not flag // Go comments inside heredoc bodies', async () => {
    const command = [
      `cat > main.go << 'EOF'`,
      `package main`,
      `// This is a comment about /usr/local/bin`,
      `// More: //embedded slashes`,
      `func main() {}`,
      `EOF`,
    ].join('\n')
    const out = await runBash(hook, command)
    expect(isAllowed(out)).toBe(true)
  })

  it('does not flag // in URLs or shell comments', async () => {
    const out = await runBash(hook, 'curl https://example.com/api # fetch /etc/whatever placeholder')
    expect(isAllowed(out)).toBe(true)
  })

  it('allows Dockerfile-style ENTRYPOINT json arrays', async () => {
    const command = `cat > Dockerfile << 'EOF'\nFROM scratch\nENTRYPOINT ["/binary"]\nEOF`
    const out = await runBash(hook, command)
    expect(isAllowed(out)).toBe(true)
  })

  it('blocks writes/reads under $HOME', async () => {
    const out = await runBash(hook, 'cat $HOME/.ssh/id_rsa')
    expect(isAllowed(out)).toBe(false)
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/home-directory/)
  })

  it('blocks tilde-relative paths', async () => {
    const out = await runBash(hook, 'ls ~/Documents')
    expect(isAllowed(out)).toBe(false)
  })

  it('allows language package caches under $HOME (Go modules)', async () => {
    expect(isAllowed(await runBash(hook, 'ls ~/go/pkg/mod/github.com'))).toBe(true)
    expect(isAllowed(await runBash(hook, 'GOMODCACHE=$HOME/go/pkg/mod go env GOMODCACHE'))).toBe(true)
  })

  it('allows language package caches under $HOME (NuGet, npm, cargo, maven)', async () => {
    expect(isAllowed(await runBash(hook, 'ls ~/.nuget/packages'))).toBe(true)
    expect(isAllowed(await runBash(hook, 'cat $HOME/.npm/_logs/foo.log'))).toBe(true)
    expect(isAllowed(await runBash(hook, 'ls ${HOME}/.cargo/registry'))).toBe(true)
    expect(isAllowed(await runBash(hook, 'rm -rf ~/.m2/repository/junk'))).toBe(true)
  })

  it('blocks parent-directory traversal that escapes workingDir', async () => {
    const out = await runBash(hook, 'cat ../../../etc/passwd-like-thing')
    expect(isAllowed(out)).toBe(false)
  })

  it('allows `cd subdir && cmd ../sibling/...` when the resolved path stays inside workingDir', async () => {
    const out = await runBash(
      hook,
      'cd corolabs.kyc.go && cat "../know_your_customer/src/CoroLabs.KYC.DbMigration/Scripts/001 - Initial schema creation.sql"',
    )
    expect(isAllowed(out)).toBe(true)
  })

  it('blocks bare `cat ../sibling/...` because Bash cwd does not persist across calls', async () => {
    const out = await runBash(hook, 'cat ../know_your_customer/src/foo.sql')
    expect(isAllowed(out)).toBe(false)
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/each Bash invocation starts fresh/)
  })

  it('blocks `cd subdir && cat ../../../etc/passwd` because the resolved path still escapes', async () => {
    const out = await runBash(hook, 'cd corolabs.kyc.go && cat ../../../etc/passwd')
    expect(isAllowed(out)).toBe(false)
  })

  it('blocks polling claude task output', async () => {
    const out = await runBash(hook, 'cat /private/tmp/claude-1234/tasks/abc.output')
    expect(isAllowed(out)).toBe(false)
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/Claude runtime task output/)
  })

  it('blocks absolute paths outside the working dir that are not on the allowlist', async () => {
    const out = await runBash(hook, 'cat /Users/somebody/secret.txt')
    expect(isAllowed(out)).toBe(false)
  })

  it('allows paths inside the working dir', async () => {
    const out = await runBash(hook, `ls ${WORKING}/repo-clone`)
    expect(isAllowed(out)).toBe(true)
  })

  it('allows $PWD-relative paths inside the working dir', async () => {
    const out = await runBash(hook, 'cat $PWD/main.go')
    expect(isAllowed(out)).toBe(true)
  })
})
