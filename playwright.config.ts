import { defineConfig, devices } from '@playwright/test';
import { RUNTIME_ORIGIN } from './tests/helpers/pages-runtime';

const PORT = 4321;

// The spec that runs against the real Pages runtime rather than astro preview.
const RUNTIME_SPEC = /runtime\.spec\.ts$/;

export default defineConfig({
  testDir: './tests/system',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', testIgnore: RUNTIME_SPEC, use: { ...devices['Desktop Chrome'] } },
    // The chapter's audience skews older and increasingly mobile. The legacy
    // site had no viewport tag and a fixed 1047px table layout, so 375px is the
    // width where its failures were worst — and the one that must work here.
    { name: 'mobile', testIgnore: RUNTIME_SPEC, use: { ...devices['Pixel 5'] } },
    // The built site inside `wrangler pages dev`: _headers, _redirects and
    // _routes.json applied as Pages applies them, and the Functions running
    // against a local D1 database. See tests/helpers/pages-runtime-server.ts.
    // `npm run test:runtime` runs this project alone.
    { name: 'runtime', testMatch: RUNTIME_SPEC, use: { ...devices['Desktop Chrome'], baseURL: RUNTIME_ORIGIN } },
  ],
  webServer: [
    {
      command: 'npm run preview',
      port: PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'node tests/helpers/pages-runtime-server.ts',
      url: `${RUNTIME_ORIGIN}/`,
      // Never reused: the run owns its database, and a stale server would
      // bring a stale one.
      reuseExistingServer: false,
      timeout: 120_000,
      // Lets the script stop wrangler and delete the run's database.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
  ],
});
