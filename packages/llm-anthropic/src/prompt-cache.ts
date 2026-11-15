// Claude Code writes prompt-cache entries with a 1-hour TTL for subscriber
// (Claude login) sessions, billed at 2x input versus 1.25x for 5 minutes.
// Phase turns run seconds apart and every phase rebuilds its prefix, so the
// longer TTL rarely gets a hit. An operator who sets any of the CLI's own
// TTL variables keeps their choice.
const OPERATOR_TTL_ENV = [
  'FORCE_PROMPT_CACHING_5M',
  'CLAUDE_CODE_PROMPT_CACHE_TTL',
  'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
  'ENABLE_PROMPT_CACHING_1H',
] as const

export function promptCacheTtlEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (OPERATOR_TTL_ENV.some(name => env[name] !== undefined && env[name] !== '')) return {}
  return { FORCE_PROMPT_CACHING_5M: '1' }
}
