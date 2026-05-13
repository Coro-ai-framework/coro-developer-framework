// ── runner-internals.test.ts ─────────────────────────────────────────────────
//
// Lockdown tests for the pure helpers inside `src/jobs/runner.ts` that the
// PhaseExecutor refactor (Phase 1+) will move behind a plugin seam. The
// behavior they encode today must survive that refactor unchanged:
//
//   selectModel                — model alias → concrete Anthropic model id.
//   derivePhaseCostUsd         — fresh-vs-resumed-session cost reconciliation.
//   buildSubagentDefinitions   — subagent prompt assembly (CLAUDE.md prelude,
//                                agent.md body, tools whitelist, MCP server
//                                attachment, model-tier mapping).
//
// These tests run without spawning Claude or touching disk-bound config —
// every dependency is a literal fixture.

import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  selectModel,
  derivePhaseCostUsd,
  buildSubagentDefinitions,
} from '../../src/jobs/runner'
import type { Settings } from '../../src/config/settings'
import type { SubagentConfig } from '../../src/workflow-parser'
import type { McpSdkServerConfig, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSettings(overrides: { planning?: string; coding?: string } = {}): Settings {
  return {
    claude: {
      auth: { method: 'apiKey', apiKey: 'sk-test' },
      planningModel: overrides.planning ?? 'claude-opus-4',
      codingModel: overrides.coding ?? 'claude-sonnet-4',
    },
  } as unknown as Settings
}

function makeMcpServer(): McpSdkServerConfig {
  return { type: 'sdk', name: 'coro', version: '0.1.0' } as unknown as McpSdkServerConfig
}

// ── selectModel ──────────────────────────────────────────────────────────────

describe('selectModel', () => {
  const settings = makeSettings({ planning: 'claude-opus-4', coding: 'claude-sonnet-4' })

  it('defaults to the planning model when phaseConf is null', () => {
    expect(selectModel(null, settings)).toBe('claude-opus-4')
  })

  it('defaults to the planning model when phaseConf is undefined', () => {
    expect(selectModel(undefined, settings)).toBe('claude-opus-4')
  })

  it('defaults to the planning model when phaseConf.model is missing', () => {
    expect(selectModel({}, settings)).toBe('claude-opus-4')
  })

  it('returns the planning model for model: "planning"', () => {
    expect(selectModel({ model: 'planning' }, settings)).toBe('claude-opus-4')
  })

  it('returns the coding model for model: "coding"', () => {
    expect(selectModel({ model: 'coding' }, settings)).toBe('claude-sonnet-4')
  })

  it('treats every non-"coding" value as planning (forward-compat)', () => {
    // The Phase 1 refactor will swap this to a literal model-id passthrough,
    // but until then the contract is "coding" → coding-model, otherwise
    // planning-model. Documented here so the migration test catches drift.
    expect(selectModel({ model: 'reasoning' }, settings)).toBe('claude-opus-4')
    expect(selectModel({ model: '' }, settings)).toBe('claude-opus-4')
  })
})

// ── derivePhaseCostUsd ───────────────────────────────────────────────────────

describe('derivePhaseCostUsd', () => {
  const billable = {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }

  it('returns 0 when no phase tokens were billed (avoids ghost charges)', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.42,
        phaseTokens: zero,
        prePhaseCostUsd: 0,
      }),
    ).toBe(0)
  })

  it('returns the full reported cost on a fresh (non-resumed) session', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.05,
        phaseTokens: billable,
        prePhaseCostUsd: 0.02, // ignored for fresh sessions
      }),
    ).toBe(0.05)
  })

  it('subtracts the pre-phase baseline when the session was resumed', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.5,
        phaseTokens: billable,
        prePhaseCostUsd: 0.3,
        resumedSessionId: 'sess-abc',
      }),
    ).toBeCloseTo(0.2, 8)
  })

  it('falls back to the raw reported cost if delta is negative (defensive)', () => {
    // Anthropic occasionally reports a smaller cumulative cost than what we
    // already booked (rounding, retried frames). Booking a negative delta
    // would corrupt the running total, so we keep the raw value.
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.05,
        phaseTokens: billable,
        prePhaseCostUsd: 0.4,
        resumedSessionId: 'sess-xyz',
      }),
    ).toBe(0.05)
  })

  it('treats non-numeric / negative reportedTotalCostUsd as 0', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 'not a number',
        phaseTokens: billable,
        prePhaseCostUsd: 0,
      }),
    ).toBe(0)
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: -1.5,
        phaseTokens: billable,
        prePhaseCostUsd: 0,
      }),
    ).toBe(0)
  })

  it('counts cache-only usage as billable', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.01,
        phaseTokens: { ...zero, cacheReadInputTokens: 200 },
        prePhaseCostUsd: 0,
      }),
    ).toBe(0.01)
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.01,
        phaseTokens: { ...zero, cacheCreationInputTokens: 200 },
        prePhaseCostUsd: 0,
      }),
    ).toBe(0.01)
  })
})

// ── buildSubagentDefinitions ─────────────────────────────────────────────────

function makeIntelligenceDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'coro-intelligence-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}

describe('buildSubagentDefinitions', () => {
  const settings = makeSettings({ planning: 'claude-opus-4', coding: 'claude-sonnet-4' })
  const mcpServer = makeMcpServer()

  it('emits one entry per subagent keyed by name', () => {
    const dir = makeIntelligenceDir({})
    const subs: SubagentConfig[] = [
      { name: 'reviewer' },
      { name: 'tester' },
    ]
    const defs = buildSubagentDefinitions(subs, dir, settings, mcpServer) as Record<string, any>
    expect(Object.keys(defs).sort()).toEqual(['reviewer', 'tester'])
  })

  it('prepends .claude/CLAUDE.md to the agent prompt when it exists', () => {
    const dir = makeIntelligenceDir({
      '.claude/CLAUDE.md': 'BASE-RULES',
      'agents/reviewer.md': 'REVIEWER-BODY',
    })
    const defs = buildSubagentDefinitions(
      [{ name: 'reviewer', agent: 'agents/reviewer.md' }],
      dir,
      settings,
      mcpServer,
    ) as Record<string, { prompt: string }>
    expect(defs.reviewer.prompt.startsWith('BASE-RULES')).toBe(true)
    expect(defs.reviewer.prompt).toContain('REVIEWER-BODY')
    expect(defs.reviewer.prompt).toContain('---')
  })

  it('falls back to a generic prompt when the agent.md path is missing', () => {
    const dir = makeIntelligenceDir({})
    const defs = buildSubagentDefinitions(
      [{ name: 'planner', agent: 'agents/does-not-exist.md' }],
      dir,
      settings,
      mcpServer,
    ) as Record<string, { prompt: string }>
    expect(defs.planner.prompt).toContain('planner subagent')
  })

  it('uses the bare "You are a helper subagent" prompt when no agent path is set', () => {
    const dir = makeIntelligenceDir({})
    const defs = buildSubagentDefinitions(
      [{ name: 'tester' }],
      dir,
      settings,
      mcpServer,
    ) as Record<string, { prompt: string }>
    expect(defs.tester.prompt).toBe('You are a helper subagent named tester.')
  })

  it('forwards a tools whitelist when one is set, and omits the field otherwise', () => {
    const dir = makeIntelligenceDir({})
    const defs = buildSubagentDefinitions(
      [
        { name: 'narrow', tools: ['Read', 'Grep'] },
        { name: 'wide' },
      ],
      dir,
      settings,
      mcpServer,
    ) as Record<string, { tools?: string[] }>
    expect(defs.narrow.tools).toEqual(['Read', 'Grep'])
    expect(defs.wide.tools).toBeUndefined()
  })

  it('maps model: "coding" → "opus" when codingModel contains "opus"', () => {
    const dir = makeIntelligenceDir({})
    const codingSettings = makeSettings({ planning: 'claude-opus-4', coding: 'claude-opus-4' })
    const defs = buildSubagentDefinitions(
      [{ name: 'big', model: 'coding' }],
      dir,
      codingSettings,
      mcpServer,
    ) as Record<string, { model: string }>
    expect(defs.big.model).toBe('opus')
  })

  it('maps model: "coding" → "sonnet" when codingModel does not contain "opus"', () => {
    const dir = makeIntelligenceDir({})
    const defs = buildSubagentDefinitions(
      [{ name: 'small', model: 'coding' }],
      dir,
      settings, // codingModel = claude-sonnet-4
      mcpServer,
    ) as Record<string, { model: string }>
    expect(defs.small.model).toBe('sonnet')
  })

  it('defaults model to "inherit" when subagent does not declare one', () => {
    const dir = makeIntelligenceDir({})
    const defs = buildSubagentDefinitions(
      [{ name: 'helper' }],
      dir,
      settings,
      mcpServer,
    ) as Record<string, { model: string }>
    expect(defs.helper.model).toBe('inherit')
  })

  it('attaches the Coro MCP server plus every plugin MCP server to each subagent', () => {
    const dir = makeIntelligenceDir({})
    const pluginMcp: Record<string, McpServerConfig> = {
      gitlab: { type: 'http', url: 'https://example/mcp' } as unknown as McpServerConfig,
      jira: { type: 'sdk', name: 'jira' } as unknown as McpServerConfig,
    }
    const defs = buildSubagentDefinitions(
      [{ name: 'helper' }],
      dir,
      settings,
      mcpServer,
      pluginMcp,
    ) as Record<string, { mcpServers: Array<Record<string, unknown>> }>
    expect(defs.helper.mcpServers).toHaveLength(1)
    const record = defs.helper.mcpServers[0]
    expect(Object.keys(record).sort()).toEqual(['coro', 'gitlab', 'jira'])
    expect(record.coro).toBe(mcpServer)
    expect(record.gitlab).toBe(pluginMcp.gitlab)
  })
})
