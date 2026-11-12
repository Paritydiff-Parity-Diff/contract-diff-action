import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/contract-diff-action/contract-diff.test.ts'],
    environment: 'node',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
  },
});
