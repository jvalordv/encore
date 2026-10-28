/**
 * End-to-end proof of the karaoke core in real Chromium against the production
 * bundle, with the Python service (and, for the linked song, YouTube) replaced
 * by stand-ins: e2e/fake-service.ts answers the upload, the status, both stems
 * and the melody, and e2e/fake-youtube.ts serves a fake IFrame API.
 * Covered: a dropped file is decoded and ready at once while it is sent to the
 * service in the background, with the upload and then the service's steps
 * shown in the song panel and the mix waiting, switched off; the stems arriving
 * make Karaoke the selection, with the instrumental at unity and the original
 * at the gain the stems carry; the stems joining a song that is already
 * playing without a seek, a stop or a restart; switching between Original,
 * Karaoke and Karaoke with a vocal guide by gain alone, the guide level kept
 * across a reload; the melody counted in the panel once it is read, and a
 * melody the service skipped giving its reason; a take recorded and replayed
 * with the instrumental lowered under it, and loop and seek working in the
 * karaoke mix; a service that is not running costing one plain line while the
 * song plays as before, and being tried again when the window is back; and a
 * linked song getting the mix once it has been prepared and separated. The
 * tests share one page and run in order, each starting from a reload.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { fileStatus, linkStatus, skippedStep, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { FAKE_IFRAME_API, pasteInto, readAppState } from './fake-youtube';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const SONG_ID = 'file-fake';
const LINK_SONG_ID = `yt-${VIDEO}`;
const LINK = `https://www.youtube.com/watch?v=${VIDEO}`;
const TITLE = 'Fake Video Title';
/** The factor the stand-in's stems carry. */
const GAIN = 0.8;

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
  await context.route('https://www.youtube.com/iframe_api', (route) => {
    const config = JSON.stringify({ title: TITLE, durationS: 213, readyDelayMs: 30, blockedIds: [] });
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

function appState(): Promise<AppState> {
  return readAppState(page);
}

/** Starts the page afresh against a service that is up and has nothing to say. */
async function freshPage(): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  service.reset(VIDEO);
}

/** Drops the song fixture and waits until it is decoded and ready. */
async function drop(): Promise<void> {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => {
    const s = window.encore!.store.state;
    return s.song?.name === 'song.wav' && s.player === 'ready' && s.clock === 'engine';
  });
}

/** Waits for the karaoke track's stems to be in the mix. */
async function waitForStems(): Promise<void> {
  await page.waitForFunction(() => window.encore!.store.state.mix.available, undefined, { timeout: 15_000 });
}

/** The level of each stem the player holds. */
function gains(): Promise<Record<string, number | null>> {
  return page.evaluate(() => {
    const player = window.encore!.session.parts!.player;
    return Object.fromEntries(player.stemIds().map((id) => [id, player.stemGain(id)]));
  });
}

/** A finished song: stems and melody both done. */
const finished = () =>
  fileStatus(SONG_ID, { separation: stepStatus('done', 1), reference: stepStatus('done', 1) });

const lines = () => page.getByTestId('karaoke-lines');
const note = () => page.getByTestId('karaoke-note');
const melody = () => page.getByTestId('reference-status');
const panel = () => page.getByTestId('karaoke');
const mixButton = (choice: 'original' | 'karaoke' | 'guide') => page.getByTestId(`mix-${choice}`);

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

test('1. a dropped file is ready at once and goes to the service with its progress shown', async () => {
  await freshPage();
  const running = fileStatus(SONG_ID, { separation: stepStatus('running', 0.4), reference: stepStatus('queued') });
  service.upload = running;
  service.status = running;
  const release = service.holdUpload();

  await drop();
  // The song is decoded and playable while the upload is still going.
  expect((await appState()).player).toBe('ready');
  await expect(panel()).toBeVisible();
  await expect(lines()).toHaveText(/^Sending the song to the service \d+%$/);
  // The mix is on show for what is coming, and cannot be used until it is here.
  await expect(page.getByTestId('mix')).toBeVisible();
  await expect(mixButton('karaoke')).toBeDisabled();
  const uploading = await appState();
  expect(uploading.karaoke.phase).toBe('uploading');
  expect(uploading.karaoke.uploadProgress).toBeGreaterThanOrEqual(0);
  expect(uploading.karaoke.uploadProgress).toBeLessThanOrEqual(1);
  expect(service.songRequests()).toEqual([{ method: 'POST', path: '/songs', body: { filename: 'song.wav' } }]);

  release();
  // The service's own steps follow, the lyrics step not among them.
  await expect(lines().locator('li')).toHaveText(['Separating the vocal 40%', 'Reading the melody: waiting']);
  await expect(page.getByTestId('mix')).toBeVisible();
  await expect(mixButton('karaoke')).toBeDisabled();
  expect((await appState()).mix.available).toBe(false);
  expect(await gains()).toEqual({ original: 1 });
});

test('2. the stems arrive and Karaoke is the mix, with the melody read after them', async () => {
  // Continues from test 1: separation is running at the service.
  service.status = fileStatus(SONG_ID, { separation: stepStatus('done', 1), reference: stepStatus('running', 0.3) });
  await waitForStems();
  await expect(mixButton('karaoke')).toHaveAttribute('aria-pressed', 'true');
  await expect(mixButton('original')).toHaveAttribute('aria-pressed', 'false');
  await expect(mixButton('guide')).toHaveAttribute('aria-pressed', 'false');
  await expect(mixButton('karaoke')).toBeEnabled();
  // The melody is still being read; the panel says so.
  await expect(lines().locator('li')).toHaveText(['Reading the melody 30%']);
  // The instrumental at unity, the original out, the vocal guide off.
  expect(await gains()).toEqual({ original: 0, no_vocals: 1, vocals: 0 });
  expect(service.count('GET', `/songs/${SONG_ID}/stems/vocals`)).toBe(1);
  expect(service.count('GET', `/songs/${SONG_ID}/stems/no_vocals`)).toBe(1);
  expect(service.count('GET', `/songs/${SONG_ID}/reference`)).toBe(0);

  service.status = finished();
  // The melody is drawn: the panel counts its notes, and so does the state.
  await expect(melody()).toHaveText('Melody: 2 target notes on the lane.');
  await expect(melody()).toHaveAttribute('data-phase', 'ready');
  await expect(melody()).toHaveAttribute('data-notes', '2');
  const state = await appState();
  expect(state.reference).toEqual({ phase: 'ready', notes: 2, message: '' });
  expect(state.karaoke.phase).toBe('ready');
  await expect(lines()).toBeHidden();
  expect(service.count('GET', `/songs/${SONG_ID}/reference`)).toBe(1);
});

test('3. the stems join a song that is playing without a seek, a stop or a restart', async () => {
  await freshPage();
  service.upload = finished();
  const release = service.holdUpload();
  await drop();

  // A loop keeps the 4 s song playing for the tests that follow.
  await page.evaluate(() => window.encore!.session.toggleLoop(0.2, 3.8));
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.positionS > 0.3);
  // Every command the player is given from here on is noted.
  await page.evaluate(() => {
    const player = window.encore!.session.parts!.player as unknown as Record<string, (...a: unknown[]) => unknown>;
    const w = window as unknown as { __commands: string[] };
    w.__commands = [];
    for (const name of ['play', 'pause', 'stop', 'seek', 'setLoop', 'load']) {
      const original = player[name].bind(player);
      player[name] = (...args: unknown[]) => {
        w.__commands.push(name);
        return original(...args);
      };
    }
  });
  const before = (await appState()).positionS;
  release();
  await waitForStems();

  const after = await appState();
  expect(after.player).toBe('playing');
  expect(after.positionS).toBeGreaterThanOrEqual(before);
  expect(await page.evaluate(() => (window as unknown as { __commands: string[] }).__commands)).toEqual([]);
  await expect(mixButton('karaoke')).toHaveAttribute('aria-pressed', 'true');
  expect(await gains()).toEqual({ original: 0, no_vocals: 1, vocals: 0 });
});

test('4. the mixes differ by gain alone, the original sits at the stems\' level, and the guide level is kept', async () => {
  // Continues from test 3: the song is playing in the karaoke mix.
  const playing = async () => (await appState()).player;
  await mixButton('original').click();
  await expect(mixButton('original')).toHaveAttribute('aria-pressed', 'true');
  expect(await gains()).toEqual({ original: GAIN, no_vocals: 0, vocals: 0 });
  await expect(page.getByTestId('guide-level')).toBeDisabled();

  await mixButton('guide').click();
  await expect(mixButton('guide')).toHaveAttribute('aria-pressed', 'true');
  expect(await gains()).toEqual({ original: 0, no_vocals: 1, vocals: 0.5 });
  await expect(page.getByTestId('guide-level')).toBeEnabled();

  await page.getByTestId('guide-level').fill('0.25');
  expect(await gains()).toEqual({ original: 0, no_vocals: 1, vocals: 0.25 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').guideLevel);
  expect(saved).toBe(0.25);

  await mixButton('karaoke').click();
  expect(await gains()).toEqual({ original: 0, no_vocals: 1, vocals: 0 });
  await expect(page.getByTestId('guide-level')).toBeDisabled();
  // None of this touched the song: it played on throughout.
  expect(await playing()).toBe('playing');

  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  expect((await appState()).mix.guideLevel).toBe(0.25);
  service.reset(VIDEO);
});

test('5. a take replays under the lowered instrumental, and loop and seek work in the karaoke mix', async () => {
  await freshPage();
  service.upload = finished();
  await drop();
  await waitForStems();
  await openFakeMic();

  // Record a take of the song in the karaoke mix.
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording);
  await page.waitForFunction(() => window.encore!.store.state.positionS > 1.2);
  await page.getByTestId('record').click();
  await page.waitForFunction(() => !window.encore!.store.state.recording);
  await expect(page.getByTestId('take-item')).toHaveCount(1);

  await page.getByTestId('take-play').click();
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId !== null);
  const under = await gains();
  expect(under.original).toBe(0);
  expect(under.no_vocals).toBeCloseTo(0.6, 5);
  expect(under.take).toBe(1);
  await page.getByTestId('take-play').click();
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId === null);
  expect(await gains()).toEqual({ original: 0, no_vocals: 1, vocals: 0 });

  // A loop holds the song inside it, and a seek lands where it is sent.
  await page.evaluate(() => {
    window.encore!.session.toggleLoop(1, 2.5);
    window.encore!.session.seek(1.2);
  });
  await page.waitForFunction(() => Math.abs(window.encore!.store.state.positionS - 1.2) < 0.05);
  await page.getByTestId('play').click();
  await page.waitForTimeout(3200);
  const looped = await appState();
  expect(looped.player).toBe('playing');
  expect(looped.positionS).toBeGreaterThanOrEqual(0.95);
  expect(looped.positionS).toBeLessThanOrEqual(2.55);
  expect(looped.loop).toEqual({ startS: 1, endS: 2.5 });
  await page.getByTestId('play').click();
});

test('6. a melody the service skipped gives its reason and the lane runs without targets', async () => {
  await freshPage();
  service.upload = fileStatus(SONG_ID, {
    separation: stepStatus('done', 1),
    reference: skippedStep('No singing found in this track.'),
  });
  service.reference = 409;
  await drop();
  await waitForStems();

  await expect(melody()).toContainText('No singing found in this track.');
  await expect(melody()).toHaveAttribute('data-phase', 'skipped');
  await expect(melody()).toHaveAttribute('data-notes', '0');
  const state = await appState();
  expect(state.reference).toEqual({ phase: 'skipped', notes: 0, message: 'No singing found in this track.' });
  // The karaoke track itself is fine: only the targets are missing.
  expect(state.mix).toMatchObject({ available: true, choice: 'karaoke' });
  expect(service.count('GET', `/songs/${SONG_ID}/reference`)).toBe(0);
});

test('7. with the service not running one plain line says what is missing, and the song plays as before', async () => {
  await freshPage();
  service.up = false;
  await drop();
  await page.waitForFunction(() => window.encore!.store.state.karaoke.phase === 'unavailable');
  await expect(note()).toContainText('No karaoke track or melody without the service.');
  await expect(page.getByTestId('mix')).toBeHidden();
  await expect(lines()).toBeHidden();
  expect((await appState()).status.kind).toBe('info');

  // The song plays on its own, with nothing sent anywhere.
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.positionS > 0.3);
  await page.getByTestId('play').click();
  expect(service.songRequests()).toEqual([]);
  // The refused check is the one error the browser logs.
  for (let i = 0; i < 20 && pageErrors.length < 1; i++) await page.waitForTimeout(100);
  expect(pageErrors.splice(0)).toHaveLength(1);

  // Starting the service and coming back to the window tries again.
  service.up = true;
  service.upload = finished();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitForStems();
  await expect(note()).toBeHidden();
  expect(service.count('POST', '/songs')).toBe(1);
});

test('8. a linked song gets the mix once it has been prepared and separated', async () => {
  await freshPage();
  await pasteInto(page, LINK);
  await page.waitForFunction(
    (hash) => window.encore!.store.state.song?.hash === hash && window.encore!.store.state.prepare.phase === 'ready',
    LINK_SONG_ID,
  );
  // Nothing about a karaoke track is offered for a video before it is prepared.
  await expect(panel()).toBeHidden();

  const fetched = stepStatus('done', 1);
  service.create = linkStatus(VIDEO, fetched, {
    separation: stepStatus('running', 0.3),
    reference: stepStatus('queued'),
  });
  service.status = service.create;
  await page.getByTestId('prepare-button').click();
  await page.waitForFunction(() => window.encore!.store.state.prepare.phase === 'prepared');
  // The prepare switch is as it was; the separation is reported beneath it.
  expect((await appState()).clock).toBe('engine');
  await expect(lines().locator('li')).toHaveText(['Separating the vocal 30%', 'Reading the melody: waiting']);
  expect((await appState()).mix.available).toBe(false);

  service.status = linkStatus(VIDEO, fetched, {
    separation: stepStatus('done', 1),
    reference: stepStatus('done', 1),
  });
  await waitForStems();
  await expect(mixButton('karaoke')).toHaveAttribute('aria-pressed', 'true');
  await expect(melody()).toHaveText('Melody: 2 target notes on the lane.');
  expect(await gains()).toEqual({ original: 0, no_vocals: 1, vocals: 0 });
  expect(service.count('GET', `/songs/${LINK_SONG_ID}/stems/no_vocals`)).toBe(1);
  expect(service.count('POST', '/songs')).toBe(0);
});
