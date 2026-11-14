#!/usr/bin/env node
'use strict'

// The harness is TypeScript run through tsx: there is no build step, so the
// root `pnpm build` never has to know this package exists.
require('tsx/cjs/api').register()
require('../src/cli.ts').main(process.argv)
