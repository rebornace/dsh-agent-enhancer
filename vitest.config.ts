import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Full-suite runs on a loaded Windows box have repeatedly pushed git/fs
    // fixture tests past the 5s default; they pass alone in ~1s. A 20s ceiling
    // keeps genuine hangs visible without failing on machine load.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [
      ...configDefaults.exclude,
      '.superpowers/rejected-implementation/**',
      // Archived MV3 bridge — not part of the shipping driver.
      'extensions/chrome-legacy/**',
    ],
    globalSetup: ['vitest.global-setup.ts'],
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
