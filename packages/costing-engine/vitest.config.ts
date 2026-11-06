import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Day-1 tests for the superseded Day-1 contract. Preserved on disk, NOT deleted
    // (see tests/superseded/README.md for why they cannot run against the Day-2 spec).
    exclude: ['tests/superseded/**', 'node_modules/**'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
