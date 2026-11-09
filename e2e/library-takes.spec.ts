/**
 * End-to-end proof of the takes shown per song in the Library, in real
 * Chromium against the production bundle, with the service stubbed. Two songs
 * are dropped; three takes are written straight into the take database for
 * the first (two by the active singer, one kept with "No singer"). Covered: a
 * row says "2 takes · last sung today" and a song with none says nothing; the
 * "All singers" switch counts the third; the expanded list shows date, time
 * and length and, in karaoke mode, no figures; Replay of another song's take
 * opens that song, plays the take and leaves the drawer up, and with the song
 * out of reach says so in one line and changes nothing; in learning mode the take with a
 * report shows its in-tune share; Open loads the song and shows the take's
 * report card; Replay of the loaded song's take plays it and Stop ends it;
 * Delete (two presses) removes that take only and the count drops. The tests
 * share one page and run in order.
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

/** The ids of the three seeded takes, and the song they belong to. */
let hashOne = '';
let hashTwo = '';
const seeded: { plain: string; scored: string; kept: string } = { plain: '', scored: '', kept: '' };

const songHash = (): Promise<string | null> =>
  page.evaluate(() => window.encore?.store.state.song?.hash ?? null);

const rowOf = (title: string) => page.getByTestId('library-item').filter({ has: page.locator(`[data-testid="library-title"]:text-is("${title}")`) });

async function drop(name: string, buffer: Buffer): Promise<void> {
  await page.getByTestId('song-input').setInputFiles({ name, mimeType: 'audio/wav', buffer });
  await expect(page.getByTestId('status-text')).toContainText(`Loaded ${name}`);
}

async function openLibrary(): Promise<void> {
  if (await page.getByTestId('library').isHidden()) await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-tab-all').click();
}

/** Writes one take record into the app's take database (the app has it open). */
async function seedTake(record: {
  songHash: string;
  songName: string;
  createdAt: number;
  profileId?: string;
  inTuneRate?: number;
}): Promise<string> {
  const wavBase64 = songBytes.toString('base64');
  return page.evaluate(
    async ({ record: r, wavBase64: b64 }) => {
      const id = crypto.randomUUID();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const report =
        r.inTuneRate === undefined
          ? {}
          : {
              report: {
                notesCovered: 10,
                notesSung: 10,
                inTuneRate: r.inTuneRate,
                frames: { hit: 5, okay: 3, miss: 2 },
                timingBiasS: null,
                notes: [],
                worstPhrases: [],
                songRange: { lowMidi: 60, highMidi: 72, highAtS: 1 },
                sungRange: { lowMidi: 60, highMidi: 72 },
              },
            };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('encore');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('takes', 'readwrite');
        tx.objectStore('takes').put({
          id,
          songHash: r.songHash,
          songName: r.songName,
          createdAt: r.createdAt,
          durationS: 4,
          latencyS: 0,
          sampleRate: 48000,
          startedAtSongS: 0,
          frames: [],
          wav: new Blob([bytes], { type: 'audio/wav' }),
          ...(r.profileId ? { profileId: r.profileId } : {}),
          ...report,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return id;
    },
    { record, wavBase64 },
  );
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  service = await stubService(context, 'library-takes');
  service.status = fileStatus('stored');
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    // A service that is away is a failed request the browser logs as an error itself.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      pageErrors.push(`console.error: ${message.text()}`);
    }
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

test('a row counts the active singer\'s takes and says when the last one was sung', async () => {
  await drop('one.wav', songBytes);
  hashOne = (await songHash()) ?? '';
  const now = Date.now();
  seeded.plain = await seedTake({ songHash: hashOne, songName: 'one', createdAt: now - 90 * 60_000 });
  seeded.scored = await seedTake({ songHash: hashOne, songName: 'one', createdAt: now - 30 * 60_000, inTuneRate: 0.8 });
  seeded.kept = await seedTake({ songHash: hashOne, songName: 'one', createdAt: now - 10 * 60_000, profileId: 'none' });
  await drop('two.wav', otherBytes);
  hashTwo = (await songHash()) ?? '';
  expect(hashTwo).not.toBe(hashOne);

  await openLibrary();
  await expect(rowOf('one').getByTestId('library-takes-toggle')).toHaveText('2 takes · last sung today');
  await expect(rowOf('two').getByTestId('library-takes-toggle')).toHaveCount(0);
});

test('the All singers switch also counts a take kept with no singer', async () => {
  await page.getByTestId('library-all-singers').check();
  await expect(rowOf('one').getByTestId('library-takes-toggle')).toHaveText('3 takes · last sung today');
  await page.getByTestId('library-all-singers').uncheck();
  await expect(rowOf('one').getByTestId('library-takes-toggle')).toHaveText('2 takes · last sung today');
});

test('expanding lists each take with date, time and length, and no figures in karaoke mode', async () => {
  await rowOf('one').getByTestId('library-takes-toggle').click();
  const takes = rowOf('one').getByTestId('library-take');
  await expect(takes).toHaveCount(2);
  await expect(takes.first().getByTestId('library-take-label')).toContainText(/^Today .*0:04$/);
  await expect(page.getByTestId('library-take-score')).toHaveCount(0);
  await expect(takes.first().getByRole('button')).toHaveText(['Replay', 'Open', 'Delete']);
});

test('Replay of a take of another song opens that song, plays the take and leaves the drawer up', async () => {
  expect(await songHash()).toBe(hashTwo);
  await rowOf('one').getByTestId('library-take-replay').first().click();
  await expect.poll(songHash).toBe(hashOne);
  await expect
    .poll(() => page.evaluate(() => window.encore?.store.state.playingTakeId ?? null))
    .toBe(seeded.scored);
  await expect(page.getByTestId('library')).toBeVisible();
  await expect(page.getByTestId('library-notice')).toBeHidden();
  // Stop is on the same row; pressing it ends the replay.
  await rowOf('one').getByTestId('library-take-replay').first().click();
  await expect.poll(() => page.evaluate(() => window.encore?.store.state.playingTakeId ?? null)).toBeNull();
});

test('Replay of a take whose song cannot be opened says so in one line and changes nothing', async () => {
  // Song two's audio lives only on the service, which is now away.
  await seedTake({ songHash: hashTwo, songName: 'two', createdAt: Date.now() });
  service.up = false;
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-toggle').click();
  await rowOf('two').getByTestId('library-takes-toggle').click();
  await rowOf('two').getByTestId('library-take-replay').click();
  await expect(page.getByTestId('library-notice')).toHaveText('Could not open two, so the take was not replayed.');
  expect(await songHash()).toBe(hashOne);
  expect(await page.evaluate(() => window.encore?.store.state.playingTakeId ?? null)).toBeNull();
  service.up = true;
});

test('in learning mode the take with a report shows its in-tune share', async () => {
  await page.getByTestId('mode-learning').click();
  const scores = rowOf('one').getByTestId('library-take-score');
  await expect(scores).toHaveCount(1);
  await expect(scores).toContainText('80% in tune');
});

test('Open loads the song and shows the take\'s report card', async () => {
  await rowOf('one').getByTestId('library-take').filter({ hasText: '80%' }).getByTestId('library-take-open').click();
  await expect.poll(songHash).toBe(hashOne);
  await expect(page.getByTestId('report-card')).toBeVisible();
  expect(await page.evaluate(() => window.encore?.store.state.reportTakeId ?? null)).toBe(seeded.scored);
});

test('Replay of a take of the loaded song plays it, and Stop ends it', async () => {
  await openLibrary();
  await rowOf('one').getByTestId('library-take-replay').first().click();
  await expect
    .poll(() => page.evaluate(() => window.encore?.store.state.playingTakeId ?? null))
    .not.toBeNull();
  await rowOf('one').getByTestId('library-take-replay').first().click();
  await expect.poll(() => page.evaluate(() => window.encore?.store.state.playingTakeId ?? null)).toBeNull();
});

test('Delete takes two presses, removes that take only and the count drops', async () => {
  const takes = rowOf('one').getByTestId('library-take');
  await expect(takes).toHaveCount(2);
  const plain = takes.filter({ hasNotText: '%' });
  await plain.getByTestId('library-take-delete').click();
  await expect(plain.getByTestId('library-take-delete')).toHaveText('Sure?');
  await expect(takes).toHaveCount(2);
  await plain.getByTestId('library-take-delete').click();
  await expect(rowOf('one').getByTestId('library-takes-toggle')).toHaveText('1 take · last sung today');
  await expect(rowOf('one').getByTestId('library-take')).toHaveCount(1);
  // Focus moves to the remaining take's Delete, inside the drawer, not to body.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''))
    .toBe('library-take-delete');
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="library-take"]') !== null)).toBe(true);
  const left = await page.evaluate(
    (hash) => window.encore?.store.state.library.takes.filter((t) => t.songHash === hash).map((t) => t.id) ?? [],
    hashOne,
  );
  expect(left.sort()).toEqual([seeded.scored, seeded.kept].sort());
});
