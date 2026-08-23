import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright specs live in tests/system and are run by `npm run test:system`.
    include: ['tests/{unit,feature,integration,contracts,invariants,security}/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Integration and invariant suites read dist/, which a parallel build would
    // be rewriting underneath them.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
