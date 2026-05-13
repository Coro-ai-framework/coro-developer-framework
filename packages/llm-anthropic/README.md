# @coro/llm-anthropic

Anthropic Claude phase executor for Coro. Wraps the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (`query()` + bundled CLI) and exposes it through the `PhaseExecutorRuntime` contract from `@coro/plugin-sdk`.

This package owns:

- The `AnthropicExecutor` class (per-phase tool loop, hook policy, subagent dispatch, normalized event emission).
- Anthropic-specific auth env-var construction (`buildAnthropicAuthEnv`).
- Claude Code CLI path resolution (`resolveClaudeCodeCliPath`, `ensureClaudeCodeCliExecutable`).
- The interactive `claude login` OAuth wizard used by the dashboard (`ClaudeLoginManager`).
- The `.claude/CLAUDE.md` symlink helper that lets the SDK's native walk-up discover layered intelligence (`ensureClaudeConfigSymlink`).

The runner ships this package as a hard dependency and registers it in `buildBuiltinPluginRegistry`, so every Coro install supports Anthropic out of the box.
