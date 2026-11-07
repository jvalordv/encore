/**
 * End-to-end proof of the Library and the favorites playlist in real
 * Chromium against the production bundle, with the service stubbed. Two songs
 * are dropped (the second is the first with one byte changed, so it is a
 * different song), each is noted in the Library, both are starred and
 * reordered, the order survives a reload (the entries live in IndexedDB), and
 * the playlist is played from the top: the first song is fetched back from the
 * service, runs out (the fixture is four seconds long) and the second loads by
 * itself. An upload only the service holds is listed and loads on a click. The
 * tests share one page and run in order.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];

const songBytes = readFileSync(SONG_FILE);
/** The same song with its last byte changed: another hash, still decodable. */
const otherBytes = Buffer.from(songBytes);
otherBytes[otherBytes.length - 1] ^= 1;
const thirdBytes = Buffer.from(songBytes);
thirdBytes[thirdBytes.length - 2] ^= 1;

/** The song in use, by the hash the app files it under. */
const songHash = (): Promise<string | null> =>
  page.evaluate(() => window.encore?.store.state.song?.hash ?? null);

/** The titles in the open list, in order. */
const listed = (): Promise<string[]> => page.getByTestId('library-list').getByTestId('library-title').allTextContents();

async function drop(name: string, buffer: Buffer): Promise<void> {
  await page.getByTestId('song-input').setInputFiles({ name, mimeType: 'audio/wav', buffer });
  await expect(page.getByTestId('status-text')).toContainText(`Loaded ${name}`);
}

async function openLibrary(view: 'all' | 'favorites'): Promise<void> {
  if (await page.getByTestId('library').isHidden()) await page.getByTestId('library-toggle').click();
  await page.getByTestId(`library-tab-${view}`).click();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  service = await stubService(context, 'library');
  // Every stored upload answers with a finished, empty set of steps.
  service.status = fileStatus('stored');
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
});

test.afterAll(async () => {
  await context.close();
});

test('every loaded song is kept in the Library, newest first', async () => {
  await drop('one.wav', songBytes);
  await drop('two.wav', otherBytes);
  await openLibrary('all');
  await expect.poll(listed).toEqual(['two', 'one']);
  await expect(page.getByTestId('library-item').first().getByTestId('library-meta')).toContainText('Upload');
});

test('stars both songs and reorders the favorites', async () => {
  const item = (title: string) => page.getByTestId('library-item').filter({ hasText: title });
  await item('one').getByTestId('library-star').click();
  await item('two').getByTestId('library-star').click();
  await openLibrary('favorites');
  await expect.poll(listed).toEqual(['one', 'two']);
  await item('two').getByTestId('library-up').click();
  await expect.poll(listed).toEqual(['two', 'one']);
});

test('the Library and its order are there after a reload', async () => {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await openLibrary('favorites');
  await expect.poll(listed).toEqual(['two', 'one']);
});

test('playing the favorites from the top fetches the first from the service and moves on at its end', async () => {
  const one = await page.evaluate(
    () => window.encore?.store.state.library.entries.find((e) => e.title === 'one')?.id ?? null,
  );
  const two = await page.evaluate(
    () => window.encore?.store.state.library.entries.find((e) => e.title === 'two')?.id ?? null,
  );
  expect(one).toBeTruthy();
  expect(two).toBeTruthy();
  service.requests.length = 0;

  await page.getByTestId('library-play-top').click();
  await expect.poll(songHash).toBe(two);
  expect(service.count('GET', `/songs/${two}/audio`)).toBe(1);
  await expect(page.getByTestId('playlist-bar')).toBeVisible();
  await expect(page.getByTestId('playlist-position')).toHaveText('1 of 2');

  // The four-second song runs out and the second favorite loads by itself.
  await expect.poll(songHash, { timeout: 20_000 }).toBe(one);
  await expect(page.getByTestId('playlist-position')).toHaveText('2 of 2');
});

test('Previous goes back, and loading another song ends the playlist', async () => {
  await page.getByTestId('playlist-previous').click();
  await expect(page.getByTestId('playlist-position')).toHaveText('1 of 2');
  await drop('three.wav', thirdBytes);
  await expect(page.getByTestId('playlist-bar')).toBeHidden();
});

test('an upload only the service holds is listed and loads on a click', async () => {
  service.songs = [
    {
      id: 'e'.repeat(64),
      name: 'service only',
      source: 'file',
      duration_s: 4,
      steps_done: [],
      has_audio: true,
      updated_at: 1,
    },
  ];
  await page.getByTestId('library-toggle').click();
  await openLibrary('all');
  await expect(page.getByTestId('library-service-item')).toContainText('service only');
  await page.getByTestId('library-service-item').getByTestId('library-load').click();
  await expect.poll(songHash).toBe('e'.repeat(64));
  await expect.poll(listed).toContain('service only');
});

test('removing an entry needs a second press', async () => {
  await openLibrary('all');
  const row = page.getByTestId('library-item').filter({ hasText: 'service only' });
  await row.getByTestId('library-remove').click();
  await expect(row.getByTestId('library-remove')).toHaveText('Sure?');
  await row.getByTestId('library-remove').click();
  await expect.poll(listed).not.toContain('service only');
});
