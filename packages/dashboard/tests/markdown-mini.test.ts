import { describe, expect, it } from 'vitest'
import { renderInlineMarkdown } from '../src/components/intelligence/markdown-mini'

const REVIEW_TABLE = `| # | Reviewer says | Code today | Verdict |
|---|---|---|---|
| 1 | MaintenanceWindow is \`Id/StartedUtc/ClosedUtc\` (Unix ms) | \`dbModels/maintenance_window.go\` | ✅ Correct, still needed |
| 2 | \`type\` is a string; "no update" is \`{"update":true}\` | \`new-api-go\` | ❌ Outdated |`

describe('renderInlineMarkdown tables', () => {
  it('renders a pipe table as a grid instead of one paragraph', () => {
    const html = renderInlineMarkdown(REVIEW_TABLE)
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
    expect(html).not.toContain('---|---')
    expect(html.match(/<th /g)).toHaveLength(4)
    expect(html.match(/<td /g)).toHaveLength(8)
    expect(html).toContain('Reviewer says')
    expect(html).toContain('MaintenanceWindow is')
    expect(html).toContain('<code class="rounded bg-overlay px-1 py-0.5 text-[11px]">Id/StartedUtc/ClosedUtc</code>')
    expect(html).not.toContain('<p')
  })

  it('keeps a pipe inside inline code in one cell', () => {
    const html = renderInlineMarkdown(`| A | B |
| --- | --- |
| \`a|b\` | c |`)
    expect(html.match(/<td /g)).toHaveLength(2)
    expect(html).toContain('<code class="rounded bg-overlay px-1 py-0.5 text-[11px]">a|b</code>')
    expect(html).toContain('>c</td>')
  })

  it('honours escaped pipes and column alignment', () => {
    const html = renderInlineMarkdown(`| Left | Center | Right |
| :--- | :---: | ---: |
| a \\| b | mid | end |`)
    expect(html).toContain('text-left')
    expect(html).toContain('text-center')
    expect(html).toContain('text-right')
    expect(html).toContain('a | b')
    expect(html.match(/<td /g)).toHaveLength(3)
  })

  it('leaves a sentence that merely contains a pipe as a paragraph', () => {
    const html = renderInlineMarkdown('Use foo | bar in the command.')
    expect(html).not.toContain('<table')
    expect(html).toContain('<p')
    expect(html).toContain('foo | bar')
  })

  it('escapes HTML inside cells', () => {
    const html = renderInlineMarkdown(`| A |
| --- |
| <script>alert(1)</script> |`)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps surrounding prose and fenced code intact', () => {
    const html = renderInlineMarkdown(`Intro line.

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`
| not | a | table |
\`\`\`

- still a list`)
    expect(html).toContain('<p class="text-fg-muted">Intro line.</p>')
    expect(html).toContain('<table')
    expect(html).toContain('<pre')
    expect(html).toContain('| not | a | table |')
    expect(html).toContain('<ul')
    expect(html).toContain('<li>still a list</li>')
  })

  it('pads a short row and drops extra cells', () => {
    const html = renderInlineMarkdown(`| A | B | C |
| --- | --- | --- |
| only | two |
| a | b | c | extra |`)
    expect(html.match(/<td /g)).toHaveLength(6)
    expect(html).not.toContain('extra')
  })

  it('does not treat a heading or list as a table header', () => {
    const html = renderInlineMarkdown(`# Title | subtitle
| --- | ---
- item | with a pipe`)
    expect(html).not.toContain('<table')
    expect(html).toContain('<h1')
    expect(html).toContain('<ul')
  })
})
