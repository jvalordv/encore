/**
 * End-to-end proof of the Progress view in real Chromium: in karaoke mode the
 * header has no Progress control; in learning mode two takes over the melody
 * (the fake microphone singing a steady 440 Hz, the service stood in for by
 * e2e/fake-service.ts) give a panel with two points per sparkline; switching
 * back to karaoke mode removes the control and the panel.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { fileStatus, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { PORT, SONG_FILE } from './fixtures';

const VIDEO = 'dQw4w9WgXcQ';
const SONG_ID = 'file-fake';

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await context.route(/(youtube|youtube-nocookie|ytimg|googlevideo|doubleclick|googleadservices)\.com/, (route) =>
    route.abort(),
  );
  service = await stubService(context, VIDEO);
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  await page.goto('/');
  await page.waitForFunction(() => window.encore !== undefined);
});

test.afterAll(async () => {
  await context.close();
});

/** Records from the start until the song passes `untilS`, then saves the take. */
async function recordUntil(untilS: number): Promise<void> {
  const before = await page.evaluate(() => window.encore!.store.state.takes.length);
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording);
  await page.waitForFunction((s) => window.encore!.store.state.positionS > s, untilS);
  await page.getByTestId('record').click();
  await page.waitForFunction(
    (n) => !window.encore!.store.state.recording && window.encore!.store.state.takes.length === n,
    before + 1,
  );
}

test('Progress shows two points after two learning takes and vanishes in karaoke mode', async () => {
  service.reset(VIDEO);
  service.upload = fileStatus(SONG_ID, { separation: stepStatus('done', 1), reference: stepStatus('done', 1) });

  // Karaoke mode, the default: no control at all.
  await expect(page.getByTestId('mode-karaoke')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('progress-button')).toBeHidden();

  await page.getByTestId('mode-learning').click();
  await expect(page.getByTestId('progress-button')).toBeVisible();
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.song?.name === 'song.wav' && s.mix.available && s.reference.phase === 'ready';
    },
    undefined,
    { timeout: 15_000 },
  );
  const options = await page.$$eval('#input-select option', (list) =>
    (list as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? '' })),
  );
  const fake = options.find((o) => !o.value.startsWith('@') && /fake/i.test(o.text));
  await page.selectOption('#input-select', fake ? fake.value : '@default');
  await page.waitForFunction(
    () => window.encore!.store.state.tracker === 'running' && window.encore!.store.state.framesPerSecond > 50,
    undefined,
    { timeout: 20_000 },
  );

  await recordUntil(3.7);
  await recordUntil(3.7);

  await page.getByTestId('progress-button').click();
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect(page.getByTestId('progress-count')).toContainText('2 takes');
  // A take with no note to judge has no in-tune share, so look for a measure
  // both takes have: the voice's spread of held notes or its bias.
  const both = page.locator('[data-testid="progress-spark"][data-points="2"]');
  await expect(both.first()).toBeVisible();
  const row = page.locator('[data-testid="progress-row"]').filter({ has: both }).first();
  await expect(row.getByTestId('progress-trend')).toContainText('Not enough takes for a trend');

  await page.getByTestId('mode-karaoke').click();
  await expect(page.getByTestId('progress-button')).toBeHidden();
  await expect(page.getByTestId('progress')).toBeHidden();
  expect(pageErrors, 'page errors').toEqual([]);
});
