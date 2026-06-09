import { defineConfig } from 'vitest/config';

// Unit tests live in packages/**; the Playwright e2e suite (e2e/**) runs
// separately via `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/**', 'dist/**'],
  },
});
