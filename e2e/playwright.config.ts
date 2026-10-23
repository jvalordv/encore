/**
 * Playwright setup for the end-to-end run (`npm run e2e`). It builds the app,
 * serves the production bundle with `vite preview` (so the worklets are tested
 * as shipped, not through the dev server), and launches Chromium with a fake
 * microphone that plays e2e/.tmp/a440.wav on a loop. The run stays out of
 * `npm run check` and CI until a browser is part of CI (Phase 5).
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIC_FILE, PORT } from './fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  outputDir: path.join(here, '.tmp', 'results'),
  globalSetup: path.join(here, 'fixtures.ts'),
  // One browser, one page, steps in order: each test builds on the last.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${MIC_FILE}`,
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    cwd: path.dirname(here),
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
