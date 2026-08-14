import { defineConfig } from 'vitest/config'

// Deliberately separate from `vite.config.ts`: the suites here cover pure
// logic (readiness, catalog helpers), so loading the React and Tailwind
// plugins would only slow the run down.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
