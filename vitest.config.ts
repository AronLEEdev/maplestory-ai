import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 10_000,
    passWithNoTests: true,
  },
  resolve: { alias: { '@': new URL('./src/', import.meta.url).pathname } },
})
