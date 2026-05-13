// Public surface of the @coro/llm-anthropic package.
//
// The runner imports the executor + helpers from this barrel so internal
// file moves inside this package don't ripple into runner imports.

export {
  AnthropicExecutor,
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
export { reattachDynamicMcpServers } from './mcp-reattach'

export type {
  AnthropicExecutorSettings,
  ClaudeAccountInfo,
  ClaudeAuthConfig,
} from './types'
