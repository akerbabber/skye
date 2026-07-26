import { defineConfig } from 'vitest/config'

/**
 * Separate from vite.config.ts on purpose: that one sets `root: 'ui'` for the
 * frontend build, which would otherwise send vitest looking for tests in ui/.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    // The injection test starts two anvil instances in sequence.
    testTimeout: 180_000,
  },
})
