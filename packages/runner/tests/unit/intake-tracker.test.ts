import { describe, expect, it } from 'vitest'
import type { ExecutorMcpServerInfo } from '@coro-ai/plugin-sdk'
import { resolveTicketingPolicy } from '../../src/config/ticketing'
import { mcpTrackerBinding, pluginTrackerBinding, type TrackerResolution } from '../../src/trackers/binding'
import { matchTrackerProfile } from '../../src/trackers/profiles'
import {
  PLAN_MODE_TRACKER_READ_OFF_REASON,
  PLAN_MODE_TRACKER_WRITE_REASON,
  planIntakeTrackerAccess,
} from '../../src/intake/tracker'
import { createIntakePermissionBroker, resolveToolAccess, type ResolvedToolAccess } from '../../src/intake/permissions'
import { buildIntakeSystemPrompt, type IntakeContext } from '../../src/intake/system-prompt'
import { makeStubTrackerPlugin } from '../mcp/fixtures'

const ATLASSIAN: ExecutorMcpServerInfo = {
  name: 'claude.ai Atlassian',
  toolPrefix: 'mcp__claude_ai_Atlassian__',
  status: 'connected',
  source: 'claudeai',
  url: 'https://mcp.atlassian.com/v1/mcp',
  tools: [
    { name: 'getJiraIssue', readOnly: true },
    { name: 'searchJiraIssuesUsingJql', readOnly: true },
    { name: 'addCommentToJiraIssue', readOnly: false },
    { name: 'transitionJiraIssue', readOnly: false },
  ],
}

const BYO_JIRA: ExecutorMcpServerInfo = {
  name: 'jira-byo',
  toolPrefix: 'mcp__jira-byo__',
  status: 'connected',
  tools: [
    { name: 'jira_get_issue', readOnly: true },
    { name: 'jira_add_comment', readOnly: false },
  ],
}

const LINEAR: ExecutorMcpServerInfo = {
  name: 'claude.ai Linear',
  toolPrefix: 'mcp__claude_ai_Linear__',
  status: 'connected',
  url: 'https://mcp.linear.app/mcp',
  tools: [
    { name: 'get_issue', readOnly: true },
    { name: 'create_comment', readOnly: false },
  ],
}

function bind(server: ExecutorMcpServerInfo) {
  return mcpTrackerBinding(server, matchTrackerProfile(server))
}

function resolution(bound: ExecutorMcpServerInfo | undefined, ...others: ExecutorMcpServerInfo[]): TrackerResolution {
  const candidates = [...(bound ? [bound] : []), ...others].map(bind)
  return {
    ...(bound ? { binding: candidates[0] } : {}),
    candidates,
    reason: bound ? 'only connected tracker' : 'ambiguous',
  }
}

const policy = resolveTicketingPolicy(undefined)

describe('planIntakeTrackerAccess', () => {
  it('pre-approves a connector tracker\'s reads and blocks its writes', () => {
    const access = planIntakeTrackerAccess(policy, resolution(ATLASSIAN), new Set())
    expect([...access.preApprovedTools].sort()).toEqual([
      'mcp__claude_ai_Atlassian__getJiraIssue',
      'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql',
    ])
    expect(access.blockedTools.get('mcp__claude_ai_Atlassian__addCommentToJiraIssue')).toBe(PLAN_MODE_TRACKER_WRITE_REASON)
    expect(access.blockedTools.get('mcp__claude_ai_Atlassian__transitionJiraIssue')).toBe(PLAN_MODE_TRACKER_WRITE_REASON)
    expect(access.blockedTools.has('mcp__claude_ai_Atlassian__getJiraIssue')).toBe(false)
    expect(access.accessId).toBe('claude_ai')
    expect(access.attachServerId).toBeUndefined()
    expect(access.prompt).toMatchObject({
      source: 'mcp',
      refId: 'mcp:claude.ai Atlassian',
      readsOff: false,
      writesEnabled: true,
      createSourceTicket: 'off',
    })
    expect(access.prompt?.readTools.getIssue).toBe('mcp__claude_ai_Atlassian__getJiraIssue')
  })

  it('attaches a configured server the tracker lives on', () => {
    const access = planIntakeTrackerAccess(policy, resolution(BYO_JIRA), new Set(['jira-byo']))
    expect(access.attachServerId).toBe('jira-byo')
    expect(access.accessId).toBe('jira-byo')
    expect(access.preApprovedTools.has('mcp__jira-byo__jira_get_issue')).toBe(true)
  })

  it('blocks every tracker tool when plan-mode reads are off', () => {
    const readsOff = resolveTicketingPolicy({ read: { planMode: false } })
    const access = planIntakeTrackerAccess(readsOff, resolution(BYO_JIRA), new Set(['jira-byo']))
    expect(access.preApprovedTools.size).toBe(0)
    expect(access.attachServerId).toBeUndefined()
    expect(access.blockedTools.get('mcp__jira-byo__jira_get_issue')).toBe(PLAN_MODE_TRACKER_READ_OFF_REASON)
    expect(access.blockedTools.get('mcp__jira-byo__jira_add_comment')).toBe(PLAN_MODE_TRACKER_WRITE_REASON)
    expect(access.prompt?.readsOff).toBe(true)
    expect(access.prompt?.readTools).toEqual({})
  })

  it('blocks writes on tracker servers that were not bound', () => {
    const access = planIntakeTrackerAccess(policy, resolution(undefined, ATLASSIAN, LINEAR), new Set())
    expect(access.prompt).toBeUndefined()
    expect(access.preApprovedTools.size).toBe(0)
    expect(access.blockedTools.has('mcp__claude_ai_Atlassian__addCommentToJiraIssue')).toBe(true)
    expect(access.blockedTools.has('mcp__claude_ai_Linear__create_comment')).toBe(true)
    expect(access.blockedTools.has('mcp__claude_ai_Linear__get_issue')).toBe(false)
  })

  it('leaves a plugin tracker to the tracker_* lookup tools', () => {
    const binding = pluginTrackerBinding(makeStubTrackerPlugin('jira').plugin as never)
    const access = planIntakeTrackerAccess(policy, { binding, candidates: [], reason: 'plugin' }, new Set())
    expect(access.blockedTools.size).toBe(0)
    expect(access.preApprovedTools.size).toBe(0)
    expect(access.prompt).toMatchObject({ source: 'plugin', refId: 'jira' })
  })

  it('reports writes off when ticketing is disabled', () => {
    const disabled = resolveTicketingPolicy({ enabled: false })
    const access = planIntakeTrackerAccess(disabled, resolution(ATLASSIAN), new Set())
    expect(access.prompt?.writesEnabled).toBe(false)
    expect(access.preApprovedTools.size).toBe(2)
  })
})

describe('permission broker with tracker access', () => {
  function brokerWith(access: ResolvedToolAccess, over: Partial<Parameters<typeof createIntakePermissionBroker>[0]> = {}) {
    return createIntakePermissionBroker({
      sessionId: 's-tracker',
      workRoot: '/scratch',
      attachedMcpIds: new Set(['jira-byo']),
      emit: () => {},
      signal: new AbortController().signal,
      getAccess: () => access,
      updateSessionAccess: () => {},
      ...over,
    })
  }
  const tracker = planIntakeTrackerAccess(policy, resolution(BYO_JIRA), new Set(['jira-byo']))
  const offByDefault = resolveToolAccess(undefined, { defaults: {}, allow: [], deny: [] }, [{ id: 'jira-byo', planMode: false }])

  it('allows a pre-approved read on a server whose access is off', async () => {
    const broker = brokerWith(offByDefault, {
      blockedTools: tracker.blockedTools,
      isPreApproved: name => tracker.preApprovedTools.has(name),
    })
    expect(await broker.gate('mcp__jira-byo__jira_get_issue', {})).toEqual({ allow: true })
  })

  it('keeps other tools on that server off', async () => {
    const broker = brokerWith(offByDefault, { isPreApproved: name => tracker.preApprovedTools.has(name) })
    const decision = await broker.gate('mcp__jira-byo__jira_search', {})
    expect(decision.allow).toBe(false)
    expect(decision.reason).toContain('request_tool_access')
  })

  it('refuses a tracker write even when the capability allows everything', async () => {
    const allowAll = resolveToolAccess({ mcp: { 'jira-byo': 'allow' } }, { defaults: {}, allow: [], deny: [] }, [{ id: 'jira-byo', planMode: true }])
    const broker = brokerWith(allowAll, { blockedTools: tracker.blockedTools })
    expect(await broker.gate('mcp__jira-byo__jira_add_comment', {})).toEqual({
      allow: false,
      reason: PLAN_MODE_TRACKER_WRITE_REASON,
    })
  })

  it('refuses a connector tracker write that claude_ai would otherwise allow', async () => {
    const connector = planIntakeTrackerAccess(policy, resolution(ATLASSIAN), new Set())
    const broker = brokerWith(offByDefault, { blockedTools: connector.blockedTools })
    const decision = await broker.gate('mcp__claude_ai_Atlassian__transitionJiraIssue', {})
    expect(decision.allow).toBe(false)
    expect(await broker.gate('mcp__claude_ai_Atlassian__getJiraIssue', {})).toEqual({ allow: true })
  })

  it('lets a deny rule beat the pre-approval', async () => {
    const denied = { ...offByDefault, deny: ['mcp__jira-byo__*'] }
    const broker = brokerWith(denied, { isPreApproved: name => tracker.preApprovedTools.has(name) })
    const decision = await broker.gate('mcp__jira-byo__jira_get_issue', {})
    expect(decision.allow).toBe(false)
    expect(decision.reason).toContain('Blocked by rule')
  })
})

describe('plan-mode prompt tracker sections', () => {
  const context: IntakeContext = { recentRepos: [], recentReviewers: [], availableWorkflows: [] }

  it('names the bound MCP read tools instead of tracker_*', () => {
    const access = planIntakeTrackerAccess(policy, resolution(ATLASSIAN), new Set())
    const prompt = buildIntakeSystemPrompt(context, { toolsEnabled: true, tracker: access.prompt })
    expect(prompt).toContain('- mcp__claude_ai_Atlassian__getJiraIssue (Atlassian (Jira) via claude.ai Atlassian): when the user names a ticket key')
    expect(prompt).not.toContain('- mcp__claude_ai_Atlassian__getJiraIssue: after reading a ticket')
    expect(prompt).toContain('  Note: Every Jira call needs `cloudId`.')
    expect(prompt).not.toContain('tracker_get_issue')
    expect(prompt).toContain('"trackerRef": { "pluginId": "mcp:claude.ai Atlassian"')
    expect(prompt).toContain('"ticketing" (optional, not shown above)')
    expect(prompt).not.toContain('"ticketing": {')
  })

  it('keeps the tracker_* lines for a plugin tracker', () => {
    const binding = pluginTrackerBinding(makeStubTrackerPlugin('jira').plugin as never)
    const access = planIntakeTrackerAccess(policy, { binding, candidates: [], reason: 'plugin' }, new Set())
    const prompt = buildIntakeSystemPrompt(context, { toolsEnabled: true, trackerToolsEnabled: true, tracker: access.prompt })
    expect(prompt).toContain('- tracker_get_issue:')
    expect(prompt).toContain('"pluginId": "jira"')
  })

  it('omits tracker lines and ticket fields with no tracker', () => {
    const prompt = buildIntakeSystemPrompt(context, { toolsEnabled: true })
    expect(prompt).not.toContain('tracker_get_issue')
    expect(prompt).not.toContain('"trackerRef"')
  })

  it('says reads are off when the policy turns them off', () => {
    const readsOff = resolveTicketingPolicy({ read: { planMode: false } })
    const access = planIntakeTrackerAccess(readsOff, resolution(ATLASSIAN), new Set())
    const prompt = buildIntakeSystemPrompt(context, { toolsEnabled: true, tracker: access.prompt })
    expect(prompt).toContain('reading tickets is turned off for plan mode')
    expect(prompt).not.toContain('mcp__claude_ai_Atlassian__getJiraIssue')
  })

  it('asks before creating a ticket when the policy says ask', () => {
    const ask = resolveTicketingPolicy({ createSourceTicket: { mode: 'ask' } })
    const access = planIntakeTrackerAccess(ask, resolution(ATLASSIAN), new Set())
    const prompt = buildIntakeSystemPrompt(context, { toolsEnabled: true, tracker: access.prompt })
    expect(prompt).toContain('"ticketing": { "createSourceTicket": { "mode": "auto" } }')
  })

  it('drops the ticketing field when ticket updates are off', () => {
    const disabled = resolveTicketingPolicy({ enabled: false })
    const access = planIntakeTrackerAccess(disabled, resolution(ATLASSIAN), new Set())
    const prompt = buildIntakeSystemPrompt(context, { toolsEnabled: true, tracker: access.prompt })
    expect(prompt).toContain('Ticket updates are turned off for this team, so omit "ticketing"')
    expect(prompt).not.toContain('"preset": "subtasks"')
  })
})
