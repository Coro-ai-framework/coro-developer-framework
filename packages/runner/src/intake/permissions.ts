import { randomUUID } from 'crypto'
import * as path from 'path'
import type { Logger } from 'pino'
import { parseMcpToolName, isClaudeAiConnectorToolName } from '@coro-ai/plugin-sdk'
import type {
  IntakeBuiltinCapability,
  IntakeCapability,
  IntakePermissionDecision,
  IntakePermissionRequest,
  IntakePermissionRisk,
  InvestigationToolAccess,
  ToolAccessMode,
} from '@coro-ai/cloud-protocol'
import {
  loadLocalConfig,
  saveLocalConfig,
  validateLocalConfig,
  type LocalConfig,
} from '../config/local-config'

export const INTAKE_PERMISSION_TIMEOUT_MS = 10 * 60_000

export const DEFAULT_TOOL_ACCESS = {
  files: 'allow',
  filesWrite: 'ask',
  shell: 'ask',
  web: 'ask',
} as const satisfies Record<IntakeBuiltinCapability, ToolAccessMode>

export const DEFAULT_MCP_MODE: ToolAccessMode = 'off'

export const CLAUDE_AI_SERVER_ID = 'claude_ai'

const BUILTINS: readonly IntakeBuiltinCapability[] = ['files', 'filesWrite', 'shell', 'web']

export interface IntakePermissionConfig {
  defaults: {
    files?: ToolAccessMode
    filesWrite?: ToolAccessMode
    shell?: ToolAccessMode
    web?: ToolAccessMode
    mcp?: ToolAccessMode
  }
  allow: string[]
  deny: string[]
}

export function readIntakePermissionConfig(logger?: Logger): IntakePermissionConfig {
  try {
    const permissions = loadLocalConfig()?.intake?.permissions
    return {
      defaults: { ...(permissions?.defaults ?? {}) },
      allow: [...(permissions?.allow ?? [])],
      deny: [...(permissions?.deny ?? [])],
    }
  } catch (err) {
    logger?.warn({ err }, 'intake permissions: failed to read config; using defaults')
    return { defaults: {}, allow: [], deny: [] }
  }
}

export function appendGlobalIntakeAllowRule(rule: string): void {
  const existing = loadLocalConfig() ?? ({} as LocalConfig)
  const intake = { ...(existing.intake ?? {}) }
  const permissions = {
    ...(intake.permissions ?? {}),
    allow: [...(intake.permissions?.allow ?? [])],
  }
  if (!permissions.allow.includes(rule)) permissions.allow.push(rule)
  const next: LocalConfig = { ...existing, intake: { ...intake, permissions } }
  const validation = validateLocalConfig(next)
  if (!validation.success) {
    throw new Error(`Could not save plan-mode allow rule: ${validation.issues.map(i => i.message).join('; ')}`)
  }
  saveLocalConfig(validation.config)
}

export interface McpCatalogEntry {
  id: string
  planMode: boolean
}

export interface ResolvedToolAccess {
  capabilities: Record<IntakeBuiltinCapability, ToolAccessMode>
  mcp: Record<string, ToolAccessMode>
  allow: string[]
  deny: string[]
}

export function resolveToolAccess(
  session: InvestigationToolAccess | undefined,
  cfg: IntakePermissionConfig,
  catalog: McpCatalogEntry[],
): ResolvedToolAccess {
  const capabilities = {} as Record<IntakeBuiltinCapability, ToolAccessMode>
  for (const cap of BUILTINS) {
    capabilities[cap] = session?.capabilities?.[cap] ?? cfg.defaults[cap] ?? DEFAULT_TOOL_ACCESS[cap]
  }
  const mcp: Record<string, ToolAccessMode> = {}
  for (const entry of catalog) {
    mcp[entry.id] = session?.mcp?.[entry.id] ?? (entry.planMode ? 'allow' : (cfg.defaults.mcp ?? DEFAULT_MCP_MODE))
  }
  mcp[CLAUDE_AI_SERVER_ID] = session?.mcp?.[CLAUDE_AI_SERVER_ID] ?? 'allow'
  return {
    capabilities,
    mcp,
    allow: [...(session?.allow ?? []), ...cfg.allow],
    deny: [...(session?.deny ?? []), ...cfg.deny],
  }
}

export type ToolClass =
  | { kind: 'deny'; reason: string }
  | {
      kind: 'gated'
      capability: IntakeCapability
      title: string
      subject: string
      risk: IntakePermissionRisk
      ruleName: 'Shell' | 'Web' | 'Files' | 'mcp'
      ruleSubject: string
    }

export function classifyIntakeTool(
  toolName: string,
  input: unknown,
  ctx: { workRoot: string; attachedMcpIds: ReadonlySet<string>; checkoutAvailable?: boolean },
): ToolClass {
  if (toolName === 'Bash' || toolName === 'shell') {
    if (readBool(input, 'run_in_background')) {
      return { kind: 'deny', reason: 'Background shells are not available in plan mode; run the command in the foreground.' }
    }
    const command = readString(input, 'command')
    if (ctx.checkoutAvailable && commandClonesRepository(command)) {
      return {
        kind: 'deny',
        reason: 'Use scm_checkout to read a repository; shell clones are not available in plan mode.',
      }
    }
    return {
      kind: 'gated',
      capability: 'shell',
      title: 'Run a shell command',
      subject: command,
      risk: classifyShellRisk(command),
      ruleName: 'Shell',
      ruleSubject: command,
    }
  }
  if (toolName === 'BashOutput' || toolName === 'KillShell') {
    return { kind: 'deny', reason: 'Background shells are not available in plan mode; run the command in the foreground.' }
  }

  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS') {
    const subject = readString(input, 'file_path', 'path', 'pattern')
    return {
      kind: 'gated',
      capability: 'files',
      title: 'Read files',
      subject,
      risk: nativePathRisk(subject, ctx.workRoot),
      ruleName: 'Files',
      ruleSubject: 'read',
    }
  }
  if (toolName === 'file_read' || toolName === 'file_glob' || toolName === 'file_grep') {
    return {
      kind: 'gated',
      capability: 'files',
      title: 'Read files',
      subject: readString(input, 'path', 'pattern'),
      risk: 'normal',
      ruleName: 'Files',
      ruleSubject: 'read',
    }
  }

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'file_write' || toolName === 'file_edit') {
    return {
      kind: 'gated',
      capability: 'filesWrite',
      title: 'Write a scratch file',
      subject: readString(input, 'file_path', 'path'),
      risk: 'normal',
      ruleName: 'Files',
      ruleSubject: 'write',
    }
  }

  if (toolName === 'WebFetch' || toolName === 'web_fetch') {
    const url = readString(input, 'url')
    const host = hostnameOf(url)
    if (!host) return { kind: 'deny', reason: `Blocked ${toolName}: invalid url "${url}".` }
    return {
      kind: 'gated',
      capability: 'web',
      title: 'Fetch a web page',
      subject: url,
      risk: 'normal',
      ruleName: 'Web',
      ruleSubject: host,
    }
  }
  if (toolName === 'WebSearch') {
    const query = readString(input, 'query')
    return {
      kind: 'gated',
      capability: 'web',
      title: 'Search the web',
      subject: query,
      risk: 'normal',
      ruleName: 'Web',
      ruleSubject: 'search',
    }
  }

  if (isClaudeAiConnectorToolName(toolName)) {
    const rest = toolName.slice('mcp__claude_ai_'.length)
    const sep = rest.indexOf('__')
    const server = sep > 0 ? rest.slice(0, sep) : 'claude.ai'
    const tool = sep > 0 ? rest.slice(sep + 2) : rest
    return {
      kind: 'gated',
      capability: 'mcp:claude_ai',
      title: `Use ${server}: ${tool}`,
      subject: toolName,
      risk: 'normal',
      ruleName: 'mcp',
      ruleSubject: toolName,
    }
  }

  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    if (!ctx.attachedMcpIds.has(mcp.serverId)) {
      return { kind: 'deny', reason: `MCP server ${mcp.serverId} is not attached to this conversation.` }
    }
    return {
      kind: 'gated',
      capability: `mcp:${mcp.serverId}`,
      title: `Use ${mcp.serverId}: ${mcp.toolName}`,
      subject: toolName,
      risk: 'normal',
      ruleName: 'mcp',
      ruleSubject: toolName,
    }
  }

  return { kind: 'deny', reason: `${toolName} is not available in plan mode.` }
}

const MUTATING: RegExp[] = [
  /^sudo\b/,
  /^git\s+(push|send-email)\b/,
  /^git\s+remote\s+(add|set-url|remove|rm)\b/,
  /^gh\s+(pr|issue|release|repo|gist|label|secret|variable|workflow|run)\s+(create|merge|close|reopen|comment|edit|delete|review|ready|lock|unlock|transfer|fork|archive|rename|set|upload|cancel|rerun)\b/,
  /^gh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/,
  /^gh\s+api\b.*\s(-f|-F|--field|--raw-field|--input)\b/,
  /^curl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--request\s*(POST|PUT|PATCH|DELETE)|\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file|\s--json)/,
  /^wget\b.*--(post-data|post-file|method|body-data|body-file)/,
  /^(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|owner|dist-tag)\b/,
  /^(docker|podman)\s+(push|login)\b/,
  /^kubectl\s+(apply|create|delete|patch|replace|scale|rollout|edit|label|annotate|drain|cordon|exec)\b/,
  /^helm\s+(install|upgrade|uninstall|rollback)\b/,
  /^terraform\s+(apply|destroy|import|state)\b/,
  /^(aws|gcloud|az)\s+.*\b(create|delete|put|update|remove|deploy|set|start|stop|terminate)\b/,
  /^(ssh|scp|sftp|rsync)\b/,
]

export function classifyShellRisk(command: string): 'normal' | 'mutating' {
  const segments = splitSegments(command).map(stripAssignments)
  if (segments.some(segment => segment.includes('$(') || segment.includes('`'))) return 'mutating'
  for (const segment of segments) {
    const normalised = segment.replace(/\s+/g, ' ').trim()
    if (MUTATING.some(re => re.test(normalised))) return 'mutating'
  }
  return 'normal'
}

export interface ParsedRule {
  name: 'Shell' | 'Web' | 'Files' | 'mcp'
  spec: string | null
  raw: string
}

export function parseRule(raw: string): ParsedRule | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith('mcp__')) return { name: 'mcp', spec: trimmed, raw: trimmed }
  const named = /^(Shell|Web|Files)\((.+)\)$/.exec(trimmed)
  if (named) return { name: named[1] as ParsedRule['name'], spec: named[2]!, raw: trimmed }
  const bare = /^(Shell|Web|Files)$/.exec(trimmed)
  if (bare) return { name: bare[1] as ParsedRule['name'], spec: null, raw: trimmed }
  return null
}

export function ruleMatches(rule: ParsedRule, cls: Extract<ToolClass, { kind: 'gated' }>): boolean {
  if (rule.name !== cls.ruleName) return false
  if (rule.name === 'Shell' && cls.risk === 'mutating') return false
  if (rule.name === 'Files' && cls.risk === 'outside-scratch') return false
  if (rule.name === 'Shell') {
    const segments = splitSegments(cls.ruleSubject).map(s => stripAssignments(s).replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (segments.length === 0) return rule.spec === null
    return segments.every(segment => shellSegmentMatches(rule.spec, segment))
  }
  if (rule.name === 'Web') {
    if (rule.spec === null) return true
    if (rule.spec === 'search') return cls.ruleSubject === 'search'
    if (rule.spec.startsWith('domain:')) {
      const host = rule.spec.slice('domain:'.length).toLowerCase()
      const subject = cls.ruleSubject.toLowerCase()
      return subject === host || subject.endsWith('.' + host)
    }
    return false
  }
  if (rule.name === 'Files') {
    if (rule.spec === null) return true
    return rule.spec === cls.ruleSubject
  }
  if (rule.spec === null) return false
  if (rule.spec.endsWith('__*')) {
    return cls.ruleSubject.startsWith(rule.spec.slice(0, -1))
  }
  return rule.spec === cls.ruleSubject
}

export function suggestRule(cls: Extract<ToolClass, { kind: 'gated' }>): string | undefined {
  if (cls.risk !== 'normal') return undefined
  if (cls.ruleName === 'Shell') {
    const first = splitSegments(cls.ruleSubject).map(s => stripAssignments(s).replace(/\s+/g, ' ').trim()).find(Boolean)
    if (!first) return undefined
    const tokens = first.split(' ')
    const second = tokens[1]
    if (second && !/^[-/.~$]/.test(second) && !second.includes('=') && !second.includes('/')) {
      return `Shell(${tokens[0]} ${second}:*)`
    }
    return `Shell(${tokens[0]}:*)`
  }
  if (cls.ruleName === 'Web') {
    return cls.ruleSubject === 'search' ? 'Web(search)' : `Web(domain:${cls.ruleSubject})`
  }
  if (cls.ruleName === 'Files') return cls.ruleSubject === 'write' ? 'Files(write)' : 'Files(read)'
  return cls.ruleSubject
}

interface Pending {
  sessionId: string
  request: IntakePermissionRequest
  settle: (d: {
    decision: IntakePermissionDecision
    rule?: string
    mode?: ToolAccessMode
    message?: string
    by: 'developer' | 'timeout' | 'abort'
  }) => void
}

const pending = new Map<string, Pending>()

export function listPendingIntakePermissions(sessionId: string): IntakePermissionRequest[] {
  return [...pending.values()].filter(p => p.sessionId === sessionId).map(p => p.request)
}

export function resolveIntakePermission(
  sessionId: string,
  requestId: string,
  body: { decision: IntakePermissionDecision; rule?: string; mode?: ToolAccessMode; message?: string },
): { ok: true } | { ok: false; status: 404 | 409 | 400; error: string } {
  const entry = pending.get(requestId)
  if (!entry || entry.sessionId !== sessionId) {
    return { ok: false, status: 404, error: 'Permission request not found.' }
  }
  if (!entry.request.allowedDecisions.includes(body.decision)) {
    return { ok: false, status: 409, error: `Decision "${body.decision}" is not allowed for this request.` }
  }
  if (body.rule) {
    const parsed = parseRule(body.rule)
    const expected = entry.request.capability === 'shell' ? 'Shell'
      : entry.request.capability === 'web' ? 'Web'
      : entry.request.capability === 'files' || entry.request.capability === 'filesWrite' ? 'Files'
      : entry.request.capability.startsWith('mcp:') ? 'mcp'
      : null
    if (!parsed || (expected && parsed.name !== expected)) {
      return { ok: false, status: 400, error: `Invalid allow rule: ${body.rule}` }
    }
  }
  entry.settle({ ...body, by: 'developer' })
  return { ok: true }
}

export function resetIntakePermissionsForTests(): void {
  for (const entry of pending.values()) {
    entry.settle({ decision: 'deny', by: 'abort' })
  }
  pending.clear()
}

export interface IntakePermissionBroker {
  gate(toolName: string, input: unknown, opts?: { canAsk?: boolean }): Promise<{ allow: boolean; reason?: string }>
  requestCapability(capability: string, reason: string): Promise<{ granted: boolean; mode?: ToolAccessMode; note: string }>
  dispose(reason: string): void
}

export interface BrokerEmitEvent {
  type: 'permission_request' | 'permission_resolved'
  request?: IntakePermissionRequest
  requestId?: string
  decision?: 'allow' | 'deny'
  by?: 'developer' | 'timeout' | 'abort'
}

export function createIntakePermissionBroker(opts: {
  sessionId: string
  workRoot: string
  attachedMcpIds: ReadonlySet<string>
  /** When scm_checkout is offered, a shell clone is refused instead of prompted. */
  checkoutAvailable?: boolean
  emit: (event: BrokerEmitEvent) => void
  signal: AbortSignal
  getAccess: () => ResolvedToolAccess
  updateSessionAccess: (fn: (a: InvestigationToolAccess) => void) => void
  timeoutMs?: number
  logger?: Logger
}): IntakePermissionBroker {
  const timeoutMs = opts.timeoutMs ?? INTAKE_PERMISSION_TIMEOUT_MS
  const ownIds = new Set<string>()
  let disposed = false

  function settleOwn(reason: 'abort'): void {
    for (const id of ownIds) {
      pending.get(id)?.settle({ decision: 'deny', by: reason })
    }
  }

  async function ask(request: IntakePermissionRequest): Promise<{
    decision: IntakePermissionDecision
    rule?: string
    mode?: ToolAccessMode
    message?: string
    by: 'developer' | 'timeout' | 'abort'
  }> {
    if (disposed || opts.signal.aborted) return { decision: 'deny', by: 'abort' }
    return new Promise(resolve => {
      let settled = false
      const finish = (d: {
        decision: IntakePermissionDecision
        rule?: string
        mode?: ToolAccessMode
        message?: string
        by: 'developer' | 'timeout' | 'abort'
      }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal.removeEventListener('abort', onAbort)
        pending.delete(request.requestId)
        ownIds.delete(request.requestId)
        resolve(d)
      }
      const timer = setTimeout(() => finish({ decision: 'deny', by: 'timeout' }), timeoutMs)
      const onAbort = () => finish({ decision: 'deny', by: 'abort' })
      opts.signal.addEventListener('abort', onAbort, { once: true })
      pending.set(request.requestId, { sessionId: opts.sessionId, request, settle: finish })
      ownIds.add(request.requestId)
      opts.emit({ type: 'permission_request', request })
    })
  }

  function applyGrant(request: IntakePermissionRequest, body: { decision: IntakePermissionDecision; rule?: string }): boolean {
    if (body.decision === 'once') return true
    const rule = body.rule ?? request.suggestedRule
    if (body.decision === 'conversation' || body.decision === 'always') {
      if (rule) {
        opts.updateSessionAccess(access => pushUnique(access.allow, rule))
      }
      if (body.decision === 'always' && rule) {
        try {
          appendGlobalIntakeAllowRule(rule)
        } catch (err) {
          opts.logger?.warn({ err, rule }, 'intake permissions: failed to persist always-allow rule')
        }
      }
      return true
    }
    return false
  }

  return {
    async gate(toolName, input, gateOpts) {
      const cls = classifyIntakeTool(toolName, input, {
        workRoot: opts.workRoot,
        attachedMcpIds: opts.attachedMcpIds,
        checkoutAvailable: opts.checkoutAvailable,
      })
      if (cls.kind === 'deny') return { allow: false, reason: cls.reason }
      const access = opts.getAccess()
      for (const raw of access.deny) {
        const rule = parseRule(raw)
        if (rule && ruleMatches(rule, cls)) {
          return { allow: false, reason: `Blocked by rule \`${raw}\`.` }
        }
      }
      const mode = modeFor(access, cls.capability)
      if (mode === 'off') {
        return {
          allow: false,
          reason: `${capabilityLabel(cls.capability)} is off for this conversation. If you need it, call request_tool_access with capability "${cls.capability}" and a one-line reason. Do not retry this call.`,
        }
      }
      if (cls.risk === 'normal' && (mode === 'allow' || access.allow.some(raw => {
        const rule = parseRule(raw)
        return rule ? ruleMatches(rule, cls) : false
      }))) {
        return { allow: true }
      }
      if (gateOpts?.canAsk === false) {
        const hint = suggestRule(cls) ?? cls.title
        return {
          allow: false,
          reason: `This call needs developer approval, which subagents cannot request. Stop and report that you need ${hint} and why.`,
        }
      }
      const suggested = suggestRule(cls)
      const request = buildRequest({
        sessionId: opts.sessionId,
        kind: 'tool',
        capability: cls.capability,
        toolName,
        title: cls.title,
        subject: cls.subject,
        detail: clampDetail(input),
        risk: cls.risk,
        ...(suggested ? { suggestedRule: suggested } : {}),
        allowedDecisions: cls.risk === 'normal' ? ['once', 'conversation', 'always', 'deny'] : ['once', 'deny'],
        timeoutMs,
      })
      const answer = await ask(request)
      const allowed = answer.decision !== 'deny' && applyGrant(request, answer)
      opts.emit({
        type: 'permission_resolved',
        requestId: request.requestId,
        decision: allowed ? 'allow' : 'deny',
        by: answer.by,
      })
      if (allowed) return { allow: true }
      if (answer.by === 'timeout') {
        const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
        return { allow: false, reason: `No response from the developer within ${minutes} minutes; treat this as declined and continue without it.` }
      }
      if (answer.by === 'abort') return { allow: false, reason: 'The turn was stopped.' }
      const message = answer.message?.trim()
      return {
        allow: false,
        reason: `The developer declined this call${message ? `: ${message}` : '.'} Do not retry it; adjust your approach.`,
      }
    },

    async requestCapability(capability, reason) {
      const known = isKnownCapability(capability, opts.getAccess())
      if (!known) return { granted: false, note: `Unknown capability "${capability}".` }
      const access = opts.getAccess()
      const current = modeFor(access, capability as IntakeCapability)
      if (current !== 'off') return { granted: true, mode: current, note: 'Already enabled.' }
      const request = buildRequest({
        sessionId: opts.sessionId,
        kind: 'capability',
        capability: capability as IntakeCapability,
        toolName: 'request_tool_access',
        title: `Enable ${capabilityLabel(capability as IntakeCapability)} for this conversation`,
        subject: reason,
        risk: 'normal',
        allowedDecisions: ['conversation', 'deny'],
        timeoutMs,
      })
      const answer = await ask(request)
      const granted = answer.decision === 'conversation'
      if (granted) {
        const mode: ToolAccessMode = answer.mode === 'allow' ? 'allow' : 'ask'
        opts.updateSessionAccess(a => {
          if (capability.startsWith('mcp:')) a.mcp[capability.slice(4)] = mode
          else a.capabilities[capability as IntakeBuiltinCapability] = mode
        })
      }
      opts.emit({
        type: 'permission_resolved',
        requestId: request.requestId,
        decision: granted ? 'allow' : 'deny',
        by: answer.by,
      })
      if (!granted) {
        if (answer.by === 'timeout') {
          const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
          return { granted: false, note: `No response from the developer within ${minutes} minutes; treat this as declined and continue without it.` }
        }
        if (answer.by === 'abort') return { granted: false, note: 'The turn was stopped.' }
        return { granted: false, note: answer.message?.trim() ? `The developer declined: ${answer.message.trim()}` : 'The developer declined.' }
      }
      const mode: ToolAccessMode = answer.mode === 'allow' ? 'allow' : 'ask'
      if (capability.startsWith('mcp:')) {
        const id = capability.slice(4)
        if (!opts.attachedMcpIds.has(id)) {
          return { granted: true, mode, note: 'Enabled; this server attaches from the developer\'s next message — say what you will do with it and end your turn.' }
        }
      }
      return { granted: true, mode, note: 'Enabled; you can use it now.' }
    },

    dispose() {
      disposed = true
      settleOwn('abort')
    },
  }
}

function isKnownCapability(capability: string, access: ResolvedToolAccess): boolean {
  if (BUILTINS.includes(capability as IntakeBuiltinCapability)) return true
  if (capability.startsWith('mcp:')) return Object.prototype.hasOwnProperty.call(access.mcp, capability.slice(4))
  return false
}

function modeFor(access: ResolvedToolAccess, capability: IntakeCapability): ToolAccessMode {
  if (capability.startsWith('mcp:')) return access.mcp[capability.slice('mcp:'.length)] ?? 'off'
  return access.capabilities[capability as IntakeBuiltinCapability]
}

function capabilityLabel(capability: IntakeCapability): string {
  switch (capability) {
    case 'files': return 'Read files'
    case 'filesWrite': return 'Write scratch files'
    case 'shell': return 'Shell'
    case 'web': return 'Web'
    default: return `MCP server ${capability.slice('mcp:'.length)}`
  }
}

function buildRequest(args: {
  sessionId: string
  kind: 'tool' | 'capability'
  capability: IntakeCapability
  toolName: string
  title: string
  subject: string
  detail?: unknown
  risk: IntakePermissionRisk
  suggestedRule?: string
  allowedDecisions: IntakePermissionDecision[]
  timeoutMs: number
}): IntakePermissionRequest {
  const now = Date.now()
  return {
    requestId: randomUUID(),
    sessionId: args.sessionId,
    kind: args.kind,
    capability: args.capability,
    toolName: args.toolName,
    title: args.title,
    subject: args.subject,
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
    risk: args.risk,
    ...(args.suggestedRule ? { suggestedRule: args.suggestedRule } : {}),
    allowedDecisions: args.allowedDecisions,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + args.timeoutMs).toISOString(),
  }
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

function clampDetail(input: unknown): unknown {
  let text: string
  try { text = JSON.stringify(input) ?? '' }
  catch { text = String(input) }
  if (text.length <= 2000) return input
  return text.slice(0, 2000) + '…'
}

function commandClonesRepository(command: string): boolean {
  return splitSegments(command).map(stripAssignments).some(segment => {
    const normalised = segment.replace(/\s+/g, ' ').trim().replace(/^(?:do|then|else)\s+/, '')
    return /^git\s+clone\b/.test(normalised) || /^gh\s+repo\s+clone\b/.test(normalised)
  })
}

function splitSegments(command: string): string[] {
  return command.split(/&&|\|\||[;&|\n]/).map(s => s.trim()).filter(Boolean)
}

function stripAssignments(segment: string): string {
  let rest = segment.trim()
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*(?:\s+|$)/.test(rest)) {
    const next = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, '')
    if (next === rest) break
    rest = next.trim()
  }
  return rest
}

function shellSegmentMatches(spec: string | null, segment: string): boolean {
  if (spec === null) return true
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2)
    return segment === prefix || segment.startsWith(prefix + ' ')
  }
  return segment === spec
}

function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host || null
  } catch {
    return null
  }
}

function nativePathRisk(raw: string, workRoot: string): IntakePermissionRisk {
  if (!raw) return 'normal'
  if (raw.startsWith('~')) return 'outside-scratch'
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workRoot, raw)
  return isInside(abs, workRoot) ? 'normal' : 'outside-scratch'
}

function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), candidate)
  if (rel === '' || rel === '.') return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + path.sep)
}

function readString(input: unknown, ...fields: string[]): string {
  if (!input || typeof input !== 'object') return ''
  const rec = input as Record<string, unknown>
  for (const field of fields) {
    const value = rec[field]
    if (typeof value === 'string') return value
  }
  return ''
}

function readBool(input: unknown, field: string): boolean {
  if (!input || typeof input !== 'object') return false
  return (input as Record<string, unknown>)[field] === true
}
