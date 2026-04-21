import { Command } from 'commander'
import { loadLocalConfig, defaultConfigPath, saveLocalConfig, type LocalConfig } from '../../src/config/local-config'
import { die } from '../http'

interface LoginResponse {
  user: { id: string; email: string; name: string }
  accessToken: string
  refreshToken: string
}

export const loginCommand = new Command('login')
  .description('Log in to the A5 cloud control plane')
  .option('--cloud-url <url>', 'Cloud control plane URL', 'http://localhost:4000')
  .option('--email <email>', 'Email address')
  .option('--password <password>', 'Password')
  .action(async (opts: { cloudUrl: string; email?: string; password?: string }) => {
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r))

    const email = opts.email ?? await ask('Email: ')
    const password = opts.password ?? await ask('Password: ')
    rl.close()

    if (!email || !password) die('Email and password are required')

    console.log(`\x1b[36m▸\x1b[0m Logging in to ${opts.cloudUrl}...`)

    const res = await fetch(`${opts.cloudUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error: string }
      die(body.error ?? `Login failed (${res.status})`)
    }

    const data = await res.json() as LoginResponse

    console.log(`\x1b[32m✓\x1b[0m Logged in as ${data.user.name} (${data.user.email})`)

    // Now we need to get/create a team and generate a runner token
    const teamsRes = await fetch(`${opts.cloudUrl}/teams`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    })

    if (!teamsRes.ok) die('Failed to fetch teams')
    const teams = await teamsRes.json() as Array<{ id: string; name: string; slug: string }>

    let teamId: string
    if (teams.length === 0) {
      console.log('\x1b[33m!\x1b[0m No teams found. Creating a default team...')
      const createRes = await fetch(`${opts.cloudUrl}/teams`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.accessToken}`,
        },
        body: JSON.stringify({ name: `${data.user.name}'s Team`, slug: data.user.email.split('@')[0] }),
      })
      if (!createRes.ok) die('Failed to create team')
      const team = await createRes.json() as { id: string }
      teamId = team.id
    } else {
      teamId = teams[0].id
      console.log(`  Team: ${teams[0].name} (${teams[0].slug})`)
    }

    // Generate a runner token
    const tokenRes = await fetch(`${opts.cloudUrl}/teams/${teamId}/runner-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.accessToken}`,
      },
      body: JSON.stringify({ name: `runner-${require('os').hostname()}` }),
    })

    if (!tokenRes.ok) die('Failed to generate runner token')
    const { token: runnerToken } = await tokenRes.json() as { token: string }

    // Save to local config. If no config exists yet, seed a placeholder
    // anthropic entry so zod's refine accepts the intermediate value; the
    // user will fill it in via `a5 init` or the dashboard.
    const existing = loadLocalConfig() ?? { anthropic: { method: 'apiKey' as const, apiKey: '' } }
    const config: LocalConfig = {
      ...existing,
      cloud: {
        url: opts.cloudUrl,
        token: runnerToken,
      },
    }
    saveLocalConfig(config)

    console.log(`\x1b[32m✓\x1b[0m Runner token saved to ${defaultConfigPath()}`)
    console.log()
    console.log('Next steps:')
    console.log('  1. Run \x1b[36ma5 init\x1b[0m to configure your Anthropic API key and git credentials')
    console.log('  2. Run \x1b[36ma5 runner start\x1b[0m to start the runner')
  })
