import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/cloud/db/schema.ts',
  out: './src/cloud/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
