import { defineConfig } from 'vitest/config'

/**
 * E2E del ecosistema (Server + Lumia Admin BFF + local-ai-assistant). Ver tests/e2e/global-setup.ts.
 *   E2E_MONGO_URI=mongodb://127.0.0.1:27018 npm run test:e2e
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    globalSetup: ['tests/e2e/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
