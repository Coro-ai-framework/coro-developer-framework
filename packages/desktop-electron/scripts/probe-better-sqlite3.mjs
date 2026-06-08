import { createRequire } from 'node:module'
import path from 'node:path'

const runnerRoot = process.argv[2]
if (!runnerRoot) {
  console.error('usage: probe-better-sqlite3.mjs <runnerRoot>')
  process.exit(2)
}

try {
  const req = createRequire(path.join(runnerRoot, 'package.json'))
  const Database = req('better-sqlite3')
  const db = new Database(':memory:')
  db.prepare('select 1 as ok').get()
  db.close()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
