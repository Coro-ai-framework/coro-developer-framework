// ── MCP server primitives ────────────────────────────────────────────────────
//
// The Anthropic Claude Agent SDK ships an in-process MCP server helper
// (`createSdkMcpServer` + the `tool()` builder) that implements the open
// MCP protocol. Coro re-exports it through `@coro/plugin-sdk` so the
// runner core (and any future executor plugin that wants to host
// in-process tools) can build MCP servers without taking a direct
// dependency on `@anthropic-ai/claude-agent-sdk`.
//
// The MCP wire protocol is open and provider-agnostic; treat this as a
// transport library that happens to be authored by Anthropic.

export { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
export type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk'
