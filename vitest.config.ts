import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Las pruebas de integración contra MongoDB tienen su propia configuración (vitest.integration.config.ts).
    include: ['tests/unit/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
})
