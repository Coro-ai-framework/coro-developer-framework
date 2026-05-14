// Public surface of the @coro/llm-openai package.

export {
  OpenAiExecutor,
  OPENAI_MANIFEST,
  createOpenAiExecutor,
  type OpenAiExecutorOptions,
} from './executor'

export {
  OPENAI_PLUGIN_ID,
  OPENAI_MODELS,
  supportsOpenAiModel,
  calculateOpenAiCostUsd,
} from './models'

export {
  resolveOpenAiClientOptions,
  hasOpenAiApiKey,
} from './auth'

export type {
  OpenAiAuthConfig,
  OpenAiClientOptions,
  OpenAiExecutorSettings,
} from './types'

export {
  McpFunctionBridge,
  type OpenAiFunctionTool,
  type OpenAiToolCall,
  type OpenAiFunctionOutputItem,
} from './mcp-bridge'
