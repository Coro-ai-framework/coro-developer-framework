#!/usr/bin/env node

import { Command } from 'commander'
import { migrateCommand } from './commands/migrate'
import { featureCommand } from './commands/feature'
import { statusCommand } from './commands/status'
import { jobsCommand } from './commands/jobs'
import { logsCommand } from './commands/logs'
import { resumeCommand } from './commands/resume'
import { messageCommand } from './commands/message'
import { loginCommand } from './commands/login'
import { initCommand } from './commands/init'
import { runnerCommand } from './commands/runner'

const program = new Command()

program
  .name('a5')
  .description('A5 Labs — AI Agent Developer Framework CLI')
  .version('0.2.0')

program.addCommand(migrateCommand)
program.addCommand(featureCommand)
program.addCommand(statusCommand)
program.addCommand(jobsCommand)
program.addCommand(logsCommand)
program.addCommand(resumeCommand)
program.addCommand(messageCommand)
program.addCommand(loginCommand)
program.addCommand(initCommand)
program.addCommand(runnerCommand)

program.parse()
