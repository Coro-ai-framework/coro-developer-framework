import { defineConfig } from 'vitest/config'

// Unit tests only, and only under tests/. The task fixtures under tasks/*/repo
// carry their own test files; they must never be collected here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tasks/**', 'results/**', 'tests/fixtures/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
  },
})
