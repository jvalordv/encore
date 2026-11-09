/**
 * End-to-end proof of dropping several songs at once, in real Chromium against
 * the production bundle, with the Python service replaced by the stand-in
 * (e2e/fake-service.ts). Three copies of the song fixture, each with a byte
 * changed so each is another song, are chosen together.
 * Covered: one bar and one line under the drop zone count them off ("Analysing
 * 1 of 3: a.wav ..."); the first loads as the song and plays at once while its
 * upload is still held; files chosen while the queue runs join its end; each
 * song lands in the Library; the line says the songs were analysed when it is
 * over, and the bar goes; a service that refuses a song gets it named under the
 * bar with the service's plain reason, a file that is not audio is skipped
 * with a line, and the others carry on; with the service not running the songs
 * are still added and the bar says once that the analysis needs it. The tests
 * share one page and run in order, each starting from a reload.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { fileStatus, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];

const songBytes = readFileSync(SONG_FILE);

/** The song fixture with one byte changed: another song, still decodable. */
function variant(fromEnd: number): Buffer {
  const bytes = Buffer.from(songBytes);
  bytes[bytes.length - fromEnd] ^= 1;
  return bytes;
}

const file = (name: string, fromEnd: number) => ({ name, mimeType: 'audio/wav', buffer: variant(fromEnd) });
const A = file('a.wav', 1);
const B = file('b.wav', 2);
const C = file('c.wav', 3);
const NOTES = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a song') };

const line = () => page.getByTestId('ingest-line');
const bar = () => page.getByTestId('ingest-bar');
const problems = () => page.getByTestId('ingest-problems');
const choose = (files: Array<{ name: string; mimeType: string; buffer: Buffer }>) =>
  page.getByTestId('song-input').setInputFiles(files);

/** What the service holds for a finished song: the stems, the key and the melody. */
const finished = () =>
  fileStatus('file-fake', {
    separation: stepStatus('done', 1),
    key: stepStatus('done', 1),
    reference: stepStatus('done', 1),
  });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  service = await stubService(context, 'ingest');
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    // A refused upload is a failed request the browser logs as an error itself.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      pageErrors.push(`console.error: ${message.text()}`);
    }
  });
});

test.beforeEach(async () => {
  service.reset('ingest');
  service.upload = finished();
  service.status = finished();
  await page.goto('/');
  await page.waitForFunction(() => window.encore !== undefined);
  await expect(page.getByTestId('ingest')).toBeHidden();
});

test.afterEach(() => {
  expect(pageErrors, 'page errors').toEqual([]);
});

test.afterAll(async () => {
  await context.close();
});

test('three songs chosen together share one bar; the first plays at once and all reach the Library', async () => {
  const release = service.holdUpload();
  await choose([A, B, C]);
  // The first is the song as soon as it decodes, with its upload still held.
  await expect(page.getByTestId('status-text')).toContainText('Loaded a.wav');
  await expect(line()).toHaveText(/^Analysing 1 of 3: a\.wav/);
  await expect(bar()).toBeVisible();
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  // Files chosen while the queue runs join its end, and the count grows.
  await choose([file('d.wav', 4)]);
  await expect(line()).toHaveText(/^Analysing 1 of 4: a\.wav/);
  release();

  await expect(line()).toHaveText('4 songs analysed.', { timeout: 30_000 });
  await expect(bar()).toBeHidden();
  await expect(problems()).toBeHidden();
  // Still the first song; the rest were never loaded.
  expect((await page.evaluate(() => window.encore!.store.state.song?.name)) ?? '').toBe('a.wav');
  expect(service.count('POST', '/songs')).toBe(4);

  await page.getByTestId('library-toggle').click();
  const titles = await page.getByTestId('library-list').getByTestId('library-title').allTextContents();
  for (const title of ['a', 'b', 'c', 'd']) expect(titles).toContain(title);
  // The song the service made a melody for carries its badge.
  await expect(page.getByTestId('library-reference').first()).toHaveText('Melody');
});

test('a song the service refuses is named with its reason, a file that is not audio is skipped, the rest go on', async () => {
  service.upload = { status: 415, detail: 'The service does not take this type of file.' };
  await choose([A, B, NOTES]);
  await expect(line()).toHaveText('0 of 2 songs analysed.', { timeout: 30_000 });
  await expect(problems()).toContainText('a.wav: The service does not take this type of file.');
  await expect(problems()).toContainText('b.wav: The service does not take this type of file.');
  await expect(problems()).toContainText('notes.txt is not an audio file, so it was skipped.');
  // Nothing was loaded for the text file.
  expect(await page.evaluate(() => window.encore!.store.state.song?.name)).toBe('a.wav');
  expect(service.count('POST', '/songs')).toBe(2);
});

test('a single garbage .mp3 is named under the drop zone and the line stays until it is dismissed or the next drop', async () => {
  const garbage = { name: 'garbage.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('this is not audio at all, just words') };
  await choose([garbage]);
  await expect(problems()).toContainText('garbage.mp3: no readable audio in this file.');
  // Nothing is running, yet the line is still there, with the way to clear it.
  await expect(bar()).toBeHidden();
  await page.waitForTimeout(500);
  await expect(problems()).toContainText('garbage.mp3: no readable audio in this file.');
  expect(service.songRequests()).toEqual([]);
  expect(await page.evaluate(() => window.encore!.store.state.song)).toBeNull();

  await page.getByTestId('ingest-dismiss').click();
  await expect(page.getByTestId('ingest')).toBeHidden();

  // A file that is not audio at all, dropped alone with the queue idle, gets its line too.
  await choose([NOTES]);
  await expect(problems()).toContainText('notes.txt is not an audio file, so it was skipped.');
  // The next drop replaces the lines.
  await choose([garbage]);
  await expect(problems()).toContainText('garbage.mp3: no readable audio in this file.');
  await expect(problems()).not.toContainText('notes.txt');
});

test('without the service the songs are still added, and the bar says once that the analysis needs it', async () => {
  service.up = false;
  await choose([A, B, C]);
  await expect(line()).toHaveText(
    '3 songs added. Analysing them needs the service, which is not running, ' +
      'so only the first can be played. Drop the others again once it runs.',
    { timeout: 30_000 },
  );
  await expect(bar()).toBeHidden();
  await expect(problems()).toBeHidden();
  expect(service.songRequests()).toEqual([]);
  await expect(page.getByTestId('status-text')).toContainText('Loaded a.wav');
  await page.getByTestId('library-toggle').click();
  const titles = await page.getByTestId('library-list').getByTestId('library-title').allTextContents();
  for (const title of ['a', 'b', 'c']) expect(titles).toContain(title);
});
