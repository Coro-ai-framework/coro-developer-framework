// Public surface of the @coro-ai/llm-anthropic package.
//
// The runner imports the executor + helpers from this barrel so internal
// file moves inside this package don't ripple into runner imports.

export {
  AnthropicExecutor,
  ANTHROPIC_MANIFEST,
  createAnthropicExecutor,
  type AnthropicExecutorOptions,
} from './executor'

export {
  ClaudeLoginManager,
  type ClaudeLoginCallbackInput,
  type ClaudeLoginManagerOptions,
  type ClaudeLoginState,
  type ClaudeLoginStatus,
} from './login'

export {
  resolveClaudeCodeCliPath,
  ensureClaudeCodeCliExecutable,
} from './cli-path'

export { buildAnthropicAuthEnv } from './auth'
export { ensureClaudeConfigSymlink } from './intelligence-symlink'
export { buildPhaseHooks, type BuildHookOpts } from './hooks'
export { createPushableInput, type PushableInput } from './pushable'
export { reattachDynamicMcpServers, reattachAllDynamicMcpServers } from './mcp-reattach'
export {
  healMcpTransport,
  isCoroMcpHealthy,
  MCP_RETRY_NUDGE,
  type HealMcpResult,
  type HealMcpTransportOptions,
} from './mcp-heal'
export {
  isRecoverableSteeringAbort,
  isSteeringDiagnosticText,
  isBunSourceFrameLine,
  isMcpTransportErrorText,
  isMcpHealExhaustedError,
  isMcpInputDeadText,
  isMidPhaseStopReason,
  shouldClosePushableAfterResult,
} from './steering-errors'
export { isStaleSessionResumeError } from './session-errors'
export { registerAnthropicHttpRoutes } from './http-routes'
export { testAnthropicCredentials, readClaudeLocalSession } from './test-connection'

export type {
  AnthropicExecutorSettings,
  ClaudeAccountInfo,
  ClaudeAuthConfig,
} from './types'
