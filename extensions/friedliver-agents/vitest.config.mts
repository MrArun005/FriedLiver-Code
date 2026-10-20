import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@friedliver/main': path.resolve(import.meta.dirname, '../../agent-core/main') } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    globalSetup: ['../../test/tmpRun.ts'],
    setupFiles: ['test/tmpFile.ts'],
    // The fake Demo agent the tests drive; packaged builds never set this (test/noDemo.test.ts).
    env: { FRIEDLIVER_TEST_AGENTS: '1' },
  },
});
