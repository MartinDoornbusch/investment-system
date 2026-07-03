import { defineConfig } from 'vitest/config'

// Tests run in plain Node (the lib money-math is framework-free). Kept separate from
// vite.config.ts so the PWA/React plugins aren't loaded during `npm run test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
