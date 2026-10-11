import { defineConfig } from 'vitest/config'

// Integration tests run against docker-compose.test.yml (see `npm run test:integration`).
// Each test file gets its own database and queue via @telemetry/test-harness.
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['{apps,packages}/*/src/**/*.integration.test.ts'],
    globalSetup: ['packages/test-harness/src/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
