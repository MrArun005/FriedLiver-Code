import { defineConfig } from 'vitest/config';

// The repo's own tests; each extension runs its tests from its own folder.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], globalSetup: ['test/tmpRun.ts'] } });
