import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyIntakeTool,
  classifyShellRisk,
  createIntakePermissionBroker,
  parseRule,
  resetIntakePermissionsForTests,
  resolveIntakePermission,
  resolveToolAccess,
  ruleMatches,
  suggestRule,
  type ToolClass,
} from '../../src/intake/permissions'

vi.mock('../../src/config/local-config', () => ({
  loadLocalConfig: vi.fn(() => ({ intake: { permissions: { allow: ['Shell(ls:*)'] } } })),
  saveLocalConfig: vi.fn(),
  validateLocalConfig: vi.fn((config: unknown) => ({ success: true, config })),
}))

afterEach(() => {
  resetIntakePermissionsForTests()
})

function gated(cls: ToolClass): Extract<ToolClass, { kind: 'gated' }> {
  if (cls.kind !== 'gated') throw new Error(`expected gated, got ${cls.kind}`)
  return cls
}

describe('classifyShellRisk', () => {
  it('treats remote-mutating commands as mutating and local inspection as normal', () => {
    expect(classifyShellRisk('git push')).toBe('mutating')
    expect(classifyShellRisk('curl -X POST https://example.com')).toBe('mutating')
    expect(classifyShellRisk('gh pr create --title x')).toBe('mutating')
    expect(classifyShellRisk('echo $(whoami)')).toBe('mutating')
    expect(classifyShellRisk('a && git push')).toBe('mutating')
    expect(classifyShellRisk('git clone --depth 1 x')).toBe('normal')
    expect(classifyShellRisk('rg foo')).toBe('normal')
    expect(classifyShellRisk('ls -la | head')).toBe('normal')
    expect(classifyShellRisk('gh pr view 1')).toBe('normal')
  })
})

describe('permission rules', () => {
  it('parses, matches, and suggests rules', () => {
    const shell = gated(classifyIntakeTool('shell', { command: 'git clone --depth 1 x && rg foo' }, { workRoot: '/scratch', attachedMcpIds: new Set() }))
    expect(parseRule('Shell(git clone:*)')).toMatchObject({ name: 'Shell', spec: 'git clone:*' })
    expect(ruleMatches(parseRule('Shell(git clone:*)')!, shell)).toBe(false)
    const clone = gated(classifyIntakeTool('Bash', { command: 'git clone --depth 1 x' }, { workRoot: '/scratch', attachedMcpIds: new Set() }))
    expect(ruleMatches(parseRule('Shell(git clone:*)')!, clone)).toBe(true)
    expect(suggestRule(clone)).toBe('Shell(git clone:*)')
    expect(suggestRule(gated(classifyIntakeTool('shell', { command: 'ls -la' }, { workRoot: '/scratch', attachedMcpIds: new Set() })))).toBe('Shell(ls:*)')

    const web = gated(classifyIntakeTool('web_fetch', { url: 'https://api.github.com/repos' }, { workRoot: '/scratch', attachedMcpIds: new Set() }))
    expect(ruleMatches(parseRule('Web(domain:github.com)')!, web)).toBe(true)
    expect(ruleMatches(parseRule('Web(domain:gitlab.com)')!, web)).toBe(false)
    expect(suggestRule(web)).toBe('Web(domain:api.github.com)')

    const search = gated(classifyIntakeTool('WebSearch', { query: 'coro' }, { workRoot: '/scratch', attachedMcpIds: new Set() }))
    expect(ruleMatches(parseRule('Web(search)')!, search)).toBe(true)
    expect(suggestRule(search)).toBe('Web(search)')

    const read = gated(classifyIntakeTool('file_read', { path: 'a.ts' }, { workRoot: '/scratch', attachedMcpIds: new Set() }))
    expect(ruleMatches(parseRule('Files(read)')!, read)).toBe(true)
    expect(suggestRule(read)).toBe('Files(read)')
    expect(parseRule('not a rule')).toBeNull()
  })

  it('classifies path and tool reach', () => {
    const outside = classifyIntakeTool('Read', { file_path: '/etc/passwd' }, { workRoot: '/scratch', attachedMcpIds: new Set() })
    expect(gated(outside).risk).toBe('outside-scratch')
    const inside = classifyIntakeTool('Read', { file_path: '/scratch/repo/a.ts' }, { workRoot: '/scratch', attachedMcpIds: new Set() })
    expect(gated(inside).risk).toBe('normal')
    expect(classifyIntakeTool('Task', {}, { workRoot: '/scratch', attachedMcpIds: new Set() })).toMatchObject({ kind: 'deny' })
    expect(classifyIntakeTool('mcp__linear__list_issues', {}, { workRoot: '/scratch', attachedMcpIds: new Set() })).toMatchObject({ kind: 'deny' })
    expect(classifyIntakeTool('mcp__linear__list_issues', {}, { workRoot: '/scratch', attachedMcpIds: new Set(['linear']) }).kind).toBe('gated')
  })
})

describe('resolveToolAccess', () => {
  it('prefers the session, then config, then defaults, and opts planMode servers into allow', () => {
    const resolved = resolveToolAccess(
      { capabilities: { shell: 'off' }, mcp: {}, allow: ['Shell(ls:*)'], deny: [] },
      { defaults: { web: 'off' }, allow: ['Files(read)'], deny: ['Web(search)'] },
      [{ id: 'catalog', planMode: true }, { id: 'linear', planMode: false }],
    )
    expect(resolved.capabilities).toMatchObject({ files: 'allow', filesWrite: 'ask', shell: 'off', web: 'off' })
    expect(resolved.mcp).toMatchObject({ catalog: 'allow', linear: 'off', claude_ai: 'allow' })
    expect(resolved.allow).toEqual(['Shell(ls:*)', 'Files(read)'])
    expect(resolved.deny).toEqual(['Web(search)'])
  })
})

describe('permission broker', () => {
  const workRoot = '/scratch'

  function broker(over: Partial<Parameters<typeof createIntakePermissionBroker>[0]> = {}) {
    const access = resolveToolAccess(undefined, { defaults: {}, allow: [], deny: [] }, [{ id: 'linear', planMode: false }])
    let current = access
    const events: Array<{ type: string }> = []
    const made = createIntakePermissionBroker({
      sessionId: 's1',
      workRoot,
      attachedMcpIds: new Set(),
      emit: event => events.push(event),
      signal: new AbortController().signal,
      getAccess: () => current,
      updateSessionAccess: fn => {
        const next = { capabilities: { ...current.capabilities }, mcp: { ...current.mcp }, allow: [...current.allow], deny: [...current.deny] }
        fn(next)
        current = resolveToolAccess(next, { defaults: {}, allow: [], deny: [] }, [{ id: 'linear', planMode: false }])
      },
      ...over,
    })
    return { broker: made, events, get current() { return current }, set current(value) { current = value } }
  }

  it('refuses an off capability and tells the model to ask', async () => {
    const { broker: gate, current } = broker()
    current.capabilities = { ...current.capabilities, shell: 'off' }
    const decision = await gate.gate('shell', { command: 'ls' })
    expect(decision.allow).toBe(false)
    expect(decision.reason).toContain('request_tool_access')
  })

  it('still asks for a mutating command when the capability is allow', async () => {
    const { broker: gate, events, current } = broker()
    current.capabilities = { ...current.capabilities, shell: 'allow' }
    const pending = gate.gate('shell', { command: 'git push' })
    await vi.waitFor(() => expect(events.some(e => e.type === 'permission_request')).toBe(true))
    const requestId = (events.find(e => e.type === 'permission_request') as { request?: { requestId: string } }).request?.requestId
    expect(resolveIntakePermission('s1', requestId!, { decision: 'conversation' }).ok).toBe(false)
    expect(resolveIntakePermission('s1', requestId!, { decision: 'once', rule: 'not a rule' })).toMatchObject({ ok: false, status: 400 })
    expect(resolveIntakePermission('s1', requestId!, { decision: 'once' }).ok).toBe(true)
    await expect(pending).resolves.toEqual({ allow: true })
  })

  it('records a conversation rule and skips the next identical call', async () => {
    const { broker: gate, events, current } = broker()
    current.capabilities = { ...current.capabilities, shell: 'ask' }
    const pending = gate.gate('shell', { command: 'ls' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const request = (events[0] as { request: { requestId: string; suggestedRule?: string } }).request
    expect(request.suggestedRule).toBe('Shell(ls:*)')
    expect(resolveIntakePermission('s1', request.requestId, { decision: 'conversation', rule: request.suggestedRule }).ok).toBe(true)
    await expect(pending).resolves.toEqual({ allow: true })
    events.length = 0
    await expect(gate.gate('shell', { command: 'ls -la' })).resolves.toEqual({ allow: true })
    expect(events).toHaveLength(0)
  })

  it('puts the developer message into a denial', async () => {
    const { broker: gate, events, current } = broker()
    current.capabilities = { ...current.capabilities, web: 'ask' }
    const pending = gate.gate('web_fetch', { url: 'https://example.com' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const requestId = (events[0] as { request: { requestId: string } }).request.requestId
    resolveIntakePermission('s1', requestId, { decision: 'deny', message: 'use the ticket instead' })
    const decision = await pending
    expect(decision.allow).toBe(false)
    expect(decision.reason).toContain('use the ticket instead')
  })

  it('declines when the developer does not answer in time', async () => {
    vi.useFakeTimers()
    try {
      const { broker: gate, current } = broker({ timeoutMs: 20 })
      current.capabilities = { ...current.capabilities, shell: 'ask' }
      const pending = gate.gate('shell', { command: 'pwd' })
      await vi.advanceTimersByTimeAsync(30)
      const decision = await pending
      expect(decision.allow).toBe(false)
      expect(decision.reason).toContain('No response')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not prompt a subagent', async () => {
    const { broker: gate, events, current } = broker()
    current.capabilities = { ...current.capabilities, shell: 'ask' }
    const decision = await gate.gate('shell', { command: 'ls' }, { canAsk: false })
    expect(decision.allow).toBe(false)
    expect(decision.reason).toContain('subagents cannot request')
    expect(events).toHaveLength(0)
  })

  it('grants a capability the model asked for', async () => {
    const { broker: gate, events, current } = broker()
    current.capabilities = { ...current.capabilities, shell: 'off' }
    const pending = gate.requestCapability('shell', 'clone the repo')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const requestId = (events[0] as { request: { requestId: string } }).request.requestId
    resolveIntakePermission('s1', requestId, { decision: 'conversation', mode: 'ask' })
    await expect(pending).resolves.toMatchObject({ granted: true, mode: 'ask' })
  })

  it('rejects unknown, disallowed, and malformed permission replies', () => {
    expect(resolveIntakePermission('s1', 'missing', { decision: 'once' })).toMatchObject({ ok: false, status: 404 })
  })
})
