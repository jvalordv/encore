/**
 * End-to-end proof of the Song reference card and its Library badge, in real
 * Chromium against the production bundle, with YouTube and the Python service
 * both replaced. A headless browser cannot pick a tab to share, so the first
 * test opens the page with the test seam `?captureFake` (a tone in place of the
 * tab's sound; capture.spec.ts has the whole recording). Covered: Get the
 * melody arms the recording of the song's sound and says so in plain words,
 * downloading nothing; the recording puts the melody on the card ("Melody:
 * from this video", with its key) and a Melody badge on the song's Library row,
 * whose hover text says what it means; in learning mode a song with no melody
 * opens the card with the prompt, "Not now" is remembered for the song, and
 * ticking "Do this for every song" turns on the saved setting, after which a
 * song loads and arms the recording with no prompt; karaoke mode never
 * prompts; a karaoke video says so and offers no download; a browser that
 * cannot share a tab says so and asks for nothing.
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
// A short video that ends by itself, for the test that records it for real.
let videoS = VIDEO_S;
let autoEnd = false;
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
      durationS: videoS,
      readyDelayMs: 30,
      blockedIds: [],
      autoEnd,
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
  // `?noShare` stands for a browser that cannot share a tab's sound.
  await context.addInitScript(() => {
    if (location.search.includes('noShare')) {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true });
    }
  });
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

/**
 * Opens the app with the link loaded and the service answering; `saved` seeds
 * the settings and `seam` is the page's query (`captureFake`, `noShare`).
 */
async function openWithLink(saved: Record<string, unknown> = {}, videoTitle = TITLE, seam = ''): Promise<void> {
  title = videoTitle;
  service.reset(VIDEO);
  await page.goto(seam ? `/?${seam}` : '/');
  await page.evaluate((settings) => {
    localStorage.clear();
    localStorage.setItem('encore.settings', JSON.stringify(settings));
  }, saved);
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await pasteInto(page, LINK);
  // Past the service check.
  await page.waitForFunction(
    () => !['none', 'checking'].includes(window.encore!.store.state.prepare.phase),
    undefined,
    { timeout: 15_000 },
  );
}

/** What the service holds for a recorded song whose key and melody are done. */
function finished() {
  return linkStatus(VIDEO, stepStatus('done', 1), {
    separation: stepStatus('done', 1),
    key: stepStatus('done', 1),
    reference: stepStatus('done', 1),
  });
}

test('1. a recording puts the melody on the card and a Melody badge in the Library', async () => {
  videoS = 4;
  autoEnd = true;
  try {
    await openWithLink({}, TITLE, 'captureFake');
    await expect(page.getByTestId('reference-melody')).toHaveText('Melody: none');
    await page.getByTestId('reference-get').click();
    await page.waitForFunction(() => window.encore!.store.state.songRef.armed === true);
    // What the service holds once the recording is in: the song, key and melody done.
    service.status = finished();
    await page.getByTestId('play').click();
    await page.waitForFunction(() => window.encore!.store.state.reference.phase === 'ready', undefined, {
      timeout: 60_000,
    });
  } finally {
    videoS = VIDEO_S;
    autoEnd = false;
  }

  await expect(page.getByTestId('reference-melody')).toHaveText('Melody: from this video');
  await expect(page.getByTestId('reference-key')).toHaveText('Key: estimated from the song');
  // Karaoke mode (the default) shows nothing about learning mode.
  await expect(page.getByTestId('reference-meaning')).toBeHidden();
  await expect(page.getByTestId('reference-get')).toBeHidden();
  expect(service.count('POST', '/songs/url')).toBe(0);

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

test('2. Get the melody arms the recording of the song\'s sound, says so, and downloads nothing', async () => {
  await openWithLink();
  await page.getByTestId('reference-get').click();
  await page.waitForFunction(() => window.encore!.store.state.songRef.armed === true);
  await expect(page.getByTestId('reference-note')).toHaveText(
    "Encore will record the song's sound while you sing your first take.",
  );
  await expect(page.getByTestId('reference-get')).toBeHidden();
  expect((await readAppState(page)).prepare.phase).toBe('ready');
  // Only the read-only question whether the service already holds this video.
  expect(service.songRequests()).toEqual([{ method: 'GET', path: `/songs/yt-${VIDEO}` }]);
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

test('5. "Do this for every song" is kept by Get the melody, and then a song arms the recording with no prompt', async () => {
  await openWithLink({ mode: 'learning' });
  await expect(page.getByTestId('reference-meaning')).toContainText('learning mode comments on your voice only');
  // Ticking the box alone starts nothing and saves nothing.
  await page.getByTestId('reference-every-song').check();
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').autoReference ?? false),
  ).toBe(false);
  expect((await readAppState(page)).songRef.armed).toBe(false);
  expect(service.songRequests()).toEqual([]);
  // Get the melody with the box ticked arms this song and keeps the setting.
  await page.getByTestId('reference-prompt-get').click();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').autoReference),
  ).toBe(true);
  await page.waitForFunction(() => window.encore!.store.state.songRef.armed === true);
  await expect(page.getByTestId('reference-prompt')).toBeHidden();

  // The setting is in the Settings panel too, and a fresh load arms the
  // recording at once, so the first Play or Record asks for the share.
  await openWithLink({ mode: 'learning', autoReference: true });
  await page.waitForFunction(() => window.encore!.store.state.songRef.armed === true);
  await expect(page.getByTestId('reference-prompt')).toBeHidden();
  await expect(page.getByTestId('reference-melody')).toHaveText('Melody: none');
  await expect(page.getByTestId('reference-note')).toContainText('will record the song');
  expect(service.songRequests()).toEqual([{ method: 'GET', path: `/songs/yt-${VIDEO}` }]);
});

test('6. a karaoke video says so, and offers neither a download nor a way to borrow another melody', async () => {
  await openWithLink({}, KARAOKE_TITLE);
  await expect(page.getByTestId('reference-hint')).toContainText('looks like a karaoke track');
  await expect(page.getByTestId('reference-find-original')).toHaveCount(0);
  await expect(page.getByTestId('song-reference')).not.toContainText('Find the original');
  await expect(page.getByTestId('reference-get')).toBeEnabled();
});

test('7. a browser that cannot share a tab says so, and asks for nothing', async () => {
  await openWithLink({ mode: 'learning', autoReference: true }, TITLE, 'noShare');
  await expect(page.getByTestId('reference-note')).toContainText('cannot record the song');
  await expect(page.getByTestId('reference-get')).toBeDisabled();
  await expect(page.getByTestId('reference-prompt')).toBeHidden();
  expect((await readAppState(page)).songRef.armed).toBe(false);
  expect(service.songRequests()).toEqual([]);
});
