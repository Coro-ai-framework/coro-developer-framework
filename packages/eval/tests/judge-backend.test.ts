import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeCliComplete, parseClaudeCliReply, runJudge, selectJudgeBackend } from '../src/grade/judge'
import { findOnPath, PACKAGE_ROOT, runProcess } from '../src/util'
import { tmpDir } from './helpers/tmp'

const ok = { exitCode: 0, timedOut: false, stderr: '' }

const reviewJson = JSON.stringify({
  scores: { correctness: 4, scopeDiscipline: 5, readability: 4, testQuality: 3, risk: 4 },
  issues: [{ severity: 'minor', file: 'src/a.ts', summary: 'a loop could be a map' }],
  summary: 'fine',
})

/**
 * A stand-in for the `claude` CLI: records how it was started (arguments, stdin,
 * environment, working directory) into `recordDir`, then prints `output`.
 */
function fakeClaude(recordDir: string, output: string, exitCode = 0): string {
  const dir = tmpDir()
  const script = path.join(dir, 'claude')
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${recordDir}/args.txt'`,
      `cat > '${recordDir}/stdin.txt'`,
      `env > '${recordDir}/env.txt'`,
      `pwd -P > '${recordDir}/cwd.txt'`,
      `cat <<'__REPLY__'`,
      output,
      '__REPLY__',
      `exit ${exitCode}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return script
}

const cliResult = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra })

describe('parseClaudeCliReply', () => {
  it('returns the result text', () => {
    expect(parseClaudeCliReply({ ...ok, stdout: cliResult('hello') })).toBe('hello')
  })

  it('finds the result at the end of a message list', () => {
    const stdout = JSON.stringify([{ type: 'system' }, { type: 'assistant' }, { type: 'result', is_error: false, result: 'last' }])
    expect(parseClaudeCliReply({ ...ok, stdout })).toBe('last')
  })

  it('turns an error result into an error carrying the CLI\'s own message', () => {
    // What `claude -p` prints (with exit code 1) for a rejected token.
    const stdout = JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' })
    expect(() => parseClaudeCliReply({ exitCode: 1, timedOut: false, stderr: '', stdout })).toThrow(/401 OAuth access token is invalid/)
  })

  it('explains output that is not JSON, using stderr when there is any', () => {
    expect(() => parseClaudeCliReply({ exitCode: 127, timedOut: false, stdout: '', stderr: 'claude: not found' })).toThrow(/exited 127 without a JSON result: claude: not found/)
    expect(() => parseClaudeCliReply({ exitCode: 0, timedOut: false, stdout: 'plain text', stderr: '' })).toThrow(/without a JSON result: plain text/)
  })

  it('reports a timeout, a missing result and a result without text', () => {
    expect(() => parseClaudeCliReply({ exitCode: null, timedOut: true, stdout: '', stderr: '' })).toThrow(/timed out/)
    expect(() => parseClaudeCliReply({ ...ok, stdout: JSON.stringify([{ type: 'system' }]) })).toThrow(/no result message/)
    expect(() => parseClaudeCliReply({ ...ok, stdout: JSON.stringify({ type: 'result', is_error: false }) })).toThrow(/no text/)
  })
})

describe('claudeCliComplete', () => {
  const request = { model: 'judge-model', system: 'You are the judge.', user: 'Review this diff.', maxTokens: 4096 }

  it('starts the CLI with no tools, no settings and the whole prompt on stdin', async () => {
    const record = tmpDir()
    const complete = claudeCliComplete('tok-secret', { command: fakeClaude(record, cliResult(reviewJson)) })
    expect(await complete(request)).toBe(reviewJson)

    const args = fs.readFileSync(path.join(record, 'args.txt'), 'utf-8').split('\n')
    expect(args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'json', '--model', 'judge-model', '--system-prompt', 'You are the judge.', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config']),
    )
    // `--tools` and `--setting-sources` are followed by an empty value, meaning none.
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(fs.readFileSync(path.join(record, 'stdin.txt'), 'utf-8')).toBe('Review this diff.')
  })

  it('gives it the subscription token and nothing of the developer\'s environment', async () => {
    const record = tmpDir()
    const baseEnv = {
      PATH: process.env['PATH'],
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      ANTHROPIC_API_KEY: 'sk-must-not-leak',
      ZDOTDIR: '/terminal/integration',
      AWS_SECRET_ACCESS_KEY: 'aws-must-not-leak',
      HOME: '/home/real',
    }
    const complete = claudeCliComplete('tok-secret', { command: fakeClaude(record, cliResult(reviewJson)), baseEnv })
    await complete(request)

    const env = Object.fromEntries(
      fs
        .readFileSync(path.join(record, 'env.txt'), 'utf-8')
        .split('\n')
        .filter(line => line.includes('='))
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok-secret')
    expect(env['HTTPS_PROXY']).toBe('http://proxy.invalid:3128')
    for (const key of ['ANTHROPIC_API_KEY', 'ZDOTDIR', 'AWS_SECRET_ACCESS_KEY']) expect(env[key], key).toBeUndefined()
    expect(env['HOME']).not.toBe('/home/real')
    expect(env['HOME']).toContain('coro-eval-judge-')
  })

  it('runs in an empty directory outside the repository, and cleans up after itself', async () => {
    const record = tmpDir()
    await claudeCliComplete('tok', { command: fakeClaude(record, cliResult(reviewJson)) })(request)
    const cwd = fs.readFileSync(path.join(record, 'cwd.txt'), 'utf-8').trim()
    expect(cwd).toContain('coro-eval-judge-')
    expect(cwd.startsWith(PACKAGE_ROOT)).toBe(false)
    expect(fs.existsSync(cwd)).toBe(false)
    expect(fs.existsSync(path.dirname(cwd))).toBe(false)
  })

  it('surfaces a CLI error without ever echoing the token', async () => {
    const record = tmpDir()
    const failing = fakeClaude(record, JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate. API Error: 401' }), 1)
    const error = await claudeCliComplete('tok-secret-xyz', { command: failing })(request).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/Failed to authenticate/)
    expect((error as Error).message).not.toContain('tok-secret-xyz')
  })

  it('stops a CLI that never answers', async () => {
    const dir = tmpDir()
    const script = path.join(dir, 'claude')
    fs.writeFileSync(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
    const started = Date.now()
    await expect(claudeCliComplete('tok', { command: script, timeoutMs: 300 })(request)).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('drives a whole judge run', async () => {
    const record = tmpDir()
    const complete = claudeCliComplete('tok', { command: fakeClaude(record, cliResult('Here is my review:\n```json\n' + reviewJson + '\n```')) })
    const result = await runJudge({
      complete,
      model: 'judge-model',
      samples: 2,
      input: { ticket: 't', diff: 'd', referencePatch: 'r', automatedResults: 'a' },
    })
    expect(result.validSamples).toBe(2)
    expect(result.scores.correctness).toBe(4)
    expect(result.issues[0]).toMatchObject({ severity: 'minor', file: 'src/a.ts', agreedBy: 2 })
  })
})

describe('selectJudgeBackend', () => {
  it('uses the Messages API when the runner uses an API key', () => {
    const backend = selectJudgeBackend({ method: 'apiKey', secret: 'sk-test' }, { PATH: '' })
    expect(backend.complete).toBeTypeOf('function')
    expect(backend.description).toContain('ANTHROPIC_API_KEY')
  })

  it('uses the claude CLI when the runner uses a subscription token', () => {
    const bin = path.dirname(fakeClaude(tmpDir(), cliResult('x')))
    const backend = selectJudgeBackend({ method: 'oauth', secret: 'tok' }, { PATH: bin })
    expect(backend.complete).toBeTypeOf('function')
    expect(backend.description).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(backend.description).toContain(path.join(bin, 'claude'))
    expect(backend.description).not.toContain('tok)')
  })

  it('says what is missing rather than failing, when there is no claude CLI', () => {
    const backend = selectJudgeBackend({ method: 'oauth', secret: 'tok' }, { PATH: tmpDir() })
    expect(backend.complete).toBeNull()
    expect(backend.description).toMatch(/`claude` CLI on PATH/)
  })

  it('has nothing to offer without credentials', () => {
    expect(selectJudgeBackend(undefined)).toMatchObject({ complete: null })
  })
})

describe('process helpers', () => {
  it('findOnPath finds an executable file and ignores directories and non-executables', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'plain'), 'x', { mode: 0o644 })
    fs.mkdirSync(path.join(dir, 'folder'))
    const env = { PATH: [os.tmpdir() + '/does-not-exist', dir].join(path.delimiter) }
    expect(findOnPath('tool', env)).toBe(path.join(dir, 'tool'))
    expect(findOnPath('plain', env)).toBeUndefined()
    expect(findOnPath('folder', env)).toBeUndefined()
    expect(findOnPath('missing', env)).toBeUndefined()
  })

  it('runProcess passes arguments through untouched, feeds stdin, and separates the streams', async () => {
    const dir = tmpDir()
    const script = path.join(dir, 'echoer')
    fs.writeFileSync(script, '#!/bin/sh\nprintf "[%s]" "$@"\ncat >&2\n', { mode: 0o755 })
    const result = await runProcess(script, ['a b', '', '$HOME; rm -rf /'], { cwd: dir, env: { PATH: process.env['PATH'] }, stdin: 'in' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('[a b][][$HOME; rm -rf /]')
    expect(result.stderr).toBe('in')
  })

  it('runProcess reports a command that cannot be started', async () => {
    const result = await runProcess('/no/such/binary', [], { cwd: tmpDir(), env: {} })
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toMatch(/ENOENT/)
  })
})
