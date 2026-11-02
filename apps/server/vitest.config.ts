import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // run files sequentially to keep ephemeral ports and logs clean
    fileParallelism: false,
  },
})
