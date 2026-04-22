import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type CloudDb = NodePgDatabase<typeof schema>

let pool: pg.Pool | null = null

export function createDb(connectionString: string): CloudDb {
  pool = new pg.Pool({ connectionString })
  return drizzle(pool, { schema })
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
