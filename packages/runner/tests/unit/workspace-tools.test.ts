import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceTools, WorkspacePathError } from '../../src/tools/workspace-tools'

describe('workspace tools', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function tools() {
    const root = mkdtempSync(join(tmpdir(), 'coro-ws-'))
    roots.push(root)
    return { root, tools: createWorkspaceTools({ root }) }
  }

  it('rejects a path that escapes the root', async () => {
    const { tools: ws } = tools()
    await expect(ws.file_read({ path: '../etc/passwd' })).rejects.toBeInstanceOf(WorkspacePathError)
  })

  it('runs a shell command inside the root', async () => {
    const { tools: ws } = tools()
    const result = await ws.shell({ command: 'echo hi' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hi')
  })

  it('rejects non-http fetches and strips html', async () => {
    const { tools: ws } = tools()
    await expect(ws.web_fetch({ url: 'file:///etc/passwd' })).rejects.toBeInstanceOf(WorkspacePathError)
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('<html><style>x{}</style><p>Hello&nbsp;<b>there</b></p><script>secret()</script></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch
    try {
      const page = await ws.web_fetch({ url: 'https://example.com/doc' })
      expect(page.text).toContain('Hello')
      expect(page.text).toContain('there')
      expect(page.text).not.toContain('secret')
      expect(page.text).not.toContain('<p>')
    } finally {
      globalThis.fetch = original
    }
  })

  it('reads a file it wrote', async () => {
    const { root, tools: ws } = tools()
    writeFileSync(join(root, 'a.txt'), 'alpha')
    expect((await ws.file_read({ path: 'a.txt' })).content).toBe('alpha')
  })
})
