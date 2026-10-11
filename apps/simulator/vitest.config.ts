import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'simulator',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
})
