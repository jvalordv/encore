/**
 * End-to-end proof of the fun extras (W6d) in real Chromium against the
 * production bundle, with the service stood in by e2e/fake-service.ts and
 * Chromium's fake microphone singing a steady 440 Hz. In learning mode (Open
 * scoring, which the fixture's melody fits whole) a take opens a card with
 * three stars and the header shows "1 day in a row"; in karaoke mode the
 * stars and the card are gone but the streak chip stays; Save card (.png)
 * downloads a file named for the song that starts with the PNG signature.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { fileStatus, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { readAppState } from './fake-youtube';
import { PORT, SONG_FILE } from './fixtures';

const VIDEO = 'dQw4w9WgXcQ';
const SONG_ID = 'file-fake';

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];
const strayRequests: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
    permissions: ['microphone'],
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await context.route(/(youtube|youtube-nocookie|ytimg|googlevideo|doubleclick|googleadservices)\.com/, (route) => {
    strayRequests.push(route.request().url());
    return route.abort();
  });
  service = await stubService(context, VIDEO);
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });
  await page.goto('/');
  await page.waitForFunction(() => window.encore !== undefined);
});

test.afterEach(() => {
  expect(pageErrors, 'page errors').toEqual([]);
  expect(strayRequests, 'requests to YouTube that were not stubbed').toEqual([]);
});

test.afterAll(async () => {
  await context.close();
});

const appState = (): Promise<AppState> => readAppState(page);

/** Starts the page afresh against a service that is up with a finished song. */
async function freshPage(): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  service.reset(VIDEO);
  service.upload = fileStatus(SONG_ID, { separation: stepStatus('done', 1), reference: stepStatus('done', 1) });
}

/** Drops the song and waits for the karaoke track and the melody's verdict. */
async function dropAndWait(): Promise<void> {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => {
    const s = window.encore!.store.state;
    return s.song?.name === 'song.wav' && s.mix.available && s.reference.phase !== 'none';
  }, undefined, { timeout: 15_000 });
}

/** Opens the fake microphone. */
async function openFakeMic(): Promise<void> {
  const options = await page.$$eval('#input-select option', (list) =>
    (list as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? '' })),
  );
  const fake = options.find((o) => !o.value.startsWith('@') && /fake/i.test(o.text));
  await page.selectOption('#input-select', fake ? fake.value : '@default');
  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.tracker === 'running' && s.framesPerSecond > 50;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/**
 * Records from the start until the song has reached `untilS`, then saves the
 * take. Takes outlive a reload (they are in IndexedDB), so it waits for one
 * more than there were. Returns how many takes there are now.
 */
async function recordUntil(untilS: number): Promise<number> {
  const before = (await appState()).takes.length;
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording);
  await page.waitForFunction((s) => window.encore!.store.state.positionS > s, untilS);
  await page.getByTestId('record').click();
  await page.waitForFunction(
    (n) => !window.encore!.store.state.recording && window.encore!.store.state.takes.length === n,
    before + 1,
  );
  return before + 1;
}


test('learning mode shows stars and the streak; karaoke mode keeps only the streak; the card saves as a PNG', async () => {
  await freshPage();
  await page.getByTestId('mode-learning').click();
  await page.getByTestId('scoring-open').click();
  await dropAndWait();
  await openFakeMic();
  await recordUntil(3.7);

  const stars = page.getByTestId('report-stars');
  await expect(stars).toBeVisible();
  await expect(stars).toHaveAttribute('data-stars', '3');
  await expect(page.getByTestId('streak')).toHaveText('1 day in a row');

  // Save card: a PNG named for the song and the day.
  const download = page.waitForEvent('download');
  await page.getByTestId('report-save-card').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^song-\d{4}-\d{2}-\d{2}-card\.png$/);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.length).toBeGreaterThan(1000);

  // The Library row carries the stars in learning mode.
  await page.getByTestId('library-toggle').click();
  await expect(page.getByTestId('library-stars')).toBeVisible();

  // Karaoke mode judges nothing: no card, no stars; the streak is only days.
  await page.getByTestId('mode-karaoke').click();
  await expect(page.getByTestId('report-card')).toHaveCount(0);
  await expect(page.getByTestId('report-stars')).toHaveCount(0);
  await expect(page.getByTestId('library-stars')).toHaveCount(0);
  await expect(page.getByTestId('streak')).toHaveText('1 day in a row');
});
