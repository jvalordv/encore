/**
 * End-to-end proof of the backing notes (W0g) in real Chromium against the
 * production bundle, with the Python service replaced by e2e/fake-service.ts.
 * Covered: the app waits for the backing step after the melody, fetches the
 * notes once it is done, and draws them (the lane's data-backing attribute
 * says on); the "Backing notes" toggle hides and shows them; "Save melody"
 * with "with backing" downloads a type 1 MIDI file of two tracks; and a song
 * whose backing step was skipped shows no toggle and saves the plain melody.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Download, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { fileStatus, skippedStep, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { readAppState } from './fake-youtube';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const SONG_ID = 'file-fake';
const NOTES = {
  notes: [
    { onset_s: 0, offset_s: 2, midi: 48, velocity: 80 },
    { onset_s: 0, offset_s: 2, midi: 55, velocity: 80 },
    { onset_s: 2, offset_s: 4, midi: 53, velocity: 80 },
  ],
};

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
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
});

test.afterAll(async () => {
  await context.close();
});

function appState(): Promise<AppState> {
  return readAppState(page);
}

async function freshPage(): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  service.reset(VIDEO);
}

async function drop(): Promise<void> {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => {
    const s = window.encore!.store.state;
    return s.song?.name === 'song.wav' && s.player === 'ready' && s.clock === 'engine';
  });
}

const done = () => stepStatus('done', 1);
const lane = () => page.getByTestId('lane-canvas');

/** Reads a download's bytes. */
async function bytesOf(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test('1. the app waits for the backing, draws it, and the toggle hides and shows it', async () => {
  await freshPage();
  service.backing = NOTES;
  service.upload = fileStatus(SONG_ID, {
    separation: done(),
    reference: done(),
    backing: stepStatus('running', 0.4),
  });
  await drop();
  await expect(lane()).toHaveAttribute('data-backing', 'none');
  expect(service.count('GET', `/songs/${SONG_ID}/backing`)).toBe(0);

  service.status = fileStatus(SONG_ID, { separation: done(), reference: done(), backing: done() });
  await expect(lane()).toHaveAttribute('data-backing', 'on', { timeout: 15_000 });
  expect((await appState()).backing).toEqual({ phase: 'ready', notes: 3, shown: true });
  expect(service.count('GET', `/songs/${SONG_ID}/backing`)).toBe(1);

  const toggle = page.getByTestId('backing-toggle');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(lane()).toHaveAttribute('data-backing', 'off');
  await toggle.check();
  await expect(lane()).toHaveAttribute('data-backing', 'on');
});

test('2. Save melody with backing downloads a type 1 file of two tracks', async () => {
  // Continues from test 1: the melody and the backing are both loaded.
  await page.getByTestId('save-with-backing').check();
  const download = page.waitForEvent('download');
  await page.getByTestId('save-melody').click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/-melody-backing\.mid$/);
  const bytes = await bytesOf(saved);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('MThd');
  expect(bytes.readUInt16BE(8)).toBe(1); // format 1
  expect(bytes.readUInt16BE(10)).toBe(2); // two tracks

  await page.getByTestId('save-with-backing').uncheck();
  const plain = page.waitForEvent('download');
  await page.getByTestId('save-melody').click();
  const file = await bytesOf(await plain);
  expect(file.readUInt16BE(8)).toBe(0);
  expect(file.readUInt16BE(10)).toBe(1);
});

test('3. a skipped backing step leaves no toggle and no notes', async () => {
  await freshPage();
  service.upload = fileStatus(SONG_ID, {
    separation: done(),
    reference: done(),
    backing: skippedStep('Install the transcribe extra to get backing notes'),
  });
  await drop();
  await page.waitForFunction(() => window.encore!.store.state.reference.phase === 'ready', undefined, {
    timeout: 15_000,
  });
  await expect(lane()).toHaveAttribute('data-backing', 'none');
  await expect(page.getByTestId('backing')).toBeHidden();
  expect(service.count('GET', `/songs/${SONG_ID}/backing`)).toBe(0);
});
