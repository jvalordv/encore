/**
 * End-to-end proof of "Capture for learning", in real Chromium against the
 * production bundle, with YouTube and the Python service both replaced. A
 * headless browser cannot pick a tab to share, so the page is opened with the
 * test seam `?captureFake` (src/app/session/capture-seam.ts), which hands the
 * capture a tone made by the engine in place of the tab's sound; the rest is
 * the real path: the worklet records it, the assembler places it by the fake
 * video's clock, the WAV is uploaded to the stand-in service, and the song
 * turns prepared through the ordinary prepared-link flow.
 * Covered: the control is on offer, labelled, for an unprepared video; a
 * capture of a 4 s video that plays to its end uploads one WAV of about that
 * length that is mostly sound, with the video's title, before the link is
 * added, and the song ends prepared with its status line; a share with no sound
 * stops with the instruction to turn tab audio on and sends nothing.
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
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });
});

test.afterEach(() => {
  expect(pageErrors, 'page errors').toEqual([]);
  expect(strayRequests, 'requests to YouTube that were not stubbed').toEqual([]);
});

test.afterAll(async () => {
  await context.close();
});

/** Opens the app with the seam on and the link loaded, Prepare on offer. */
async function openWithLink(seam: string): Promise<void> {
  service.reset(VIDEO);
  await page.goto(`/?${seam}`);
  await page.waitForFunction(() => window.encore !== undefined);
  await pasteInto(page, LINK);
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'ready', undefined, {
    timeout: 15_000,
  });
}

test('the control is on offer, with what it does, for an unprepared video', async () => {
  await openWithLink('captureFake');
  const group = page.getByTestId('capture');
  await expect(group).toBeVisible();
  await expect(page.getByTestId('capture-button')).toBeEnabled();
  await expect(page.getByTestId('capture-button')).toHaveText('Capture for learning');
  await expect(page.getByTestId('capture-note')).toContainText('Like Prepare');
  await expect(page.getByTestId('capture-stop')).toBeHidden();
  expect(service.count('POST', `/songs/url/${VIDEO}/capture`)).toBe(0);
});

test('a captured video is uploaded as one WAV and the song turns prepared', async () => {
  await openWithLink('captureFake');
  // What the service holds once the capture is in: the song, fetch done.
  const prepared = linkStatus(VIDEO, stepStatus('done', 1));
  service.create = prepared;
  service.status = prepared;

  await page.getByTestId('capture-button').click();
  await page.waitForFunction(() => window.encore!.store.state.capture.phase !== 'idle');
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'prepared', undefined, {
    timeout: 40_000,
  });

  const state = await readAppState(page);
  expect(state.capture.phase).toBe('ready');
  expect(state.clock).toBe('engine');
  await expect(page.getByTestId('prepare-note')).toContainText('The app now plays');

  const uploads = service.songRequests().filter((r) => r.method === 'POST' && r.path.endsWith('/capture'));
  expect(uploads).toHaveLength(1);
  expect(uploads[0].body).toEqual({ filename: `${VIDEO}.wav` });
  expect(service.capturedTitle).toBe(TITLE);
  // The upload comes before the link is added, which finds the song there.
  const order = service.songRequests().map((r) => `${r.method} ${r.path}`);
  expect(order.indexOf(`POST /songs/url/${VIDEO}/capture`)).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('POST /songs/url')).toBeGreaterThan(order.indexOf(`POST /songs/url/${VIDEO}/capture`));

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
  await page.getByTestId('capture-button').click();
  await expect(page.getByTestId('capture-line')).toContainText("'Share tab audio'");
  expect((await readAppState(page)).capture.phase).toBe('failed');
  expect(service.count('POST', `/songs/url/${VIDEO}/capture`)).toBe(0);
  // Another try is on offer.
  await expect(page.getByTestId('capture-button')).toBeEnabled();
});
