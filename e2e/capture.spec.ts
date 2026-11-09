/**
 * End-to-end proof of the Song reference's recording of the song's sound, in
 * real Chromium against the production bundle, with YouTube and the Python
 * service both replaced. A headless browser cannot pick a tab to share, so the
 * page is opened with the test seam `?captureFake`
 * (src/app/session/capture-seam.ts), which hands the recording a tone made by
 * the engine in place of the tab's sound; the rest is the real path: the
 * worklet records it, the assembler places it by the fake video's clock, the
 * WAV is uploaded to the stand-in service, and the song turns prepared.
 * Covered: Get the melody says in plain words that the song's sound will be
 * recorded during the first take, downloads nothing, shows no service text and
 * starts nothing until Play or Record is pressed; that press records the 4 s
 * video as it plays, uploads one WAV of about that length that is mostly
 * sound, with the video's title, and the song ends prepared, the link itself
 * never sent to the service; a share with no sound stops with the instruction
 * to turn tab audio on and sends nothing.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { decodeWav } from '../src/audio/wav';
import { linkStatus, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { FAKE_IFRAME_API, pasteInto, readAppState, stubOembed } from './fake-youtube';
import { PORT } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const LINK = `https://www.youtube.com/watch?v=${VIDEO}`;
const TITLE = 'Fake Video Title';
/** The fake video is short and ends by itself, so the capture is quick. */
const VIDEO_S = 4;

let context: BrowserContext;
let page: Page;
let service: FakeService;
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
      title: TITLE,
      durationS: VIDEO_S,
      readyDelayMs: 30,
      blockedIds: [],
      autoEnd: true,
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

/** Opens the app with the seam on and the link loaded, Get the melody on offer. */
async function openWithLink(seam: string): Promise<void> {
  service.reset(VIDEO);
  await page.goto(`/?${seam}`);
  await page.waitForFunction(() => window.encore !== undefined);
  await pasteInto(page, LINK);
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'ready', undefined, {
    timeout: 15_000,
  });
}

/** Opens the fake microphone, as the other specs do. */
async function openFakeMic(): Promise<void> {
  const options = await page.$$eval('#input-select option', (list) =>
    (list as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? '' })),
  );
  const named = options.filter((o) => !o.value.startsWith('@') && o.value !== 'default');
  const fakeMic = named.find((o) => /fake/i.test(o.text));
  await page.selectOption('#input-select', fakeMic ? fakeMic.value : '@default');
  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.tracker === 'running' && s.framesPerSecond > 50;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Get the melody is pressed, which arms the recording of the song's sound. */
async function getMelody(): Promise<void> {
  await page.getByTestId('reference-get').click();
  await page.waitForFunction(() => window.encore!.store.state.songRef.armed === true);
}

test('Get the melody says the song will be recorded in the first take, and starts nothing yet', async () => {
  await openWithLink('captureFake');
  await expect(page.getByTestId('song-reference')).toBeVisible();
  await expect(page.getByTestId('reference-get')).toHaveText('Get the melody');
  await expect(page.getByTestId('reference-melody')).toHaveText('Melody: none');
  await expect(page.getByTestId('reference-key')).toHaveText('Key: none');
  // Karaoke mode (the default) shows nothing about learning mode.
  await expect(page.getByTestId('reference-meaning')).toBeHidden();
  await getMelody();

  const armed = "Encore will record the song's sound while you sing your first take.";
  await expect(page.getByTestId('reference-note')).toHaveText(armed);
  await expect(page.getByTestId('status-text')).toHaveText(armed);
  await expect(page.getByTestId('reference-hint')).toContainText("'Share tab audio'");
  // No download, no service text, no Details.
  const card = await page.getByTestId('song-reference').innerText();
  expect(card).not.toMatch(/cookie|blocked|download failed/i);
  await expect(page.getByTestId('reference-details')).toHaveCount(0);
  const state = await readAppState(page);
  expect(state.songRef.armed).toBe(true);
  expect(state.capture.phase).toBe('idle');
  expect(service.count('POST', `/songs/url/${VIDEO}/capture`)).toBe(0);
  // Only the read-only question whether the service already holds this video.
  expect(service.songRequests()).toEqual([{ method: 'GET', path: `/songs/yt-${VIDEO}` }]);
});

test('the next Play records the video as it plays, uploads one WAV and the song turns prepared', async () => {
  await openWithLink('captureFake');
  await getMelody();
  // What the service holds once the capture is in: the song, fetch done.
  service.status = linkStatus(VIDEO, stepStatus('done', 1));

  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.capture.phase !== 'idle');
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'prepared', undefined, {
    timeout: 40_000,
  });

  const state = await readAppState(page);
  expect(state.capture.phase).toBe('ready');
  expect(state.songRef.armed).toBe(false);
  expect(state.clock).toBe('engine');
  await expect(page.getByTestId('reference-note')).toContainText('The app now plays');

  const uploads = service.songRequests().filter((r) => r.method === 'POST' && r.path.endsWith('/capture'));
  expect(uploads).toHaveLength(1);
  expect(uploads[0].body).toEqual({ filename: `${VIDEO}.wav` });
  expect(service.capturedTitle).toBe(TITLE);
  // Get the melody asked first whether the service held the song (it did not
  // yet); then the upload, and then the song it made is read back. The link
  // itself is never sent to the service.
  const order = service.songRequests().map((r) => `${r.method} ${r.path}`);
  const upload = order.indexOf(`POST /songs/url/${VIDEO}/capture`);
  expect(upload).toBeGreaterThanOrEqual(0);
  expect(order.lastIndexOf(`GET /songs/yt-${VIDEO}`)).toBeGreaterThan(upload);
  expect(service.count('POST', '/songs/url')).toBe(0);

  const wav = service.capturedWav;
  expect(wav).toBeDefined();
  const decoded = decodeWav(wav!.buffer.slice(wav!.byteOffset, wav!.byteOffset + wav!.byteLength) as ArrayBuffer);
  expect(decoded.pcm.length / decoded.sampleRate).toBeCloseTo(VIDEO_S, 1);
  // Most of the video was heard: the stand-in tone is steady, so the share of
  // 100 ms windows with sound is the coverage the assembler reported.
  const window100 = Math.round(decoded.sampleRate / 10);
  let loud = 0;
  let windows = 0;
  for (let at = 0; at + window100 <= decoded.pcm.length; at += window100) {
    let peak = 0;
    for (let i = at; i < at + window100; i += 1) peak = Math.max(peak, Math.abs(decoded.pcm[i]));
    windows += 1;
    if (peak > 0.05) loud += 1;
  }
  expect(loud / windows).toBeGreaterThan(0.8);
});

test('a share with no sound says to turn tab audio on and sends nothing', async () => {
  await openWithLink('captureFake=noaudio');
  await getMelody();
  await page.getByTestId('play').click();
  await expect(page.getByTestId('reference-note')).toContainText("'Share tab audio'");
  expect((await readAppState(page)).capture.phase).toBe('failed');
  expect(service.count('POST', `/songs/url/${VIDEO}/capture`)).toBe(0);
  // Another try is on offer.
  await expect(page.getByTestId('reference-get')).toBeEnabled();
});

test('Record records the sound of the song alongside the take, with no separate play-through', async () => {
  await openWithLink('captureFake');
  await openFakeMic();
  await getMelody();
  service.status = linkStatus(VIDEO, stepStatus('done', 1));

  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true, undefined, { timeout: 15_000 });
  expect((await readAppState(page)).songRef.armed).toBe(false);
  // The video ends by itself; the recording of its sound is handed on, and
  // the switch to the app's own audio waits for the take.
  await page.waitForFunction(
    () => ['uploading', 'preparing', 'ready'].includes(window.encore!.store.state.capture.phase),
    undefined,
    { timeout: 30_000 },
  );
  if ((await readAppState(page)).recording) await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'prepared', undefined, {
    timeout: 40_000,
  });
  const state = await readAppState(page);
  expect(state.capture.phase).toBe('ready');
  expect(state.takes).toHaveLength(1);
  expect(service.count('POST', `/songs/url/${VIDEO}/capture`)).toBe(1);
});
