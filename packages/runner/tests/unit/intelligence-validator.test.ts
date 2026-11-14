import { describe, expect, it } from 'vitest'

import { inferKind, validateArtefact } from '../../src/intelligence-validator'

const AGENT = '---\nname: coder\ndescription: Implements one work item.\n---\n\n# Agent: Coder\n\nDo the work, then report back with a summary of what changed.\n'

const WORKFLOW = `---
display_name: Demo
initial_phase: planning
initial_status: queued
phases:
  - name: planning
    agent: .claude/agents/planner.md
    status: planning
---

# Workflow: Demo
`

describe('inferKind (native layout)', () => {
  it('maps the native folders to artefact kinds', () => {
    expect(inferKind('.claude/commands/coro/job.md')).toBe('workflow')
    expect(inferKind('.claude/agents/coder.md')).toBe('agent')
    expect(inferKind('.claude/skills/foo/SKILL.md')).toBe('skill')
    expect(inferKind('.claude/memory/MEMORY.md')).toBe('memory')
  })

  it('does not recognise the pre-native folders', () => {
    expect(inferKind('workflows/job/workflow.md')).toBeNull()
    expect(inferKind('agents/coder.md')).toBeNull()
    expect(inferKind('memory/MEMORY.md')).toBeNull()
  })

  it('leaves the ambient rules and runtime contract unclassified', () => {
    expect(inferKind('.claude/CLAUDE.md')).toBeNull()
    expect(inferKind('.claude/coro/RUNTIME.md')).toBeNull()
  })
})

describe('validateArtefact — agent', () => {
  it('accepts a Claude Code subagent with name, description and an H1', () => {
    const result = validateArtefact('agent', '.claude/agents/coder.md', AGENT)
    expect(result).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('requires front matter, because Claude Code never discovers an agent without it', () => {
    const result = validateArtefact('agent', '.claude/agents/coder.md', '# Agent: Coder\n\nBody.\n')
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('front matter')
  })

  it('requires both name and description', () => {
    const noName = validateArtefact('agent', '.claude/agents/coder.md', '---\ndescription: x\n---\n\n# Coder\n')
    expect(noName.errors).toContain('front matter: name (string) is required')

    const noDescription = validateArtefact('agent', '.claude/agents/coder.md', '---\nname: coder\n---\n\n# Coder\n')
    expect(noDescription.errors).toContain('front matter: description (string) is required')
  })

  it('still requires an H1 after the front matter', () => {
    const result = validateArtefact(
      'agent',
      '.claude/agents/coder.md',
      '---\nname: coder\ndescription: Codes.\n---\n\nNo heading here.\n',
    )
    expect(result.errors.join(' ')).toContain('H1')
  })

  it('warns when the name differs from the file name', () => {
    const result = validateArtefact(
      'agent',
      '.claude/agents/coder.md',
      AGENT.replace('name: coder', 'name: builder'),
    )
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toContain('does not match file name')
  })

  it('rejects the pre-native path and nested folders', () => {
    expect(validateArtefact('agent', 'agents/coder.md', AGENT).errors.join(' ')).toContain('.claude/agents/<name>.md')
    expect(validateArtefact('agent', '.claude/agents/sub/coder.md', AGENT).ok).toBe(false)
  })
})

describe('validateArtefact — workflow', () => {
  it('accepts a command with phases at .claude/commands/coro/<id>.md', () => {
    const result = validateArtefact('workflow', '.claude/commands/coro/demo.md', WORKFLOW)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects the pre-native path', () => {
    const result = validateArtefact('workflow', 'workflows/demo/workflow.md', WORKFLOW)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('.claude/commands/coro/<id>.md')
  })

  it('rejects a command nested below the coro folder', () => {
    expect(validateArtefact('workflow', '.claude/commands/coro/sub/demo.md', WORKFLOW).ok).toBe(false)
  })
})

describe('validateArtefact — shared rules', () => {
  it('rejects empty content', () => {
    expect(validateArtefact('memory', '.claude/memory/x.md', '  \n').errors).toContain('content is empty')
  })

  it('treats memory as permissive', () => {
    const result = validateArtefact('memory', '.claude/memory/x.md', 'plain note without a heading')
    expect(result.ok).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
