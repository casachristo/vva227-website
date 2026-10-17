import { defineConfig, devices } from '@playwright/test';
import { RUNTIME_ORIGIN } from './tests/helpers/pages-runtime';

/**
 * The built site inside `wrangler pages dev`: _headers, _redirects and
 * _routes.json applied as Pages applies them, and the Functions running
 * against a local D1 database. See tests/helpers/pages-runtime-server.ts.
 *
 * A config of its own, run by `npm run test:runtime`, because Playwright
 * starts every webServer in a config whatever project is chosen. Listed in
 * playwright.config.ts, this server would start on every desktop and mobile
 * run too.
 */
export default defineConfig({
  testDir: './tests/system',
  testMatch: /runtime\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: RUNTIME_ORIGIN,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'runtime', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/helpers/pages-runtime-server.ts',
    url: `${RUNTIME_ORIGIN}/`,
    // Never reused: the run owns its database, and a stale server would
    // bring a stale one.
    reuseExistingServer: false,
    timeout: 120_000,
    // Lets the script stop wrangler and delete the run's database.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
