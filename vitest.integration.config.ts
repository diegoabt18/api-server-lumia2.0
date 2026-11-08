import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    // Un solo proceso: todas las pruebas comparten el servidor de MongoDB de pruebas.
    fileParallelism: false,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
})
