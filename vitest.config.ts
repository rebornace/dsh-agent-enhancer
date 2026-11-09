import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.superpowers/rejected-implementation/**',
      // Archived MV3 bridge — not part of the shipping driver.
      'extensions/chrome-legacy/**',
    ],
    globalSetup: ['tests/global-setup.ts'],
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
