import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectSources,
  extractImports,
  findManifestViolations,
  findViolations,
} from './helpers/boundary'

const PACKAGE_ROOT = path.resolve(__dirname, '..')

describe('black-box boundary (the real sources)', () => {
  // `src/` and `bin/` are what ships; tests are scanned too so a test cannot
  // quietly become the first importer of Coro internals.
  const files = [
    ...collectSources(path.join(PACKAGE_ROOT, 'src')),
    ...collectSources(path.join(PACKAGE_ROOT, 'bin')),
    ...collectSources(path.join(PACKAGE_ROOT, 'tests')).filter(
      f => !f.file.includes(`${path.sep}fixtures${path.sep}`) && !f.file.endsWith('boundary.test.ts'),
    ),
  ]

  it('scans a non-trivial number of files', () => {
    // Guards against the scan silently matching nothing.
    expect(files.length).toBeGreaterThan(3)
  })

  it('imports nothing from Coro except types from cloud-protocol', () => {
    const violations = findViolations(files, PACKAGE_ROOT)
    expect(violations.map(v => `${path.relative(PACKAGE_ROOT, v.file)}: ${v.specifier} (${v.reason})`)).toEqual([])
  })

  it('does not list a @coro-ai package as a runtime dependency', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8'))
    expect(findManifestViolations(manifest)).toEqual([])
  })

  it('is a private package with no build script', () => {
    // No build script is what keeps the root `pnpm build` from touching it.
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8'))
    expect(manifest.private).toBe(true)
    expect(manifest.scripts?.build).toBeUndefined()
  })
})

describe('boundary checker', () => {
  const root = '/repo/packages/eval'
  const at = (name: string) => path.join(root, 'src', name)

  it('allows type-only imports from cloud-protocol', () => {
    const text = `import type { Job } from '@coro-ai/cloud-protocol'\nexport type { PhaseUsage } from '@coro-ai/cloud-protocol'\n`
    expect(findViolations([{ file: at('a.ts'), text }], root)).toEqual([])
  })

  it('allows multi-line type-only imports', () => {
    const text = `import type {\n  Job,\n  PhaseUsage,\n} from '@coro-ai/cloud-protocol'\n`
    expect(findViolations([{ file: at('a.ts'), text }], root)).toEqual([])
  })

  it('rejects a runtime import of cloud-protocol', () => {
    const text = `import { STATUS_COMPLETE } from '@coro-ai/cloud-protocol'\n`
    const [v] = findViolations([{ file: at('a.ts'), text }], root)
    expect(v?.reason).toMatch(/import type/)
  })

  it('rejects the inline `type` modifier because it can leave a runtime import behind', () => {
    const text = `import { type Job } from '@coro-ai/cloud-protocol'\n`
    expect(findViolations([{ file: at('a.ts'), text }], root)).toHaveLength(1)
  })

  it('rejects any other @coro-ai package, even as a type', () => {
    for (const pkg of ['@coro-ai/runner', '@coro-ai/plugin-sdk', '@coro-ai/dashboard', '@coro-ai/cloud-protocol/dist/index']) {
      const text = `import type { X } from '${pkg}'\n`
      expect(findViolations([{ file: at('a.ts'), text }], root), pkg).toHaveLength(1)
    }
  })

  it('rejects require() and dynamic import() of Coro packages', () => {
    const text = `const a = require('@coro-ai/runner')\nconst b = await import('@coro-ai/plugin-sdk')\n`
    expect(findViolations([{ file: at('a.ts'), text }], root)).toHaveLength(2)
  })

  it('rejects re-exports from Coro packages', () => {
    const text = `export * from '@coro-ai/runner'\nexport { x } from '@coro-ai/dashboard'\n`
    expect(findViolations([{ file: at('a.ts'), text }], root)).toHaveLength(2)
  })

  it('rejects relative imports that leave the package', () => {
    const text = `import { x } from '../../runner/src/jobs/runner'\n`
    const [v] = findViolations([{ file: at('a.ts'), text }], root)
    expect(v?.reason).toMatch(/leaves packages\/eval/)
  })

  it('allows relative imports inside the package', () => {
    const text = `import { x } from './util'\nimport { y } from '../tests/helpers/boundary'\n`
    expect(findViolations([{ file: at('a.ts'), text }], root)).toEqual([])
  })

  it('ignores the word "import" in comments and strings', () => {
    const text = [
      `// import { x } from '@coro-ai/runner'`,
      `/**`,
      ` * import { y } from '@coro-ai/runner'`,
      ` */`,
      `const note = "import foo from '@coro-ai/runner' is forbidden"`,
    ].join('\n')
    expect(findViolations([{ file: at('a.ts'), text }], root)).toEqual([])
  })

  it('extracts specifiers across import forms', () => {
    const text = [
      `import a from 'one'`,
      `import { b } from "two"`,
      `import 'three'`,
      `import type { C } from 'four'`,
      `export * from 'five'`,
      `const d = require('six')`,
    ].join('\n')
    expect(extractImports(text).map(r => r.specifier).sort()).toEqual(['five', 'four', 'one', 'six', 'three', 'two'])
  })

  it('flags @coro-ai packages in runtime dependency fields', () => {
    expect(findManifestViolations({ dependencies: { '@coro-ai/runner': 'workspace:*' } })).toHaveLength(1)
    expect(findManifestViolations({ dependencies: { zod: '^4' } })).toEqual([])
  })
})
