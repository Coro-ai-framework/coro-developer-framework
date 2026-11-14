import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCoroConfig,
  cachePaths,
  describeCredentials,
  isolatedEnv,
  prepareWorkspace,
  redactConfig,
  redactConfigFile,
  resolveCredentials,
} from '../src/sandbox'
import { resolveScenario } from '../src/scenario'
import { loadTask, TASKS_DIR } from '../src/tasks'
import { git, tmpDir } from './helpers/tmp'

const apiKey = { method: 'apiKey', secret: 'sk-test-123' } as const

describe('resolveCredentials', () => {
  it('prefers an API key over an OAuth token', () => {
    expect(resolveCredentials({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({ method: 'apiKey', secret: 'k' })
  })

  it('falls back to an OAuth token', () => {
    expect(resolveCredentials({ CLAUDE_CODE_OAUTH_TOKEN: ' t ' })).toEqual({ method: 'oauth', secret: 't' })
  })

  it('says which variable a run will use and what it is billed to, never the secret', () => {
    const key = describeCredentials(resolveCredentials({ ANTHROPIC_API_KEY: 'sk-secret-value' }))
    expect(key).toContain('ANTHROPIC_API_KEY')
    expect(key).toMatch(/credits/)
    const token = describeCredentials(resolveCredentials({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret-value' }))
    expect(token).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(token).toMatch(/plan/)
    expect(`${key} ${token}`).not.toMatch(/secret-value/)
  })

  it('points a subscription user at `claude setup-token` when nothing is set', () => {
    expect(() => resolveCredentials({})).toThrow(/claude setup-token/)
  })

  it('refuses to start without either, and says why a login will not do', () => {
    expect(() => resolveCredentials({})).toThrow(/No Anthropic credentials[\s\S]*isolated HOME/)
    expect(() => resolveCredentials({ ANTHROPIC_API_KEY: '   ' })).toThrow(/No Anthropic credentials/)
  })
})

describe('buildCoroConfig', () => {
  const config = (overrides: string[] = [], credentials = apiKey) =>
    buildCoroConfig({ scenario: resolveScenario({ overrides }), credentials, workingDir: '/work' }) as Record<string, any>

  it('uses the local SCM and the Anthropic executor with the harness credentials', () => {
    const c = config()
    expect(c.plugins.defaults.scm).toBe('local')
    expect(c.plugins.installed.anthropic.config).toEqual({ method: 'apiKey', apiKey: 'sk-test-123' })
    expect(c.paths.workingDir).toBe('/work')
    expect(c.llm.defaultProvider).toBe('anthropic')
  })

  it('passes an OAuth token under the key the plugin reads', () => {
    expect(config([], { method: 'oauth', secret: 'tok' } as never).plugins.installed.anthropic.config).toEqual({ method: 'oauth', oauthToken: 'tok' })
  })

  it('sets no model aliases unless the scenario names models', () => {
    expect(config().llm.aliases).toBeUndefined()
  })

  it('writes a model for a tier under both the shorthand and the tier: name', () => {
    expect(config(['models.coding=claude-sonnet-5-5']).llm.aliases).toEqual({
      coding: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      'tier:coding': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    })
  })

  it('does not double-prefix a tier that is already qualified', () => {
    const aliases = config(['models.tier:planning=m']).llm.aliases
    expect(Object.keys(aliases)).toEqual(['tier:planning'])
  })

  it('carries the code-review lens switch', () => {
    expect(config().codeReview.lenses).toBe(true)
    expect(config(['codeReviewLenses=false']).codeReview.lenses).toBe(false)
  })

  it('attaches a tenant overlay only when asked', () => {
    expect(config().tenant).toBeUndefined()
    expect(config(['tenantOverlayDir=/abs/overlay']).tenant).toEqual({ overlay: { kind: 'localDir', path: '/abs/overlay' } })
  })
})

describe('redactConfig', () => {
  it('blanks credentials, leaves everything else, and does not change its input', () => {
    const original = buildCoroConfig({ scenario: resolveScenario(), credentials: apiKey, workingDir: '/work' })
    const redacted = redactConfig(original) as Record<string, any>
    expect(redacted.plugins.installed.anthropic.config.apiKey).toBe('<redacted>')
    expect(redacted.plugins.installed.anthropic.config.method).toBe('apiKey')
    expect(redacted.paths.workingDir).toBe('/work')
    expect((original as Record<string, any>).plugins.installed.anthropic.config.apiKey).toBe('sk-test-123')
  })

  it('redacts an OAuth token too', () => {
    const redacted = redactConfig(buildCoroConfig({ scenario: resolveScenario(), credentials: { method: 'oauth', secret: 'tok' }, workingDir: '/w' })) as Record<string, any>
    expect(JSON.stringify(redacted)).not.toContain('tok"')
    expect(redacted.plugins.installed.anthropic.config.oauthToken).toBe('<redacted>')
  })

  it('rewrites a config file in place and tolerates a missing one', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify(buildCoroConfig({ scenario: resolveScenario(), credentials: apiKey, workingDir: '/w' })))
    redactConfigFile(file)
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('sk-test-123')
    expect(() => redactConfigFile(path.join(dir, 'nope.json'))).not.toThrow()
  })
})

describe('isolatedEnv', () => {
  const caches = cachePaths('/cache')
  const base: NodeJS.ProcessEnv = {
    HOME: '/home/real',
    PATH: ['/usr/bin', '/repo/node_modules/.bin', '/repo/packages/eval/node_modules/.bin', '/repo/node_modules/.pnpm/x/node_modules/.bin', '/bin'].join(path.delimiter),
    ANTHROPIC_API_KEY: 'sk-test',
    CORO_CODING_MODEL: 'sneaky',
    CORO_PLANNING_MODEL: 'sneaky',
    CLAUDE_CODING_MODEL: 'sneaky',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    NODE_PATH: '/repo/node_modules',
    INIT_CWD: '/repo',
    npm_lifecycle_event: 'eval',
    npm_package_name: '@coro-ai/eval',
    npm_config_registry: 'https://example.invalid',
    PNPM_PACKAGE_NAME: 'x',
    ZDOTDIR: '/terminal/shell-integration',
    USER_ZDOTDIR: '/home/real',
    VSCODE_ZDOTDIR: '/terminal/shell-integration',
    BASH_ENV: '/home/real/.bashenv',
    ENV: '/home/real/.shrc',
    LANG: 'en_US.UTF-8',
  }
  const env = isolatedEnv(base, '/attempt/home', caches)

  it('points HOME at the attempt', () => {
    expect(env['HOME']).toBe('/attempt/home')
    expect(env['USERPROFILE']).toBe('/attempt/home')
    expect(env['XDG_CONFIG_HOME']).toBe('/attempt/home/.config')
  })

  it('removes model overrides, Claude Code session markers and package-manager leftovers', () => {
    for (const key of ['CORO_CODING_MODEL', 'CORO_PLANNING_MODEL', 'CLAUDE_CODING_MODEL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NODE_PATH', 'INIT_CWD', 'npm_lifecycle_event', 'npm_package_name', 'PNPM_PACKAGE_NAME']) {
      expect(env[key], key).toBeUndefined()
    }
  })

  it("removes the variables that make a shell read the developer's own startup files", () => {
    for (const key of ['ZDOTDIR', 'USER_ZDOTDIR', 'VSCODE_ZDOTDIR', 'BASH_ENV', 'ENV']) {
      expect(env[key], key).toBeUndefined()
    }
  })

  // The failure this guards against: every Bash call the agent made died on
  // `~/.zshenv:.:1: no such file or directory: $HOME/.cargo/env`, because the
  // terminal that launched the harness exported ZDOTDIR/USER_ZDOTDIR.
  it.skipIf(spawnSync('zsh', ['-c', 'true']).status !== 0)(
    'lets a login zsh start cleanly under an inherited terminal ZDOTDIR',
    () => {
      const root = tmpDir()
      const userHome = path.join(root, 'user')
      const integration = path.join(root, 'integration')
      const attemptHome = path.join(root, 'attempt')
      for (const dir of [userHome, integration, attemptHome]) fs.mkdirSync(dir, { recursive: true })
      // Stand-ins for a developer's dotfiles and for a terminal's shell-integration stubs.
      fs.writeFileSync(path.join(userHome, '.zshenv'), '. "$HOME/.cargo/env"\n')
      fs.writeFileSync(path.join(userHome, '.zprofile'), '. "$HOME/.profile"\n')
      fs.writeFileSync(path.join(integration, '.zshenv'), '[[ -f $USER_ZDOTDIR/.zshenv ]] && . $USER_ZDOTDIR/.zshenv\n')
      fs.writeFileSync(path.join(integration, '.zprofile'), '[[ -f $USER_ZDOTDIR/.zprofile ]] && . $USER_ZDOTDIR/.zprofile\n')
      const terminalEnv = { ...process.env, ZDOTDIR: integration, USER_ZDOTDIR: userHome }
      const run = (env: NodeJS.ProcessEnv) =>
        spawnSync('zsh', ['-l', '-c', 'echo started'], { env: { ...env, HOME: attemptHome }, encoding: 'utf-8' })

      // Without the scrub the shell sources the developer's files against the attempt's HOME.
      expect(run(terminalEnv).stderr).toContain('no such file or directory')

      const scrubbed = run(isolatedEnv(terminalEnv, attemptHome, caches))
      expect(scrubbed.stderr).toBe('')
      expect(scrubbed.stdout.trim()).toBe('started')
    },
  )

  it('keeps what the run needs: credentials and ordinary variables', () => {
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-test')
    expect(env['LANG']).toBe('en_US.UTF-8')
  })

  it('takes the workspace toolchain off PATH but keeps the system directories', () => {
    expect(env['PATH']!.split(path.delimiter)).toEqual(['/usr/bin', '/bin'])
  })

  it('shares package caches and quiets the package managers', () => {
    expect(env['npm_config_cache']).toBe('/cache/npm')
    expect(env['GOMODCACHE']).toBe('/cache/go-mod')
    expect(env['GOCACHE']).toBe('/cache/go-build')
    expect(env['npm_config_audit']).toBe('false')
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
  })

  it('does not change the environment it was given', () => {
    expect(base['HOME']).toBe('/home/real')
    expect(base['CORO_CODING_MODEL']).toBe('sneaky')
  })
})

describe('prepareWorkspace', () => {
  const task = loadTask(path.join(TASKS_DIR, 'ts-slugify'))

  it('lays out an isolated home, a git sandbox with one commit on main, and a private config', async () => {
    const root = path.join(tmpDir(), 'attempt')
    const ws = await prepareWorkspace({ root, task, scenario: resolveScenario(), credentials: apiKey })

    expect(ws.home).toBe(path.join(ws.root, 'home'))
    expect(fs.existsSync(ws.workingDir)).toBe(true)
    expect(fs.readFileSync(path.join(ws.home, '.gitconfig'), 'utf-8')).toContain('coro-eval@example.invalid')

    expect((await git(ws.sandbox, 'rev-parse', 'HEAD')).trim()).toBe(ws.baseSha)
    expect((await git(ws.sandbox, 'rev-list', '--count', 'HEAD')).trim()).toBe('1')
    expect((await git(ws.sandbox, 'branch', '--show-current')).trim()).toBe('main')
    expect((await git(ws.sandbox, 'status', '--porcelain')).trim()).toBe('')

    const mode = fs.statSync(ws.configPath).mode & 0o777
    expect(mode).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(ws.configPath, 'utf-8')).paths.workingDir).toBe(ws.workingDir)
  })

  it('copies the fixture without .git or node_modules and without the hidden tests', async () => {
    const ws = await prepareWorkspace({ root: path.join(tmpDir(), 'a'), task, scenario: resolveScenario(), credentials: apiKey })
    const files = (await git(ws.sandbox, 'ls-files')).split('\n')
    expect(files).toContain('src/strings.ts')
    expect(files).toContain('package-lock.json')
    expect(files.some(f => f.startsWith('hidden'))).toBe(false)
    expect(files.some(f => f.includes('node_modules'))).toBe(false)
  })

  it('gives two attempts nothing in common', async () => {
    const parent = tmpDir()
    const a = await prepareWorkspace({ root: path.join(parent, 'a'), task, scenario: resolveScenario(), credentials: apiKey })
    const b = await prepareWorkspace({ root: path.join(parent, 'b'), task, scenario: resolveScenario(), credentials: apiKey })
    expect(a.home).not.toBe(b.home)
    expect(a.sandbox).not.toBe(b.sandbox)
    expect(a.configPath).not.toBe(b.configPath)
  })
})
