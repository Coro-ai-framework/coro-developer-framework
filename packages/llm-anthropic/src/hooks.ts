import path from 'node:path'
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from 'pino'

// PreToolUse hooks fire before every tool call the model makes (builtins AND
// mcp__coro__*). Returning a `permissionDecision: 'deny'` rejects the call and
// surfaces `permissionDecisionReason` back to the model so it can course-
// correct. We use this to encode a filesystem safety guard rail that used to
// live as prose in agent MDs:
//
//   `Write` / `Edit` operations must stay inside the job's working directory
//   or `coroIntelligenceDir/memory/` — this prevents a runaway agent from clobbering
//   files elsewhere on the dev machine.
//
// Both checks are cheap and deterministic, so moving them from prose to
// code trades a few kB of tokens for actual enforcement.

export interface BuildHookOpts {
  /** Closure that returns the current phase name — phase can change between calls. */
  liveJobRef: () => { phase: string }
  /** Absolute path to the job's working directory. */
  workingDir: string
  /** Absolute path to the Coro intelligence dir. */
  coroIntelligenceDir: string
  /** Optional exact tool whitelist for this phase. */
  allowedTools?: ReadonlyArray<string>
  logger: Logger
}

export function buildPhaseHooks(opts: BuildHookOpts): Record<string, Array<{ hooks: HookCallback[] }>> {
  const memoryRoot = path.join(opts.coroIntelligenceDir, 'memory')
  const allowedTools = opts.allowedTools && opts.allowedTools.length > 0
    ? new Set(opts.allowedTools)
    : null

  const deny = (reason: string): HookJSONOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const toolName = input.tool_name
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>

    if (allowedTools && !allowedTools.has(toolName)) {
      const reason =
        `Blocked ${toolName}: phase ${opts.liveJobRef().phase} only allows ` +
        `${Array.from(allowedTools).join(', ')}. Update the workflow if this phase ` +
        `needs broader tool access.`
      opts.logger.warn({ phase: opts.liveJobRef().phase, toolName }, reason)
      return deny(reason)
    }

    // Guard rail: Write/Edit must stay inside working dir or memory/.
    // Bash commands with obvious write intent (e.g. `rm -rf /`) are harder
    // to validate generically, so we do the simple path check and rely on
    // the model's prose instructions for shell safety.
    if (toolName === 'Write' || toolName === 'Edit') {
      const rawPath = (toolInput['file_path'] ?? toolInput['path']) as unknown
      if (typeof rawPath === 'string' && rawPath.length > 0) {
        const abs = path.resolve(opts.workingDir, rawPath)
        const insideWorking = isInside(abs, opts.workingDir)
        const insideMemory = isInside(abs, memoryRoot)
        if (!insideWorking && !insideMemory) {
          const reason =
            `Blocked ${toolName}: "${rawPath}" resolves to ${abs}, which is outside the ` +
            `allowed write roots. Permitted: ${opts.workingDir}/** and ${memoryRoot}/**. ` +
            `Use \`propose_change\` for changes to the intelligence repo.`
          opts.logger.warn({ phase: opts.liveJobRef().phase, path: abs }, reason)
          return deny(reason)
        }
      }
    }

    if (toolName === 'Bash') {
      const command = toolInput['command']
      if (typeof command === 'string' && command.trim().length > 0) {
        const denialReason = getBashPathDenialReason(command, opts.workingDir, memoryRoot)
        if (denialReason) {
          opts.logger.warn({ phase: opts.liveJobRef().phase, command }, denialReason)
          return deny(denialReason)
        }
      }
    }

    return {}
  }

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
  }
}

/** Path containment check, defends against '..' escapes. */
function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function getBashPathDenialReason(command: string, workingDir: string, memoryRoot: string): string | null {
  for (const rawToken of tokenizeShellCommand(command)) {
    const candidate = extractPathCandidate(rawToken)
    if (!candidate) continue

    if (isClaudeTaskOutputPath(candidate)) {
      return (
        `Blocked Bash: command "${command}" references Claude runtime task output ` +
        `via "${candidate}". Do not poll or read /private/tmp/claude-*/tasks/*.output ` +
        `directly. Rerun the underlying command with output redirected to a file inside ` +
        `${workingDir}/** and read that workspace file instead.`
      )
    }

    if (candidate === '~' || candidate.startsWith('~/')) {
      return bashPathReason(command, candidate, 'home-relative path', workingDir, memoryRoot)
    }

    if (
      candidate.includes('$HOME') || candidate.includes('${HOME}') ||
      candidate.includes('$OLDPWD') || candidate.includes('${OLDPWD}')
    ) {
      return bashPathReason(command, candidate, 'home-directory environment reference', workingDir, memoryRoot)
    }

    const pwdExpanded = expandPwdPath(candidate, workingDir)
    if (pwdExpanded) {
      if (!isInside(pwdExpanded, workingDir) && !isInside(pwdExpanded, memoryRoot)) {
        return bashPathReason(command, candidate, `path ${pwdExpanded}`, workingDir, memoryRoot)
      }
      continue
    }

    if (hasParentTraversal(candidate)) {
      return bashPathReason(command, candidate, 'parent-directory traversal', workingDir, memoryRoot)
    }

    if (candidate.startsWith('/')) {
      const abs = path.resolve(candidate)
      if (!isInside(abs, workingDir) && !isInside(abs, memoryRoot)) {
        return bashPathReason(command, candidate, `path ${abs}`, workingDir, memoryRoot)
      }
    }
  }

  return null
}

function isClaudeTaskOutputPath(token: string): boolean {
  return token.startsWith('/private/tmp/claude-')
    && token.includes('/tasks/')
    && token.endsWith('.output')
}

function tokenizeShellCommand(command: string): string[] {
  return command.match(/'[^']*'|"[^"]*"|`[^`]*`|\S+/g) ?? []
}

function extractPathCandidate(token: string): string | null {
  const unquoted = stripShellQuotes(token)
  const value = extractAssignmentValue(unquoted)
  if (!looksLikePathReference(value)) return null
  return value
}

function stripShellQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' || first === '\'' || first === '`') && first === last) {
      return token.slice(1, -1)
    }
  }
  return token
}

function extractAssignmentValue(token: string): string {
  const envMatch = token.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/)
  if (envMatch) return envMatch[1]

  const flagMatch = token.match(/^--[^=]+=(.+)$/)
  if (flagMatch) return flagMatch[1]

  return token
}

function looksLikePathReference(token: string): boolean {
  return token === '~' || token === '..' || token === '-' ||
    token.startsWith('~/') || token.startsWith('../') || token.startsWith('./') ||
    token.startsWith('/') || token.startsWith('$HOME') || token.startsWith('${HOME}') ||
    token.startsWith('$OLDPWD') || token.startsWith('${OLDPWD}') ||
    token.startsWith('$PWD/') || token.startsWith('${PWD}/') ||
    token.includes('/..') || token.includes('../')
}

function hasParentTraversal(token: string): boolean {
  return /(^|\/)(\.\.)(\/|$)/.test(token)
}

function expandPwdPath(token: string, workingDir: string): string | null {
  if (token === '$PWD' || token === '${PWD}') return workingDir
  if (token.startsWith('$PWD/')) return path.resolve(workingDir, token.slice('$PWD/'.length))
  if (token.startsWith('${PWD}/')) return path.resolve(workingDir, token.slice('${PWD}/'.length))
  return null
}

function bashPathReason(
  command: string,
  matched: string,
  kind: string,
  workingDir: string,
  memoryRoot: string,
): string {
  return (
    `Blocked Bash: command "${command}" references ${kind} via "${matched}". ` +
    `Shell access must stay inside ${workingDir}/** or ${memoryRoot}/**.`
  )
}
