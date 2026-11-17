import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['platform/**/tests/**/*.test.ts', 'games/**/tests/**/*.test.ts', '.factory/locked/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
