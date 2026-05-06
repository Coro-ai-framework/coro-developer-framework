#!/usr/bin/env node

import { Command } from 'commander'
import { jobCommand } from './commands/job'
import { statusCommand } from './commands/status'
import { jobsCommand } from './commands/jobs'
import { logsCommand } from './commands/logs'
import { resumeCommand } from './commands/resume'
import { cancelCommand } from './commands/cancel'
import { messageCommand } from './commands/message'
import { loginCommand } from './commands/login'
import { initCommand } from './commands/init'
import { runnerCommand, startCommand } from './commands/runner'
import { campaignCommand } from './commands/campaign'
import { pluginCommand } from './commands/plugin'

const program = new Command()

program
  .name('coro')
  .description(
    'Coro — multi-tenant AI agent platform.\n\n' +
    'The dashboard is the primary product surface. Run `coro start` to bring\n' +
    'up the runner and open the dashboard for setup; the other commands\n' +
    'below are for power users, CI, and scripting.',
  )
  .version('0.2.0')

// ── Primary command (dashboard-first) ────────────────────────────────────────
program.addCommand(startCommand)

// ── Power-user / CI commands ─────────────────────────────────────────────────
program.addCommand(jobCommand)
program.addCommand(statusCommand)
program.addCommand(jobsCommand)
program.addCommand(logsCommand)
program.addCommand(resumeCommand)
program.addCommand(cancelCommand)
program.addCommand(messageCommand)
program.addCommand(loginCommand)
program.addCommand(initCommand)
program.addCommand(runnerCommand)
program.addCommand(campaignCommand)
program.addCommand(pluginCommand)

program.parse()
