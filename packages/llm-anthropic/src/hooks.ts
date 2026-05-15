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

// Absolute-path prefixes that we always treat as safe references in Bash
// commands. The agent legitimately needs to read system binaries, redirect
// to /dev/null, write scratch files in $TMPDIR, etc. The original guard
// rail's intent is to keep the agent out of the **user's** filesystem
// ($HOME, sibling repos, dotfiles) — not to forbid ever mentioning a
// system path. Anything under one of these prefixes is allowed without
// further checks.
const ALLOWED_ABSOLUTE_PREFIXES: readonly string[] = [
  '/dev/',
  '/tmp/',
  '/private/tmp/',
  '/private/var/folders/',
  '/var/folders/',
  '/var/tmp/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/opt/',
  '/etc/',
  '/Library/',
  '/System/',
  '/Applications/',
  '/proc/',
  '/sys/',
  '/run/',
]

const ALLOWED_ABSOLUTE_EXACT: ReadonlySet<string> = new Set([
  '/dev', '/tmp', '/usr', '/bin', '/sbin', '/opt', '/etc',
  '/Library', '/System', '/Applications', '/proc', '/sys', '/run',
])

function getBashPathDenialReason(command: string, workingDir: string, memoryRoot: string): string | null {
  // Sanitise the command before tokenising: heredoc bodies are *data*,
  // not commands, and shell comments are noise. Both used to produce
  // false positives (e.g. Go source written via `cat << 'EOF'` had its
  // `// comment` lines tokenised and rejected as "absolute paths").
  const sanitised = stripHeredocBodies(stripShellComments(command))

  for (const rawToken of tokenizeShellCommand(sanitised)) {
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
      if (isAllowedAbsolutePath(candidate)) continue
      const abs = path.resolve(candidate)
      if (!isInside(abs, workingDir) && !isInside(abs, memoryRoot)) {
        return bashPathReason(command, candidate, `path ${abs}`, workingDir, memoryRoot)
      }
    }
  }

  return null
}

function isAllowedAbsolutePath(candidate: string): boolean {
  if (ALLOWED_ABSOLUTE_EXACT.has(candidate)) return true
  for (const prefix of ALLOWED_ABSOLUTE_PREFIXES) {
    if (candidate.startsWith(prefix)) return true
  }
  return false
}

function isClaudeTaskOutputPath(token: string): boolean {
  return token.startsWith('/private/tmp/claude-')
    && token.includes('/tasks/')
    && token.endsWith('.output')
}

function tokenizeShellCommand(command: string): string[] {
  return command.match(/'[^']*'|"[^"]*"|`[^`]*`|\S+/g) ?? []
}

/**
 * Remove heredoc bodies. The body of a `<<TAG`/`<<'TAG'`/`<<-TAG`
 * heredoc is data piped into the command's stdin — it must not be
 * scanned for paths or it will reject any file containing `//` (Go
 * comments), `/usr/...` mentions, etc.
 */
function stripHeredocBodies(command: string): string {
  // Match `<<` or `<<-`, optional quotes, capture the delimiter tag.
  const heredocStart = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  let result = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = heredocStart.exec(command)) !== null) {
    const tag = match[2]
    // Append everything up to and including the heredoc start marker.
    const startEnd = match.index + match[0].length
    result += command.slice(cursor, startEnd)
    // Find the closing delimiter on its own line (allow leading
    // whitespace for `<<-`).
    const closer = new RegExp(`\\n[\\t ]*${tag}(?=\\s|$)`)
    const tail = command.slice(startEnd)
    const closeMatch = closer.exec(tail)
    if (!closeMatch) {
      // Unterminated — just drop the rest to be safe.
      cursor = command.length
      break
    }
    // Skip the body, keep the closing delimiter.
    const closeAbs = startEnd + closeMatch.index + closeMatch[0].length
    cursor = closeAbs
    heredocStart.lastIndex = closeAbs
  }
  result += command.slice(cursor)
  return result
}

/**
 * Drop shell-style `# comments` outside of single/double/back quotes.
 * Conservative: only treats `#` as a comment when preceded by start-of-
 * string or whitespace.
 */
function stripShellComments(command: string): string {
  let out = ''
  let inSingle = false
  let inDouble = false
  let inBack = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const prev = i === 0 ? ' ' : command[i - 1]
    if (!inDouble && !inBack && ch === '\'' && prev !== '\\') { inSingle = !inSingle; out += ch; continue }
    if (!inSingle && !inBack && ch === '"' && prev !== '\\') { inDouble = !inDouble; out += ch; continue }
    if (!inSingle && !inDouble && ch === '`' && prev !== '\\') { inBack = !inBack; out += ch; continue }
    if (!inSingle && !inDouble && !inBack && ch === '#' && /\s/.test(prev)) {
      // Skip to end of line.
      const nl = command.indexOf('\n', i)
      if (nl === -1) return out
      out += '\n'
      i = nl
      continue
    }
    out += ch
  }
  return out
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
  // `//` is almost never a filesystem path in practice (Go comments,
  // URLs, doubled-separator typos). Treat any token starting with `//`
  // as a non-path so we don't reject `// TODO` lines or `https://...`.
  if (token.startsWith('//')) return false
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
