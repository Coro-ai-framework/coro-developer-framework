// ── coro plugin … (S7 self-serve OSS) ───────────────────────────────────────
//
// Three sub-commands wrap the runner's existing drop-in plugin loader
// (`packages/runner/src/plugins/loader.ts`) with the ergonomics needed
// to make plugin authoring + installing a one-command experience:
//
//   coro plugin init <id>          — scaffold ~/.coro/plugins/<id>/
//   coro plugin install <spec>     — npm install a published plugin
//   coro plugin list               — show installed drop-in + built-in
//   coro plugin uninstall <id>     — remove a drop-in install
//
// `init`, `install`, and `uninstall` are local-filesystem operations
// that don't need the runner to be running. `list` calls the runner's
// `/plugins` endpoint (so it sees the merged base + tenant + drop-in
// view) and falls back to the on-disk loader if the runner is offline.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { apiGet, die } from '../http'

const SDK_VERSION = '^0.1.0'
const HOST_VERSION_RANGE = '^1.0.0'

function dropinRoot(): string {
  return path.join(os.homedir(), '.coro', 'plugins')
}

// ── coro plugin init ────────────────────────────────────────────────────────

const initCmd = new Command('init')
  .description('Scaffold a new Coro plugin under ~/.coro/plugins/<id>/')
  .argument('<id>', 'Plugin id (e.g. "gitlab"). Lowercase, kebab-case recommended.')
  .option('--kind <kind>', 'Plugin kind: scm or tracker', 'scm')
  .action(async (id: string, opts: { kind: string }) => {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
      die(`Plugin id "${id}" should be lowercase, kebab-case, and start with [a-z0-9].`)
    }
    if (opts.kind !== 'scm' && opts.kind !== 'tracker') {
      die(`--kind must be "scm" or "tracker" (got "${opts.kind}").`)
    }

    const root = dropinRoot()
    const pluginDir = path.join(root, id)
    if (fs.existsSync(pluginDir)) {
      die(`Plugin directory already exists: ${pluginDir}`)
    }
    fs.mkdirSync(pluginDir, { recursive: true })
    fs.mkdirSync(path.join(pluginDir, 'intelligence', 'snippets'), { recursive: true })

    fs.writeFileSync(
      path.join(pluginDir, 'coro-plugin.json'),
      JSON.stringify(
        {
          id,
          kind: opts.kind,
          version: '0.1.0',
          displayName: id.charAt(0).toUpperCase() + id.slice(1),
          hostCompatibility: HOST_VERSION_RANGE,
          entry: 'index.js',
        },
        null,
        2,
      ) + '\n',
    )

    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify(
        {
          name: `coro-plugin-${id}`,
          version: '0.1.0',
          private: true,
          main: 'index.js',
          scripts: { build: 'tsc' },
          dependencies: { '@coro-ai/plugin-sdk': SDK_VERSION, zod: '^4.0.0' },
          devDependencies: { typescript: '^5.0.0', '@types/node': '^22.0.0' },
        },
        null,
        2,
      ) + '\n',
    )

    fs.writeFileSync(
      path.join(pluginDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'commonjs',
            strict: true,
            esModuleInterop: true,
            outDir: '.',
            rootDir: 'src',
            declaration: false,
            resolveJsonModule: true,
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ) + '\n',
    )

    fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(pluginDir, 'src', 'index.ts'),
      buildSkeleton(id, opts.kind as 'scm' | 'tracker'),
    )

    fs.writeFileSync(
      path.join(pluginDir, 'intelligence', 'snippets', `${id}-clone.md`),
      `# ${id} clone recipe\n\n` +
      `Document how the agent should clone repos served by ${id}. ` +
      `This file is layered into every job's intelligence overlay so ` +
      `the agent reads it when constructing clone commands.\n`,
    )

    console.log(`✓ Scaffolded ${pluginDir}`)
    console.log()
    console.log('Next steps:')
    console.log(`  cd ${pluginDir}`)
    console.log('  npm install')
    console.log('  npm run build         # produces index.js next to coro-plugin.json')
    console.log('  coro start            # the runner picks up coro-plugin.json automatically')
  })

// ── coro plugin install ─────────────────────────────────────────────────────

const installCmd = new Command('install')
  .description('Install a published Coro plugin into ~/.coro/plugins/')
  .argument('<spec>', 'npm package spec (e.g. "@coro-ai/plugin-gitlab" or "git+https://…")')
  .option('--id <id>', 'Override the plugin id used as the install dir name')
  .action(async (spec: string, opts: { id?: string }) => {
    const id = opts.id ?? deriveIdFromSpec(spec)
    if (!id) {
      die('Could not derive a plugin id from the spec; pass --id explicitly.')
    }
    const root = dropinRoot()
    const pluginDir = path.join(root, id)
    fs.mkdirSync(pluginDir, { recursive: true })

    if (!fs.existsSync(path.join(pluginDir, 'package.json'))) {
      fs.writeFileSync(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({ name: `coro-plugin-host-${id}`, private: true }, null, 2) + '\n',
      )
    }

    console.log(`Installing ${spec} into ${pluginDir} …`)
    const code = await runNpm(pluginDir, ['install', spec])
    if (code !== 0) die(`npm install exited with code ${code}`)

    // After install, the package's `coro-plugin.json` should exist
    // either at the package root or copied to the install dir. The
    // loader looks at the install dir's `coro-plugin.json` first; we
    // synthesise one if the package shipped its manifest under
    // `node_modules/<package>/coro-plugin.json`.
    const direct = path.join(pluginDir, 'coro-plugin.json')
    if (!fs.existsSync(direct)) {
      const candidate = findManifestUnder(path.join(pluginDir, 'node_modules'))
      if (!candidate) {
        die(
          `Installed package does not ship a coro-plugin.json. ` +
          `Either ${spec} is not a Coro plugin or it needs to declare ` +
          `the manifest under its package root.`,
        )
      }
      const manifest = JSON.parse(fs.readFileSync(candidate.manifestPath, 'utf-8')) as { entry?: string }
      const synthetic = {
        ...manifest,
        // Rewrite `entry` to point through `node_modules/<package>/`
        // so the loader's relative-path resolution stays correct.
        entry: path.relative(pluginDir, path.join(candidate.packageDir, manifest.entry ?? 'index.js')),
      }
      fs.writeFileSync(direct, JSON.stringify(synthetic, null, 2) + '\n')
    }

    console.log(`✓ Installed plugin "${id}" — restart the runner to load it.`)
  })

// ── coro plugin uninstall ───────────────────────────────────────────────────

const uninstallCmd = new Command('uninstall')
  .description('Remove an installed drop-in plugin from ~/.coro/plugins/')
  .argument('<id>')
  .action((id: string) => {
    const dir = path.join(dropinRoot(), id)
    if (!fs.existsSync(dir)) die(`No plugin installed at ${dir}.`)
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`✓ Removed ${dir}`)
    console.log('Restart the runner to drop the plugin from active sessions.')
  })

// ── coro plugin list ────────────────────────────────────────────────────────

interface PluginsResponse {
  plugins: Array<{
    manifest: { id: string; kind: string; version: string; displayName: string }
    installed?: boolean
    mcpServer?: unknown
  }>
  error?: string
}

const listCmd = new Command('list')
  .description('List plugins (built-in + drop-in) and whether they are installed.')
  .action(async () => {
    const res = await apiGet<PluginsResponse>('/plugins')
    if (res.ok) {
      for (const p of res.data.plugins) {
        const m = p.manifest
        const tag = p.installed ? '\x1b[32m✓ installed\x1b[0m' : '\x1b[90m  available\x1b[0m'
        const mcp = p.mcpServer ? '\x1b[36m[mcp]\x1b[0m' : '       '
        console.log(`${tag}  ${mcp}  ${m.kind.padEnd(8)}  ${m.id.padEnd(20)}  ${m.displayName}  v${m.version}`)
      }
      return
    }
    // Runner offline — fall back to listing on-disk drop-ins.
    console.log('(runner offline — listing drop-in plugins from ~/.coro/plugins/ only)')
    const root = dropinRoot()
    if (!fs.existsSync(root)) {
      console.log('No drop-in plugins installed.')
      return
    }
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      const manifestPath = path.join(root, dirent.name, 'coro-plugin.json')
      if (!fs.existsSync(manifestPath)) continue
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
          id: string; kind: string; version: string; displayName: string
        }
        console.log(`  installed  ${m.kind.padEnd(8)}  ${m.id.padEnd(20)}  ${m.displayName}  v${m.version}`)
      } catch {
        console.log(`  invalid    ?         ${dirent.name.padEnd(20)}  (failed to read coro-plugin.json)`)
      }
    }
  })

// ── Top-level command ───────────────────────────────────────────────────────

export const pluginCommand = new Command('plugin')
  .description('Manage Coro plugins (install, uninstall, list, scaffold).')
  .addCommand(initCmd)
  .addCommand(installCmd)
  .addCommand(uninstallCmd)
  .addCommand(listCmd)

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildSkeleton(id: string, kind: 'scm' | 'tracker'): string {
  if (kind === 'scm') {
    return `import { z } from 'zod'
import {
  ScmPluginBase,
  buildExternalRef,
  mcpStdioDescriptor,
  type ExternalRef,
  type PluginDeps,
  type PluginManifest,
  type ScmCloneInfo,
  type ScmPollSnapshot,
} from '@coro-ai/plugin-sdk'

const configSchema = z.object({
  host: z.string().min(1),
  token: z.string().min(1),
})
type Config = z.infer<typeof configSchema>

const MANIFEST: PluginManifest = {
  id: '${id}',
  kind: 'scm',
  version: '0.1.0',
  displayName: '${id.charAt(0).toUpperCase() + id.slice(1)}',
  hostCompatibility: '${HOST_VERSION_RANGE}',
  configSchema,
  webhook: {
    algorithm: 'hmac-sha256',
    header: 'X-${id}-Signature',
    format: 'sha256=<hex>',
  },
  intelligence: {
    snippets: [{ id: '${id}-clone', relativePath: 'snippets/${id}-clone.md' }],
  },
}

class ${capitalize(id)}Plugin extends ScmPluginBase<Config> {
  readonly manifest = MANIFEST
  private host = ''
  private token = ''

  async init(rawConfig: Config | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = configSchema.parse(rawConfig)
    this.host = cfg.host
    this.token = cfg.token
  }

  cloneInfo(args: { repo: string }): ScmCloneInfo {
    // Keep the token off the URL. Coro stores this URL as \`origin\` and hands
    // \`username\`/\`password\` to git through its own credential helper, so a
    // credentialed URL would persist a secret in every checkout's config and
    // pin the remote to whichever token was live at clone time.
    return {
      url: \`https://\${this.host}/\${args.repo}.git\`,
      username: 'oauth2',
      password: this.token,
      envForGit: { GIT_TERMINAL_PROMPT: '0' },
    }
  }

  matchesRemote(remoteUrl: string): boolean {
    return remoteUrl.includes(this.host)
  }

  async pollPr(_ref: ExternalRef): Promise<ScmPollSnapshot> {
    // TODO: implement provider-native HTTP fetch for the PR + comments.
    return { state: 'open', approvalCount: 0, commentCount: 0, comments: [] }
  }

  // Optional: attach an upstream MCP server for the agent to use.
  // mcpServer() {
  //   return mcpStdioDescriptor({
  //     command: 'npx',
  //     args: ['-y', '@some/${id}-mcp'],
  //     env: { ${id.toUpperCase()}_TOKEN: this.token },
  //   })
  // }

  // Optional: normalise webhook payloads into NormalizedEvent.
  // normalizeInbound(req) {
  //   const ref = buildExternalRef({ kind: 'pull_request', pluginId: '${id}', repoKey: 'owner/repo', externalId: 42 })
  //   return { ref, kind: 'pr.opened', raw: req.rawBody.toString('utf-8'), receivedAt: new Date().toISOString() }
  // }
}

export function createPlugin(): ${capitalize(id)}Plugin {
  return new ${capitalize(id)}Plugin()
}
`
  }
  // tracker
  return `import { z } from 'zod'
import {
  TrackerPluginBase,
  mcpStdioDescriptor,
  type PluginDeps,
  type PluginManifest,
} from '@coro-ai/plugin-sdk'

const configSchema = z.object({
  apiKey: z.string().min(1),
})
type Config = z.infer<typeof configSchema>

const MANIFEST: PluginManifest = {
  id: '${id}',
  kind: 'tracker',
  version: '0.1.0',
  displayName: '${capitalize(id)}',
  hostCompatibility: '${HOST_VERSION_RANGE}',
  configSchema,
}

class ${capitalize(id)}Plugin extends TrackerPluginBase<Config> {
  readonly manifest = MANIFEST
  private apiKey = ''

  async init(rawConfig: Config | Record<string, unknown>, _deps: PluginDeps): Promise<void> {
    const cfg = configSchema.parse(rawConfig)
    this.apiKey = cfg.apiKey
  }

  // Recommended: serve agent operations through an upstream MCP server.
  // mcpServer() {
  //   return mcpStdioDescriptor({
  //     command: 'npx',
  //     args: ['-y', '@some/${id}-mcp'],
  //     env: { ${id.toUpperCase()}_TOKEN: this.apiKey },
  //   })
  // }
}

export function createPlugin(): ${capitalize(id)}Plugin {
  return new ${capitalize(id)}Plugin()
}
`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}

function deriveIdFromSpec(spec: string): string | undefined {
  // Examples:
  //   @coro-ai/plugin-gitlab     → gitlab
  //   coro-plugin-gitea       → gitea
  //   git+https://…/foo.git   → foo
  const scopedMatch = spec.match(/^@[^/]+\/(?:plugin-)?(.+)$/)
  if (scopedMatch?.[1]) return scopedMatch[1].replace(/[^a-z0-9-]/gi, '').toLowerCase()
  const bareMatch = spec.match(/(?:^|\/)(?:coro-plugin-)?([^/]+?)(?:\.git)?$/)
  if (bareMatch?.[1]) return bareMatch[1].replace(/[^a-z0-9-]/gi, '').toLowerCase()
  return undefined
}

function runNpm(cwd: string, args: ReadonlyArray<string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', [...args], { cwd, stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

interface FoundManifest {
  manifestPath: string
  packageDir: string
}

function findManifestUnder(rootDir: string): FoundManifest | undefined {
  // Shallow search: the package's own `coro-plugin.json` lives at the
  // package root inside `node_modules`. We avoid recursing into nested
  // `node_modules/` because the same manifest could appear under
  // hoisted deps and we'd pick the wrong one.
  if (!fs.existsSync(rootDir)) return undefined
  for (const dirent of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const dir = path.join(rootDir, dirent.name)
    const manifest = path.join(dir, 'coro-plugin.json')
    if (fs.existsSync(manifest)) return { manifestPath: manifest, packageDir: dir }
    if (dirent.name.startsWith('@')) {
      // Scoped package — descend one level.
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        const subManifest = path.join(dir, sub.name, 'coro-plugin.json')
        if (fs.existsSync(subManifest)) {
          return { manifestPath: subManifest, packageDir: path.join(dir, sub.name) }
        }
      }
    }
  }
  return undefined
}
