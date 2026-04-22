import { describe, it, expect } from 'vitest'
import {
  parseWorkflowConfig,
  stripFrontMatter,
  getNextPhase,
  getPhaseConfig,
  resolveInitialPhase,
} from '../../src/workflow-parser'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function md(yaml: string, body = '# Workflow'): string {
  return `---\n${yaml}\n---\n\n${body}`
}

const MINIMAL_YAML = `
initial_phase: planning
initial_status: queued
phases:
  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning
`

const MULTI_PHASE_YAML = `
initial_phase: analysis
initial_status: queued
phases:
  - name: analysis
    agent: agents/analyzer.md
    model: planning
    status: analyzing
  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning
  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
  - name: testing
    agent: agents/tester.md
    model: coding
    status: testing
`

const WITH_SUBAGENTS_YAML = `
initial_phase: coding
phases:
  - name: coding
    agent: agents/coder.md
    model: coding
    status: coding
    subagents:
      - name: code-reviewer
        agent: agents/pr-reviewer.md
        model: coding
        tools: [Read, Glob, Grep]
      - name: linter
        tools: [Bash]
`

const WITH_OVERRIDES_YAML = `
initial_phase: planning
phases:
  - name: spec-writing
    agent: agents/spec-writer.md
    model: planning
    status: spec-writing
  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning
overrides:
  jira:
    initial_phase: spec-writing
  internal:
    initial_phase: planning
`

// ── parseWorkflowConfig ───────────────────────────────────────────────────────

describe('parseWorkflowConfig', () => {
  describe('valid inputs', () => {
    it('parses a minimal workflow with one phase', () => {
      const config = parseWorkflowConfig(md(MINIMAL_YAML))
      expect(config).not.toBeNull()
      expect(config!.initialPhase).toBe('planning')
      expect(config!.initialStatus).toBe('queued')
      expect(config!.phases).toHaveLength(1)
      expect(config!.phases[0]).toEqual({
        name: 'planning',
        agent: 'agents/planner.md',
        model: 'planning',
        status: 'planning',
      })
    })

    it('parses multiple phases in order', () => {
      const config = parseWorkflowConfig(md(MULTI_PHASE_YAML))!
      expect(config.phases).toHaveLength(4)
      expect(config.phases.map(p => p.name)).toEqual([
        'analysis', 'planning', 'coding', 'testing',
      ])
    })

    it('maps model "coding" correctly', () => {
      const config = parseWorkflowConfig(md(MULTI_PHASE_YAML))!
      expect(config.phases[0].model).toBe('planning')
      expect(config.phases[2].model).toBe('coding')
    })

    it('parses subagent definitions', () => {
      const config = parseWorkflowConfig(md(WITH_SUBAGENTS_YAML))!
      const coding = config.phases[0]
      expect(coding.subagents).toBeDefined()
      expect(coding.subagents).toHaveLength(2)
      expect(coding.subagents![0]).toEqual({
        name: 'code-reviewer',
        agent: 'agents/pr-reviewer.md',
        model: 'coding',
        tools: ['Read', 'Glob', 'Grep'],
      })
      expect(coding.subagents![1]).toEqual({
        name: 'linter',
        agent: undefined,
        model: undefined,
        tools: ['Bash'],
      })
    })

    it('parses trigger-specific overrides', () => {
      const config = parseWorkflowConfig(md(WITH_OVERRIDES_YAML))!
      expect(config.overrides).toEqual({
        jira: { initialPhase: 'spec-writing' },
        internal: { initialPhase: 'planning' },
      })
    })

    it('does not include subagents when phase has none', () => {
      const config = parseWorkflowConfig(md(MINIMAL_YAML))!
      expect(config.phases[0].subagents).toBeUndefined()
    })
  })

  describe('defaults and fallbacks', () => {
    it('defaults initialPhase to first phase name when omitted', () => {
      const yaml = `
phases:
  - name: alpha
    model: planning
  - name: beta
    model: coding
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.initialPhase).toBe('alpha')
    })

    it('defaults initialStatus to "queued" when omitted', () => {
      const yaml = `
phases:
  - name: work
    model: planning
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.initialStatus).toBe('queued')
    })

    it('defaults agent to null when omitted', () => {
      const yaml = `
phases:
  - name: init
    model: planning
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].agent).toBeNull()
    })

    it('defaults status to phase name when omitted', () => {
      const yaml = `
phases:
  - name: my-phase
    model: coding
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].status).toBe('my-phase')
    })

    it('defaults model to "planning" for unrecognized model values', () => {
      const yaml = `
phases:
  - name: work
    model: turbo
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].model).toBe('planning')
    })

    it('defaults overrides to empty object when omitted', () => {
      const config = parseWorkflowConfig(md(MINIMAL_YAML))!
      expect(config.overrides).toEqual({})
    })
  })

  describe('null/invalid returns', () => {
    it('returns null for markdown with no front matter', () => {
      expect(parseWorkflowConfig('# Just a heading\n\nSome text.')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(parseWorkflowConfig('')).toBeNull()
    })

    it('returns null for front matter with invalid YAML', () => {
      const broken = '---\n  invalid: [yaml: that: breaks\n---\n\n# Doc'
      expect(parseWorkflowConfig(broken)).toBeNull()
    })

    it('returns null when phases key is missing', () => {
      expect(parseWorkflowConfig(md('initial_phase: init'))).toBeNull()
    })

    it('returns null when phases is an empty array', () => {
      expect(parseWorkflowConfig(md('phases: []'))).toBeNull()
    })

    it('returns null when phases is not an array', () => {
      expect(parseWorkflowConfig(md('phases: "not-an-array"'))).toBeNull()
    })

    it('returns null when all phases lack a name', () => {
      const yaml = `
phases:
  - model: planning
  - agent: foo.md
`
      expect(parseWorkflowConfig(md(yaml))).toBeNull()
    })

    it('returns null when front matter is just "---\\n---"', () => {
      expect(parseWorkflowConfig('---\n\n---\n\n# Doc')).toBeNull()
    })
  })

  describe('knowledge and conventions metadata', () => {
    it('parses knowledge array from phase', () => {
      const yaml = `
phases:
  - name: analysis
    agent: agents/analyzer.md
    model: planning
    knowledge: [knowledge/migration/analysis-guide.md]
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].knowledge).toEqual(['knowledge/migration/analysis-guide.md'])
    })

    it('parses conventions array from phase', () => {
      const yaml = `
phases:
  - name: coding
    agent: agents/coder.md
    model: coding
    conventions: [auto]
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].conventions).toEqual(['auto'])
    })

    it('parses multiple knowledge and convention entries', () => {
      const yaml = `
phases:
  - name: coding
    agent: agents/coder.md
    model: coding
    knowledge: [knowledge/migration/coding-guide.md, knowledge/migration/review-guide.md]
    conventions: [auto, conventions/extra.md]
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].knowledge).toEqual([
        'knowledge/migration/coding-guide.md',
        'knowledge/migration/review-guide.md',
      ])
      expect(config.phases[0].conventions).toEqual(['auto', 'conventions/extra.md'])
    })

    it('omits knowledge and conventions when not specified', () => {
      const config = parseWorkflowConfig(md(MINIMAL_YAML))!
      expect(config.phases[0].knowledge).toBeUndefined()
      expect(config.phases[0].conventions).toBeUndefined()
    })

    it('omits knowledge and conventions when arrays are empty', () => {
      const yaml = `
phases:
  - name: work
    model: coding
    knowledge: []
    conventions: []
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].knowledge).toBeUndefined()
      expect(config.phases[0].conventions).toBeUndefined()
    })

    it('parses interactive_checkpoint: true', () => {
      const yaml = `
phases:
  - name: planning
    model: planning
    interactive_checkpoint: true
  - name: coding
    model: coding
    interactive_checkpoint: false
  - name: init
    model: planning
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].interactiveCheckpoint).toBe(true)
      // false and undefined both parse to undefined — the runner only checks `=== true`
      expect(config.phases[1].interactiveCheckpoint).toBeUndefined()
      expect(config.phases[2].interactiveCheckpoint).toBeUndefined()
    })

    it('ignores unknown fields (backwards compat)', () => {
      const yaml = `
phases:
  - name: work
    model: coding
    some_future_field: [a, b]
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].name).toBe('work')
      expect((config.phases[0] as unknown as Record<string, unknown>)['some_future_field']).toBeUndefined()
    })
  })

  describe('filtering and robustness', () => {
    it('skips phases without a name and keeps valid ones', () => {
      const yaml = `
phases:
  - name: good
    model: planning
  - model: coding
  - name: also-good
    model: coding
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases).toHaveLength(2)
      expect(config.phases.map(p => p.name)).toEqual(['good', 'also-good'])
    })

    it('skips subagents without a name', () => {
      const yaml = `
phases:
  - name: coding
    model: coding
    subagents:
      - name: valid-sub
        tools: [Read]
      - tools: [Bash]
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].subagents).toHaveLength(1)
      expect(config.phases[0].subagents![0].name).toBe('valid-sub')
    })

    it('ignores non-object override entries', () => {
      const yaml = `
phases:
  - name: work
    model: planning
overrides:
  valid:
    initial_phase: special
  broken: "just a string"
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.overrides['valid']).toEqual({ initialPhase: 'special' })
      // "broken" is a string, not an object — should be skipped
      expect(config.overrides['broken']).toBeUndefined()
    })

    it('handles agent set to explicit null (YAML ~)', () => {
      const yaml = `
phases:
  - name: init
    agent: ~
    model: planning
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].agent).toBeNull()
    })

    it('handles empty subagents array (no subagents on phase)', () => {
      const yaml = `
phases:
  - name: coding
    model: coding
    subagents: []
`
      const config = parseWorkflowConfig(md(yaml))!
      expect(config.phases[0].subagents).toBeUndefined()
    })
  })
})

// ── stripFrontMatter ──────────────────────────────────────────────────────────

describe('stripFrontMatter', () => {
  it('removes YAML front matter and returns body content', () => {
    const result = stripFrontMatter(md(MINIMAL_YAML, '# My Workflow\n\nSome content'))
    expect(result).toBe('# My Workflow\n\nSome content')
  })

  it('returns the full string when there is no front matter', () => {
    const input = '# No front matter here\n\nJust text.'
    expect(stripFrontMatter(input)).toBe(input)
  })

  it('trims leading whitespace after removing front matter', () => {
    const input = '---\nfoo: bar\n---\n\n\n\n  Body'
    expect(stripFrontMatter(input)).toBe('Body')
  })

  it('handles empty body after front matter', () => {
    const input = '---\nfoo: bar\n---\n'
    expect(stripFrontMatter(input)).toBe('')
  })
})

// ── getNextPhase ──────────────────────────────────────────────────────────────

describe('getNextPhase', () => {
  const config = parseWorkflowConfig(md(MULTI_PHASE_YAML))!

  it('returns the next phase in sequence', () => {
    expect(getNextPhase(config, 'analysis')).toBe('planning')
    expect(getNextPhase(config, 'planning')).toBe('coding')
    expect(getNextPhase(config, 'coding')).toBe('testing')
  })

  it('returns null for the last phase', () => {
    expect(getNextPhase(config, 'testing')).toBeNull()
  })

  it('returns null for an unknown phase name', () => {
    expect(getNextPhase(config, 'nonexistent')).toBeNull()
  })

  it('works with a single-phase workflow', () => {
    const single = parseWorkflowConfig(md(MINIMAL_YAML))!
    expect(getNextPhase(single, 'planning')).toBeNull()
  })
})

// ── getPhaseConfig ────────────────────────────────────────────────────────────

describe('getPhaseConfig', () => {
  const config = parseWorkflowConfig(md(MULTI_PHASE_YAML))!

  it('returns the PhaseConfig for a known phase', () => {
    const phase = getPhaseConfig(config, 'coding')
    expect(phase).toBeDefined()
    expect(phase!.name).toBe('coding')
    expect(phase!.agent).toBe('agents/coder.md')
    expect(phase!.model).toBe('coding')
    expect(phase!.status).toBe('coding')
  })

  it('returns undefined for an unknown phase', () => {
    expect(getPhaseConfig(config, 'does-not-exist')).toBeUndefined()
  })
})

// ── resolveInitialPhase ───────────────────────────────────────────────────────

describe('resolveInitialPhase', () => {
  const config = parseWorkflowConfig(md(WITH_OVERRIDES_YAML))!

  it('returns the override phase when trigger matches', () => {
    expect(resolveInitialPhase(config, 'jira')).toBe('spec-writing')
  })

  it('returns a different override for a different trigger', () => {
    expect(resolveInitialPhase(config, 'internal')).toBe('planning')
  })

  it('returns the default initialPhase for unmatched triggers', () => {
    expect(resolveInitialPhase(config, 'cli')).toBe('planning')
  })

  it('returns the default when overrides is empty', () => {
    const noOverrides = parseWorkflowConfig(md(MINIMAL_YAML))!
    expect(resolveInitialPhase(noOverrides, 'jira')).toBe('planning')
  })
})
