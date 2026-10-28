/**
 * End-to-end proof of the song search in real Chromium against the production
 * bundle, with Google replaced: Playwright routes the YouTube Data API's
 * `search` and `videos` endpoints to fixture JSON kept in e2e/ (the fixture
 * for a search is picked by whether its query leaves karaoke out), the
 * thumbnails to a one pixel picture and YouTube's own results page to a blank
 * one, and e2e/fake-youtube.ts stands in for the player. The key in these
 * tests is made up and is never printed.
 * Covered: with no song the search is what the main area shows, above a lane
 * whose mic and pitch readout still work, with the dropzone and link box in
 * place; with no key a search opens YouTube's own results in a new tab (its
 * address asserted) and asks the API nothing; a key is saved, shown as saved
 * and kept across a reload; a search with the key renders the grid with
 * thumbnails, decoded titles, lengths and Karaoke or Original badges, and
 * reads right in every skin; the chip changes the query sent and starts from
 * the practice mode in settings; a pick loads the video like a pasted link and
 * the search steps aside for it, comes back on the Search button without
 * covering the player and goes again on Close; Find the original on a karaoke
 * result searches the title without its karaoke words as Originals; a spent
 * quota says so and turns the next search into YouTube's own page; a key that
 * is wrong or restricted says which. The tests share one page and run in
 * order, each starting from a reload.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { stubService } from './fake-service';
import { FAKE_IFRAME_API, readAppState, readFakeHandle } from './fake-youtube';
import { PORT } from './fixtures';

test.describe.configure({ mode: 'serial' });

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(here, name), 'utf8');
const SEARCH_JSON = fixture('youtube-search.json');
const ORIGINALS_JSON = fixture('youtube-originals.json');
const VIDEOS_JSON = fixture('youtube-videos.json');

/** A made-up key of the right shape; it goes to the stand-in and nowhere else. */
const KEY = 'AIzaSy-e2e_fake-key-0123456789';
const SERVICE_VIDEO = 'dQw4w9WgXcQ';
const SKINS = ['studio', 'arcade', 'dreamhouse'] as const;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** What the stand-in for the API answers with. */
type ApiMode = 'ok' | 'quota' | 'badkey' | 'restricted';

let context: BrowserContext;
let page: Page;
let api: ApiMode = 'ok';
const pageErrors: string[] = [];
const strayRequests: string[] = [];
/** The `q` of every search the API stand-in was asked, in order. */
const queries: string[] = [];
/** Every request for the API's `videos` endpoint, counted. */
let lengthRequests = 0;
/** Addresses of YouTube's own results page that were opened. */
const resultsOpened: string[] = [];

function apiError(status: number, message: string, reason: string): unknown {
  return { error: { code: status, message, errors: [{ message, reason }] } };
}

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
  await context.route('https://i.ytimg.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  );
  await context.route('https://www.youtube.com/results**', (route) => {
    resultsOpened.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>results</title>' });
  });
  await context.route('https://www.youtube.com/iframe_api', (route) => {
    const config = JSON.stringify({ title: 'Fake Video Title', durationS: 213, readyDelayMs: 30, blockedIds: [] });
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: FAKE_IFRAME_API.replace('__CONFIG__', config),
    });
  });
  await context.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>fake player</title><body>fake YouTube player</body>',
    }),
  );
  // The page and the API are different origins, so the stand-in must allow it.
  const cors = { 'access-control-allow-origin': '*' };
  await context.route('https://www.googleapis.com/youtube/v3/**', (route) => {
    const url = new URL(route.request().url());
    const json = (status: number, body: string | unknown) =>
      route.fulfill({
        status,
        headers: cors,
        contentType: 'application/json',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    if (url.pathname.endsWith('/videos')) {
      lengthRequests++;
      return json(200, VIDEOS_JSON);
    }
    queries.push(url.searchParams.get('q') ?? '');
    // The key must be the one saved, and the request must be the one documented.
    const asked = Object.fromEntries(url.searchParams);
    if (asked.key !== KEY || asked.type !== 'video' || asked.videoEmbeddable !== 'true' || asked.maxResults !== '12') {
      return json(400, apiError(400, 'unexpected request', 'badRequest'));
    }
    if (api === 'quota') return json(403, apiError(403, 'quota', 'quotaExceeded'));
    if (api === 'badkey') return json(400, apiError(400, 'API key not valid. Please pass a valid API key.', 'badRequest'));
    if (api === 'restricted') return json(403, apiError(403, 'Requests from referer <empty> are blocked.', 'ipRefererBlocked'));
    return json(200, (asked.q ?? '').includes('-karaoke') ? ORIGINALS_JSON : SEARCH_JSON);
  });
  await stubService(context, SERVICE_VIDEO);
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Chromium logs an error response to the console itself; the tests that
    // provoke one expect it.
    const failedApi =
      api !== 'ok' &&
      message.location().url.startsWith('https://www.googleapis.com/') &&
      /Failed to load resource/.test(message.text());
    if (!failedApi) pageErrors.push(`console.error: ${message.text()}`);
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

/** Starts the page afresh; what is stored (the key, the mode) stays. */
async function freshPage(): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  api = 'ok';
}

/** Types into the box and presses Search. */
async function runSearch(text: string): Promise<void> {
  await page.getByTestId('search-input').fill(text);
  await page.getByTestId('search-go').click();
}

/** The search's results as the page shows them. */
function cards() {
  return page.getByTestId('search-result');
}

/** Waits for the video to be the song in use. */
async function songIsVideo(id: string): Promise<void> {
  await page.waitForFunction(
    (hash) => {
      const state = window.encore!.store.state;
      return state.song?.hash === hash && state.clock === 'embed' && state.player === 'ready';
    },
    `yt-${id}`,
  );
}

/** The box of an element, or fails the test. */
async function boxOf(selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
}

/** True when the two boxes share any area. */
function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('with no song the search is what the main area shows, and the lane still works', async () => {
  await expect(page.getByTestId('search')).toBeVisible();
  await expect(page.getByTestId('search-toggle')).toBeHidden();
  await expect(page.getByTestId('dropzone')).toBeVisible();
  await expect(page.getByTestId('link-input')).toBeVisible();
  await expect(page.getByTestId('search-chip-karaoke')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('search-chip-original')).toHaveAttribute('aria-pressed', 'false');
  expect((await readAppState(page)).song).toBeNull();

  const lane = await boxOf('#pitch-lane');
  expect(lane.height).toBeGreaterThanOrEqual(150);
  expect(overlap(await boxOf('#search'), lane)).toBe(false);
  // The mic and the pitch readout work before any song is picked.
  await page.getByTestId('mic-toggle').click();
  await expect(page.getByTestId('pitch-note')).toHaveText('A4');
});

test('with no key a search opens YouTube in a new tab and asks the API nothing', async () => {
  await freshPage();
  await expect(page.getByTestId('search-hint')).toContainText("opens YouTube's own search");
  await expect(page.getByTestId('search-go')).toHaveText('Search on YouTube');
  const before = queries.length;
  const opened = context.waitForEvent('page');
  await runSearch('adele hello');
  const popup = await opened;
  await expect
    .poll(() => popup.url())
    .toBe('https://www.youtube.com/results?search_query=adele%20hello%20karaoke');
  await popup.close();
  expect(queries.length).toBe(before);
  await expect(page.getByTestId('search-status')).toContainText("Opened YouTube's own search");
  await expect(cards()).toHaveCount(0);
  expect((await readAppState(page)).search.query).toBe('adele hello');
});

test('the Originals chip puts the originals words on the page it opens', async () => {
  await freshPage();
  await page.getByTestId('search-chip-original').click();
  const opened = context.waitForEvent('page');
  await runSearch('adele hello');
  const popup = await opened;
  await expect
    .poll(() => popup.url())
    .toBe('https://www.youtube.com/results?search_query=adele%20hello%20-karaoke');
  await popup.close();
});

test('a key is saved, shown as saved and kept across a reload', async () => {
  await freshPage();
  await page.getByTestId('search-key').fill('not a key');
  await page.getByTestId('search-key-save').click();
  await expect(page.getByTestId('search-status')).toContainText('does not look like an API key');
  expect((await readAppState(page)).search.hasKey).toBe(false);

  await page.getByTestId('search-key').fill(` ${KEY} `);
  await page.getByTestId('search-key-save').click();
  await expect(page.getByTestId('search-status')).toContainText('Key saved');
  await expect(page.getByTestId('search-key-box').locator('summary')).toHaveText('YouTube API key (saved)');
  await expect(page.getByTestId('search-key')).toHaveValue('');
  await expect(page.getByTestId('search-go')).toHaveText('Search');

  await freshPage();
  expect((await readAppState(page)).search.hasKey).toBe(true);
  await expect(page.getByTestId('search-key-box').locator('summary')).toHaveText('YouTube API key (saved)');
  await expect(page.getByTestId('search-hint')).toContainText('pick a result');
});

test('a search with the key renders the grid with badges, lengths and thumbnails', async () => {
  await freshPage();
  const before = lengthRequests;
  await runSearch('adele hello');
  await expect(cards()).toHaveCount(4);
  expect(queries.at(-1)).toBe('adele hello karaoke');
  expect(lengthRequests).toBe(before + 1);
  await expect(page.getByTestId('search-status')).toHaveText('Karaoke versions for "adele hello".');

  await expect(cards().evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.kind))).resolves.toEqual([
    'karaoke',
    'karaoke',
    'karaoke',
    'original',
  ]);
  await expect(page.getByTestId('search-badge')).toHaveText(['Karaoke', 'Karaoke', 'Karaoke', 'Original']);
  await expect(page.getByTestId('search-duration')).toHaveText(['3:42', '4:01', '1:02:03', '6:07']);
  await expect(page.getByTestId('search-title')).toHaveText([
    'Adele - Hello (Karaoke Version)',
    'Hello & Goodbye - Instrumental',
    'Adele: Hello',
    'Adele - Hello (Official Music Video)',
  ]);
  await expect(page.getByTestId('search-channel').first()).toHaveText('Sing King');
  // The thumbnails really loaded; a karaoke card offers Find the original.
  await expect
    .poll(() => page.locator('.search-thumb img').evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
  await expect(page.getByTestId('search-find-original')).toHaveCount(3);
  // The lane is still there beside the grid.
  expect((await boxOf('#pitch-lane')).height).toBeGreaterThanOrEqual(150);
});

test('the results fit the page in every skin', async () => {
  await freshPage();
  await runSearch('adele hello');
  await expect(cards()).toHaveCount(4);
  for (const skin of SKINS) {
    await page.locator('#skin-switcher').selectOption(skin);
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
    const fit = await page.evaluate(() => ({
      scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overflows: [...document.querySelectorAll('[data-testid="search-result"]')].some((el) => {
        const card = el.getBoundingClientRect();
        const box = document.getElementById('search')!.getBoundingClientRect();
        return card.right > box.right + 1 || card.left < box.left - 1;
      }),
    }));
    expect(fit, skin).toEqual({ scrolls: false, overflows: false });
    expect((await boxOf('#pitch-lane')).height, skin).toBeGreaterThanOrEqual(150);
    await expect(page.getByTestId('search-pick').first()).toBeVisible();
  }
  await page.locator('#skin-switcher').selectOption('studio');
});

test('the chip changes the query sent and starts from the practice mode', async () => {
  await freshPage();
  await page.getByTestId('search-chip-original').click();
  await expect(page.getByTestId('search-chip-original')).toHaveAttribute('aria-pressed', 'true');
  await runSearch('adele hello');
  await expect(cards()).toHaveCount(2);
  expect(queries.at(-1)).toBe('adele hello -karaoke');
  await expect(page.getByTestId('search-badge')).toHaveText(['Original', 'Original']);
  await expect(page.getByTestId('search-find-original')).toHaveCount(0);
  await expect(page.getByTestId('search-status')).toHaveText('Originals for "adele hello".');

  // Learning mode in the settings starts the chip on Originals.
  await page.evaluate((key) => {
    localStorage.setItem('encore.settings', JSON.stringify({ mode: 'learning', youtubeApiKey: key }));
  }, KEY);
  await freshPage();
  await expect(page.getByTestId('search-chip-original')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate((key) => {
    localStorage.setItem('encore.settings', JSON.stringify({ youtubeApiKey: key }));
  }, KEY);
  await freshPage();
  await expect(page.getByTestId('search-chip-karaoke')).toHaveAttribute('aria-pressed', 'true');
});

test('a pick loads the video, the search steps aside and comes back without covering the player', async () => {
  await freshPage();
  await runSearch('adele hello');
  await expect(cards()).toHaveCount(4);
  await cards().first().getByTestId('search-pick').click();
  await songIsVideo('karaoke0001');
  expect((await readFakeHandle(page, 0)).videoId).toBe('karaoke0001');
  await expect(page.getByTestId('search')).toBeHidden();
  await expect(page.getByTestId('search-toggle')).toBeVisible();
  await expect(page.getByTestId('embed-region')).toBeVisible();

  await page.getByTestId('search-toggle').click();
  await expect(page.getByTestId('search')).toBeVisible();
  await expect(cards()).toHaveCount(4);
  const embed = await boxOf('#embed-player');
  expect(embed.width).toBeGreaterThanOrEqual(480);
  expect(embed.height).toBeGreaterThanOrEqual(270);
  expect(overlap(embed, await boxOf('#search'))).toBe(false);
  expect(overlap(embed, await boxOf('#pitch-lane'))).toBe(false);
  expect((await boxOf('#pitch-lane')).height).toBeGreaterThanOrEqual(150);

  await page.getByTestId('search-close').click();
  await expect(page.getByTestId('search')).toBeHidden();
  await expect(page.getByTestId('search-toggle')).toBeVisible();
});

test('Find the original searches the title without its karaoke words as Originals', async () => {
  await freshPage();
  await runSearch('adele hello');
  await expect(cards()).toHaveCount(4);
  await cards().first().getByTestId('search-pick').click();
  await songIsVideo('karaoke0001');
  await page.getByTestId('search-toggle').click();
  await expect(page.getByTestId('search')).toBeVisible();
  await expect(cards()).toHaveCount(4);

  await cards().first().getByTestId('search-find-original').click();
  await expect(cards()).toHaveCount(2);
  expect(queries.at(-1)).toBe('Adele - Hello -karaoke');
  await expect(page.getByTestId('search-chip-original')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('search-status')).toHaveText('Originals of "Adele - Hello (Karaoke Version)".');
  await expect(page.getByTestId('search-badge')).toHaveText(['Original', 'Original']);

  await cards().nth(1).getByTestId('search-pick').click();
  await songIsVideo('original002');
  await expect(page.getByTestId('search')).toBeHidden();
});

test('a spent quota says so and the next search opens YouTube instead', async () => {
  await freshPage();
  api = 'quota';
  await runSearch('adele hello');
  const status = page.getByTestId('search-status');
  await expect(status).toHaveAttribute('data-code', 'quota');
  await expect(status).toContainText('free searches');
  await expect(cards()).toHaveCount(0);
  await expect(page.getByTestId('search-go')).toHaveText('Search on YouTube');

  const before = queries.length;
  const opened = context.waitForEvent('page');
  await runSearch('adele hello again');
  const popup = await opened;
  await expect
    .poll(() => popup.url())
    .toBe('https://www.youtube.com/results?search_query=adele%20hello%20again%20karaoke');
  await popup.close();
  expect(queries.length).toBe(before);

  // A fresh key is a fresh quota.
  api = 'ok';
  await page.getByTestId('search-key-box').locator('summary').click();
  await page.getByTestId('search-key').fill(KEY);
  await page.getByTestId('search-key-save').click();
  await expect(page.getByTestId('search-go')).toHaveText('Search');
  await runSearch('adele hello');
  await expect(cards()).toHaveCount(4);
});

test('a key that is wrong or restricted says which', async () => {
  await freshPage();
  api = 'badkey';
  await runSearch('adele hello');
  const status = page.getByTestId('search-status');
  await expect(status).toHaveAttribute('data-code', 'bad-key');
  await expect(status).toContainText('does not accept that API key');
  // A wrong key is not a spent quota: the next search still asks the API.
  await expect(page.getByTestId('search-go')).toHaveText('Search');

  api = 'restricted';
  await runSearch('adele hello');
  await expect(status).toHaveAttribute('data-code', 'restricted');
  await expect(status).toContainText('limited so it cannot search from this page');
  await expect(page.getByTestId('search-go')).toHaveText('Search');
});

test('the key is not shown anywhere on the page', async () => {
  await freshPage();
  const text = await page.evaluate(() => document.body.innerText + document.documentElement.outerHTML);
  expect(text.includes(KEY)).toBe(false);
});
