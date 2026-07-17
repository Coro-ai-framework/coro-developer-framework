# @coro-ai/llm-openai

OpenAI Responses API phase executor for Coro.

This package implements the `PhaseExecutorRuntime` contract from `@coro-ai/plugin-sdk` and is designed to be loaded by the runner as plugin id `openai`.

## Capabilities

- Uses the OpenAI Responses API.
- Replays stateless session state through `Job.conversationHistory`.
- Maps the runner's in-process Coro MCP server into OpenAI function tools named `mcp__<server>__<tool>`.
- Enforces per-phase allowed-tools and write-root hook policy before every tool call.
- Reports normalized token usage and derives cost from the package model catalogue.

## Configuration

```json
{
  "plugins": {
    "installed": {
      "openai": {
        "enabled": true,
        "config": {
          "apiKey": "sk-...",
          "defaultModel": "gpt-5.6-terra"
        }
      }
    }
  },
  "llm": {
    "defaultProvider": "openai",
    "aliases": {
      "planning": { "provider": "openai", "model": "gpt-5.6-sol", "reasoningEffort": "high" },
      "coding": { "provider": "openai", "model": "gpt-5.6-terra", "reasoningEffort": "medium" }
    }
  }
}
```

`apiKey` may be omitted when `OPENAI_API_KEY` is set in the runner environment.

Optional config fields:

- `baseURL` — OpenAI-compatible endpoint override.
- `organization` — OpenAI organization id.
- `project` — OpenAI project id.
- `defaultModel` — fallback model when a phase resolves no explicit model.

## Notes

External plugin MCP servers using `stdio`, `http`, or `sse` transports are not directly dialed by this package yet. The runner's in-process `coro` MCP server is fully supported and includes SCM/tracker proxies plus file and skill tools when the active executor lacks native equivalents.
