import type { ExecutorCapabilities } from '@coro-ai/plugin-sdk'

/**
 * Workflow `tools:` lists name Claude Code's built-ins (`Read`, `Bash`, …).
 * Executors without those built-ins get the runner's MCP equivalents
 * instead (see `registerFileTools` / `registerWebTools` in `mcp-server.ts`),
 * which are called under different names — so an untranslated allowlist
 * blocks every file and shell call the workflow meant to permit.
 */
const FILE_TOOL_EQUIVALENTS: Record<string, string> = {
  Read: 'mcp__coro__file_read',
  Write: 'mcp__coro__file_write',
  Edit: 'mcp__coro__file_edit',
  Glob: 'mcp__coro__file_glob',
  Grep: 'mcp__coro__file_grep',
  Bash: 'mcp__coro__shell',
  Skill: 'mcp__coro__read_skill',
}

const WEB_TOOL_EQUIVALENTS: Record<string, string> = {
  WebFetch: 'mcp__coro__web_fetch',
}

/**
 * Returns `tools` plus the runner MCP equivalent of every Claude built-in
 * it names that `capabilities` says the executor lacks. Original entries are
 * kept so the list stays valid if the same policy reaches a native executor.
 */
export function withRunnerToolEquivalents(
  tools: ReadonlyArray<string>,
  capabilities: Pick<ExecutorCapabilities, 'supportsNativeFileTools' | 'supportsNativeWebTools'>,
): string[] {
  const out = new Set(tools)
  for (const name of tools) {
    if (!capabilities.supportsNativeFileTools && FILE_TOOL_EQUIVALENTS[name]) {
      out.add(FILE_TOOL_EQUIVALENTS[name])
    }
    if (capabilities.supportsNativeWebTools !== true && WEB_TOOL_EQUIVALENTS[name]) {
      out.add(WEB_TOOL_EQUIVALENTS[name])
    }
  }
  return [...out]
}
