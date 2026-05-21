import os from 'node:os'
import path from 'node:path'
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from 'pino'
import type { HookPolicy } from '@coro/plugin-sdk'

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
  /** Runner-injected policy (guardrails, proposals, …). */
  hookPolicy?: HookPolicy
  /** When false, MCP tools are blocked until transport heal completes. */
  getMcpTransportReady?: () => boolean
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

    if (toolName.startsWith('mcp__') && opts.getMcpTransportReady && !opts.getMcpTransportReady()) {
      const reason =
        'MCP transport is rebuilding after a developer message. Wait a moment and retry the same tool call.'
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

    const pre = opts.hookPolicy?.onPreToolUse
    if (pre) {
      const decision = await pre(toolName, toolInput)
      if (!decision.allow) {
        const reason = decision.reason ?? `Blocked ${toolName} by runner policy.`
        opts.logger.warn({ phase: opts.liveJobRef().phase, toolName }, reason)
        return deny(reason)
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
  if (rel === '' || rel === '.') return true
  if (path.isAbsolute(rel)) return false
  // Must be exactly `..` or start with `../` (or `..\` on Windows) — not
  // just any string beginning with two dots (Go's `./...` build target
  // produces a relative of `...`, which is NOT a parent escape).
  return rel !== '..' && !rel.startsWith('..' + path.sep)
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

// Subpaths under $HOME that language toolchains use as their package /
// module caches. These MUST be writable for `go get`, `dotnet restore`,
// `npm install`, `cargo build`, etc. to function — without these the
// agent ends up reinventing vendoring against a non-existent network
// allowlist. The list is intentionally narrow: anything else under $HOME
// (dotfiles, SSH keys, AWS creds, sibling source repos) stays blocked.
const HOME_CACHE_SUBPATHS: readonly string[] = [
  'go/',           // Go module cache (GOPATH/pkg/mod, GOMODCACHE)
  '.cache/',       // pip wheel cache, yarn, generic XDG cache
  '.nuget/',       // .NET package cache
  '.npm/',         // npm global cache
  '.yarn/',        // yarn berry cache
  '.pnpm-store/',  // pnpm store
  '.m2/',          // Maven
  '.gradle/',      // Gradle
  '.cargo/',       // Rust cargo registry + git cache
  '.rustup/',      // Rust toolchain
  '.pub-cache/',   // Dart / Flutter
  '.ivy2/',        // Scala SBT
  '.sbt/',
  '.gem/',         // Ruby gems
  '.bundle/',      // Ruby bundler
  '.pyenv/',       // Python version mgr
  '.nvm/',         // Node version mgr
  '.rbenv/',       // Ruby version mgr
  '.sdkman/',      // JVM tooling mgr
  '.dotnet/',      // .NET SDKs / tools
  '.local/share/',
  '.local/state/',
  '.terraform.d/',
]

const HOME_DIR_ABS: string = (() => {
  const h = os.homedir()
  return h.endsWith('/') ? h.slice(0, -1) : h
})()

const ALLOWED_HOME_RELATIVE_PREFIXES: readonly string[] = HOME_CACHE_SUBPATHS.flatMap((sub) => [
  `~/${sub}`,
  `$HOME/${sub}`,
  `\${HOME}/${sub}`,
])

const ALLOWED_HOME_ABSOLUTE_PREFIXES: readonly string[] = HOME_CACHE_SUBPATHS.map(
  (sub) => `${HOME_DIR_ABS}/${sub}`,
)

function getBashPathDenialReason(command: string, workingDir: string, memoryRoot: string): string | null {
  // Sanitise the command before tokenising: heredoc bodies are *data*,
  // not commands, and shell comments are noise. Both used to produce
  // false positives (e.g. Go source written via `cat << 'EOF'` had its
  // `// comment` lines tokenised and rejected as "absolute paths").
  const sanitised = stripHeredocBodies(stripShellComments(command))

  // Detect a leading `cd <subdir> && …` (or `;`, `||`) so that
  // `../sibling` references after the cd resolve against the cd target
  // instead of workingDir. Without this, the agent is forced to write
  // absolute paths for any sibling-repo access — the most common false
  // positive in monorepo / multi-clone jobs. Only honoured if the cd
  // target stays inside workingDir (a `cd /etc &&` cannot widen the
  // allow zone).
  const cdTarget = extractLeadingCdTarget(sanitised)
  const cdAbs = cdTarget ? path.resolve(workingDir, cdTarget) : null
  const effectiveCwd = cdAbs && isInside(cdAbs, workingDir) ? cdAbs : workingDir

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

    // Whitelist language package caches under $HOME (Go modules, NuGet,
    // npm, cargo, Maven, …). Without this the agent cannot run
    // `go get`, `dotnet restore`, etc. and burns turns inventing
    // workarounds against a non-existent network allowlist.
    if (isAllowedHomeCachePath(candidate)) continue

    if (candidate === '~' || candidate.startsWith('~/')) {
      return bashPathReason(command, candidate, 'home-relative path', workingDir, memoryRoot)
    }

    if (
      candidate.includes('$HOME') || candidate.includes('${HOME}') ||
      candidate.includes('$OLDPWD') || candidate.includes('${OLDPWD}')
    ) {
      return bashPathReason(command, candidate, 'home-directory environment reference', workingDir, memoryRoot)
    }

    // Resolve `$PWD/…`, `./…`, `../…`, and the bare tokens `.`/`..`
    // against the effective cwd (workingDir, adjusted for leading `cd`).
    // Allow if the resolved path lands inside workingDir or memoryRoot;
    // block otherwise.
    const relResolved = resolveRelativeToCwd(candidate, effectiveCwd, workingDir)
    if (relResolved) {
      if (isInside(relResolved, workingDir) || isInside(relResolved, memoryRoot)) continue
      return bashPathReason(command, candidate, `path ${relResolved}`, workingDir, memoryRoot)
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
  for (const prefix of ALLOWED_HOME_ABSOLUTE_PREFIXES) {
    if (candidate.startsWith(prefix)) return true
  }
  return false
}

function isAllowedHomeCachePath(candidate: string): boolean {
  for (const prefix of ALLOWED_HOME_RELATIVE_PREFIXES) {
    if (candidate.startsWith(prefix)) return true
  }
  for (const prefix of ALLOWED_HOME_ABSOLUTE_PREFIXES) {
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

/**
 * Parse a leading `cd <target> &&|;|||` from a sanitised command and
 * return the cd target (raw, possibly relative). Returns null if the
 * command does not start with a `cd` of the recognised shape. Quoted
 * targets are unquoted.
 */
function extractLeadingCdTarget(command: string): string | null {
  const m = command.match(/^\s*cd\s+(?:--\s+)?("([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;|\|\|)/)
  if (!m) return null
  const target = m[2] ?? m[3] ?? m[4] ?? null
  if (!target) return null
  // Skip cd targets that would themselves require resolution against an
  // unknown cwd (e.g. `cd $HOME`); the conservative thing is to ignore
  // the cd and let the rest of the scanner block as usual.
  if (target.startsWith('~') || target.includes('$') || target === '-') return null
  return target
}

/**
 * Resolve a relative path reference (`./x`, `../x`, `.`, `..`,
 * `$PWD/x`, `${PWD}/x`, or a bare token treated as relative because of
 * a `..` component) against the supplied effective cwd. Returns the
 * absolute resolved path, or null if the token is not a relative
 * reference.
 */
function resolveRelativeToCwd(token: string, effectiveCwd: string, workingDir: string): string | null {
  // `$PWD` is the per-call shell cwd which, absent a leading `cd`, is
  // always workingDir. Honour it explicitly so the resolution lines up
  // with whatever the shell would actually do.
  if (token === '$PWD' || token === '${PWD}') return workingDir
  if (token.startsWith('$PWD/')) return path.resolve(workingDir, token.slice('$PWD/'.length))
  if (token.startsWith('${PWD}/')) return path.resolve(workingDir, token.slice('${PWD}/'.length))

  if (
    token === '.' || token === '..' ||
    token.startsWith('./') || token.startsWith('../')
  ) {
    return path.resolve(effectiveCwd, token)
  }

  // A bare relative path with an embedded `..` (e.g. `foo/../bar`) is
  // also a traversal we want to resolve and check.
  if (!token.startsWith('/') && hasParentTraversal(token)) {
    return path.resolve(effectiveCwd, token)
  }

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
    `Shell access must stay inside ${workingDir}/** or ${memoryRoot}/**. ` +
    `Note: each Bash invocation starts fresh at ${workingDir}, so a prior \`cd\` ` +
    `does NOT persist across calls. To reach a sibling path inside the working dir, ` +
    `either chain the cd in the same command (\`cd subdir && cat ../sibling/file\`) ` +
    `or use an absolute path (\`cat ${workingDir}/sibling/file\` or \`cat $PWD/sibling/file\`).`
  )
}
