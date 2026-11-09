/**
 * End-to-end proof of the Song reference card and its Library badge, in real
 * Chromium against the production bundle, with YouTube and the Python service
 * both replaced. Covered: a download the service answers puts the melody on
 * the card ("Melody: from this video", with its key) and a Melody badge on the
 * song's Library row, whose hover text says what it means; a download that
 * fails says the song's sound will be recorded in the first take; in learning
 * mode a song with no melody opens the card with the prompt, "Not now" is
 * remembered for the song, and ticking "Do this for every song" turns on the
 * saved setting, after which a song loads and gets its melody with no prompt;
 * karaoke mode never prompts; a karaoke video offers Find the original.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { linkStatus, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { FAKE_IFRAME_API, pasteInto, readAppState, stubOembed } from './fake-youtube';
import { PORT } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const LINK = `https://www.youtube.com/watch?v=${VIDEO}`;
const TITLE = 'Fake Video Title';
const KARAOKE_TITLE = 'Fake Video Title (Karaoke Version)';
const VIDEO_S = 120;

let context: BrowserContext;
let page: Page;
let service: FakeService;
let title = TITLE;
const pageErrors: string[] = [];
const strayRequests: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await context.route(/(youtube|youtube-nocookie|ytimg|googlevideo|doubleclick|googleadservices)\.com/, (route) => {
    strayRequests.push(route.request().url());
    return route.abort();
  });
  await stubOembed(context);
  await context.route('https://www.youtube.com/iframe_api', (route) => {
    const config = JSON.stringify({
      title,
      durationS: VIDEO_S,
      readyDelayMs: 30,
      blockedIds: [],
      autoEnd: false,
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: FAKE_IFRAME_API.replace('__CONFIG__', config),
    });
  });
  await context.route('https://www.youtube.com/embed/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>fake player</title><body>fake YouTube player</body>',
    }),
  );
  service = await stubService(context, VIDEO);
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    // A refused link is a failed request the browser logs as an error itself.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      pageErrors.push(`console.error: ${message.text()}`);
    }
  });
});

test.afterEach(() => {
  expect(pageErrors, 'page errors').toEqual([]);
  expect(strayRequests, 'requests to YouTube that were not stubbed').toEqual([]);
});

test.afterAll(async () => {
  await context.close();
});

/** Opens the app with the link loaded and the service answering; `saved` seeds the settings. */
async function openWithLink(
  saved: Record<string, unknown> = {},
  videoTitle = TITLE,
  finishedAtService = false,
): Promise<void> {
  title = videoTitle;
  service.reset(VIDEO);
  if (finishedAtService) {
    service.create = finished();
    service.status = finished();
  }
  await page.goto('/');
  await page.evaluate((settings) => {
    localStorage.clear();
    localStorage.setItem('encore.settings', JSON.stringify(settings));
  }, saved);
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await pasteInto(page, LINK);
  // Past the service check; with the automatic setting on it is under way by then.
  await page.waitForFunction(
    () => !['none', 'checking'].includes(window.encore!.store.state.prepare.phase),
    undefined,
    { timeout: 15_000 },
  );
}

/** What the service holds for a song whose download, key and melody are all done. */
function finished() {
  return linkStatus(VIDEO, stepStatus('done', 1), {
    separation: stepStatus('done', 1),
    key: stepStatus('done', 1),
    reference: stepStatus('done', 1),
  });
}

test('1. a download that works puts the melody on the card and a Melody badge in the Library', async () => {
  await openWithLink();
  await expect(page.getByTestId('reference-melody')).toHaveText('Melody: none');
  service.create = finished();
  service.status = finished();
  await page.getByTestId('reference-get').click();
  await page.waitForFunction(() => window.encore!.store.state.reference.phase === 'ready', undefined, {
    timeout: 20_000,
  });

  await expect(page.getByTestId('reference-melody')).toHaveText('Melody: from this video');
  await expect(page.getByTestId('reference-key')).toHaveText('Key: estimated from the song');
  // Karaoke mode (the default) shows nothing about learning mode.
  await expect(page.getByTestId('reference-meaning')).toBeHidden();
  await expect(page.getByTestId('reference-get')).toBeHidden();

  await page.getByTestId('library-toggle').click();
  const row = page.getByTestId('library-item').filter({ hasText: TITLE });
  const badge = row.getByTestId('library-reference');
  await expect(badge).toHaveText('Melody');
  await expect(badge).toHaveAttribute('data-help', 'Encore has a melody for this song.');
  await expect(badge).toHaveAttribute('aria-label', /^Melody: /);
  // The flag is kept with the song, so a reload still shows it.
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await page.getByTestId('library-toggle').click();
  await expect(
    page.getByTestId('library-item').filter({ hasText: TITLE }).getByTestId('library-reference'),
  ).toHaveText('Melody');
});

test('2. a download that fails says the song will be recorded in the first take', async () => {
  await openWithLink();
  service.create = { status: 422, detail: 'Download failed: HTTP Error 403: Forbidden.' };
  await page.getByTestId('reference-get').click();
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'failed');
  await expect(page.getByTestId('reference-note')).toHaveText(
    "YouTube blocked the download, so Encore will record the song's sound while you sing your first take.",
  );
  await expect(page.getByTestId('reference-get')).toHaveText('Get the melody');
  expect((await readAppState(page)).songRef.armed).toBe(true);
});

test('3. learning mode opens the card with a prompt; Not now is remembered for the song', async () => {
  await openWithLink({ mode: 'learning' });
  await expect(page.getByTestId('reference-prompt-text')).toHaveText('Get the melody so learning mode can score you?');
  await expect(page.getByTestId('reference-prompt-get')).toBeVisible();
  await expect(page.getByTestId('reference-every-song')).not.toBeChecked();
  // Nothing leaves for the service until it is answered.
  expect(service.songRequests()).toEqual([]);

  await page.getByTestId('reference-not-now').click();
  await expect(page.getByTestId('reference-prompt')).toBeHidden();
  await expect(page.getByTestId('reference-get')).toBeVisible();
  expect((await readAppState(page)).songRef.declined).toBe(true);
  expect(service.songRequests()).toEqual([]);
});

test('4. karaoke mode never prompts', async () => {
  await openWithLink({ mode: 'karaoke', autoReference: true });
  await page.waitForTimeout(500);
  await expect(page.getByTestId('reference-prompt')).toBeHidden();
  await expect(page.getByTestId('reference-get')).toBeEnabled();
  expect(service.songRequests()).toEqual([]);
});

test('5. "Do this for every song" is kept by Get the melody, and then a song gets its melody with no prompt', async () => {
  await openWithLink({ mode: 'learning' });
  await expect(page.getByTestId('reference-meaning')).toContainText('learning mode comments on your voice only');
  service.create = finished();
  service.status = finished();
  // Ticking the box alone starts nothing and saves nothing.
  await page.getByTestId('reference-every-song').check();
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').autoReference ?? false),
  ).toBe(false);
  expect(service.songRequests()).toEqual([]);
  // Get the melody with the box ticked starts this song and keeps the setting.
  await page.getByTestId('reference-prompt-get').click();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').autoReference),
  ).toBe(true);
  await page.waitForFunction(() => window.encore!.store.state.reference.phase === 'ready', undefined, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('reference-prompt')).toBeHidden();

  // The setting is in the Settings panel too, and a fresh load goes straight to the download.
  await openWithLink({ mode: 'learning', autoReference: true }, TITLE, true);
  await page.waitForFunction(() => window.encore!.store.state.reference.phase === 'ready', undefined, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('reference-prompt')).toBeHidden();
  await expect(page.getByTestId('reference-melody')).toHaveText('Melody: from this video');
});

test('6. a karaoke video says so, and offers Find the original', async () => {
  await openWithLink({}, KARAOKE_TITLE);
  await expect(page.getByTestId('reference-hint')).toContainText('looks like a karaoke track');
  const find = page.getByTestId('reference-find-original');
  await expect(find).toBeVisible();
  // Not until the song is on the service, which needs it to match against the original.
  await expect(find).toBeDisabled();
  service.create = linkStatus(VIDEO, stepStatus('done', 1), { separation: stepStatus('done', 1) });
  service.status = service.create;
  await page.getByTestId('reference-get').click();
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'prepared', undefined, {
    timeout: 20_000,
  });
  await expect(find).toBeEnabled();
});
