import { defineConfig } from 'vitest/config'

// Unit tests: every workspace's own vitest config. No Docker needed.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
})
