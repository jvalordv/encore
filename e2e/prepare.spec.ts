/**
 * End-to-end proof of preparing a linked song for scoring, in real Chromium
 * against the production bundle, with both YouTube and the Python service
 * replaced: Playwright serves a fake IFrame API (e2e/fake-youtube.ts) and a
 * stand-in for the service (e2e/fake-service.ts), and refuses every other
 * request to YouTube's hosts, so the run reaches neither. The stand-in serves
 * the song fixture as the "downloaded" audio.
 * Covered: loading a link sends the service nothing but a health check, and
 * nothing at all for the link without a press of Prepare for scoring; a service
 * that is not running disables the button with the reason and a pointer to the
 * README while the video plays, a return to the window finds the service once
 * it is started, and a press that finds it gone says so; Prepare shows the
 * fetch queued, running and done, then makes the engine the active transport
 * with the video muted and following, at the position the video had; the app's
 * Play, seek and Pause drive the video; a take after the switch is filed under
 * the video's key on the engine clock with no embed offset; the video's own
 * Play, Pause and scrubbing, with or without a spell of buffering, reach the
 * engine, and not during a calibration; a video that drifts, or stalls and
 * falls behind, is moved to the engine and never the other way; a failed fetch,
 * a refused link and audio the cache lost say why and offer Add again; a take
 * being recorded holds the switch back; a new link or a file stops a
 * preparation under way; the automatic setting is off by default, saved, sends
 * a link as it loads and, with the service down at first, once it is back; a
 * loop set with A and B after the switch repeats on the engine and the video,
 * the video wrapping a moment before the sound never moves the sound, Stop
 * pauses the video at the start and clearing the loop clears it on the video
 * too; a pause pressed in the video just after the app's Play is put right by
 * the next check, with the sound playing on; a service check that a newer load
 * interrupts, and that then fails, is asked again, so Prepare is not offered on
 * a guess and a link waiting to be sent by itself still is; an audio context
 * that is slow to run (suspended, then a second or more to start) never lets
 * the video run ahead of the song unseen: the hand-over waits for the context,
 * so the position runs on across it without a step of half a second, a Play
 * pressed in the app starts the picture only once the sound's clock moves, and
 * a video played with its own button is joined by the sound, not pulled back.
 * The tests share one page and run in order, each building on the state the
 * last left behind, except where one reloads the page to start clean.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { linkStatus, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import {
  FAKE_IFRAME_API,
  callFake,
  pasteInto,
  readAppState,
  readFakeHandle,
  readStoredTakes,
} from './fake-youtube';
import type { FakeHandle } from './fake-youtube';
import { PORT, SONG_FILE, SONG_SECONDS } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const OTHER_VIDEO = 'aB3_x-Y9zQ0';
const SONG_ID = `yt-${VIDEO}`;
const LINK = `https://www.youtube.com/watch?v=${VIDEO}&list=PLignored`;
/** What the service is given: the one form of the link it always takes. */
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO}`;
const TITLE = 'Fake Video Title';
/** The fake video is 3:33 long; the audio the stand-in serves is 4 s. */
const VIDEO_S = 213;
const FETCH_ERROR = 'Download failed: ERROR: HTTP Error 403: Forbidden. Update yt-dlp (uv lock --upgrade-package yt-dlp).';
const TOO_LONG = 'This video is 20 min long; the limit is 15 min (ENCORE_MAX_SONG_S).';
const AUDIO_MISSING = 'The service has no audio for this song, even after adding it again.';

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];
/** Unexpected requests to YouTube's hosts (there must be none). */
const strayRequests: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
    permissions: ['microphone'],
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  // Routes registered later win, so the stubs below sit over this catch-all.
  await context.route(/(youtube|youtube-nocookie|ytimg|googlevideo|doubleclick|googleadservices)\.com/, (route) => {
    strayRequests.push(route.request().url());
    return route.abort();
  });
  await context.route('https://www.youtube.com/iframe_api', (route) => {
    const config = JSON.stringify({ title: TITLE, durationS: VIDEO_S, readyDelayMs: 30, blockedIds: [] });
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
  // A browser can leave an audio context suspended and take a while to run it
  // again, which holds the engine's clock where the song was left. A test that
  // wants that sets `window.__resumeDelayMs` after suspending the context; the
  // page's own reload puts it back to none.
  await context.addInitScript(() => {
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function (this: AudioContext): Promise<void> {
      const delayMs = (window as unknown as { __resumeDelayMs?: number }).__resumeDelayMs ?? 0;
      if (delayMs <= 0) return resume.call(this);
      return new Promise<void>((resolve, reject) => {
        setTimeout(() => resume.call(this).then(resolve, reject), delayMs);
      });
    };
  });
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

function fakeHandle(index: number): Promise<FakeHandle> {
  return readFakeHandle(page, index);
}

/** The calls the n-th fake player has been given since the n-th call. */
async function fakeCallsSince(index: number, from: number): Promise<string[]> {
  return (await fakeHandle(index)).calls.slice(from);
}

/** Starts the page afresh, with a service that is up and a song queued. */
async function freshPage(): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  service.reset(VIDEO);
}

/** Deletes every saved take, so a test counts only its own. */
async function clearTakes(): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('encore');
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }),
  );
}

/** Waits for the video to be the song in use and idle. */
async function songIsVideo(id: string): Promise<void> {
  await page.waitForFunction(
    (hash) => {
      const state = window.encore!.store.state;
      return state.song?.hash === hash && state.clock === 'embed' && state.player === 'ready';
    },
    `yt-${id}`,
  );
}

/** Waits for the prepare panel to reach a phase. */
async function waitForPhase(phase: AppState['prepare']['phase'], timeout = 15_000): Promise<void> {
  await page.waitForFunction((want) => window.encore!.store.state.prepare.phase === want, phase, {
    timeout,
    polling: 50,
  });
}

/** Pastes the link and waits until Prepare is on offer. */
async function loadLink(link = LINK, id = VIDEO): Promise<void> {
  await pasteInto(page, link);
  await songIsVideo(id);
  await waitForPhase('ready');
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

/**
 * The browser logs every failed request as a console error. A test that makes
 * the service refuse something expects those lines, and nothing else.
 */
async function expectNetworkErrors(count: number): Promise<void> {
  for (let i = 0; i < 20 && pageErrors.length < count; i++) await page.waitForTimeout(100);
  const seen = pageErrors.splice(0);
  expect(seen).toHaveLength(count);
  for (const entry of seen) expect(entry).toMatch(/Failed to load resource/);
}

/** The first fake player's own clock, in seconds. */
function videoClock(): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __yt: { players: Array<{ getCurrentTime(): number }> } }).__yt.players[0].getCurrentTime(),
  );
}

/** Moves the song to `positionS` and waits for the playhead to be there. */
async function seekTo(positionS: number): Promise<void> {
  await page.evaluate((s) => window.encore!.session.seek(s), positionS);
  await page.waitForFunction((s) => Math.abs(window.encore!.store.state.positionS - s) < 0.05, positionS);
}

/**
 * One look at where the song is: as the app has it (the active transport's
 * reading, which is what the readout is drawn from, but not held up by the
 * page's drawing), and on each clock.
 */
interface Sample {
  t: number;
  ctx: string;
  clock: string;
  song: number;
  engine: number;
  video: number;
}

/** Starts noting, every 20 ms in the page, where the song is on each clock. */
async function startSampling(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __samples: Sample[]; __sampler: number };
    const { session, store } = window.encore!;
    const player = session.parts!.player;
    const context = session.parts!.engine.context;
    const video = (window as unknown as { __yt: { players: Array<{ getCurrentTime(): number }> } }).__yt.players[0];
    const t0 = performance.now();
    w.__samples = [];
    w.__sampler = window.setInterval(() => {
      w.__samples.push({
        t: Math.round(performance.now() - t0),
        ctx: context.state,
        clock: store.state.clock,
        song: session.transport!.positionS,
        engine: player.positionS,
        video: video.getCurrentTime(),
      });
    }, 20);
  });
}

/** Stops noting, and returns every look taken. */
async function stopSampling(): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __samples: Sample[]; __sampler: number };
    clearInterval(w.__sampler);
    return w.__samples;
  });
}

/** Suspends the audio context, and makes running it again take `delayMs`. */
async function suspendContext(delayMs: number): Promise<void> {
  await page.evaluate(async (delay) => {
    await window.encore!.session.parts!.engine.context.suspend();
    (window as unknown as { __resumeDelayMs: number }).__resumeDelayMs = delay;
  }, delayMs);
}

/**
 * The biggest step forward beyond the time between two looks at `key`, so a
 * slow machine that looks seldom does not read as a jump, and the biggest step
 * back.
 */
function stepsOf(samples: Sample[], key: 'song' | 'engine' | 'video'): { forward: number; back: number } {
  let forward = 0;
  let back = 0;
  for (let i = 1; i < samples.length; i++) {
    const step = samples[i][key] - samples[i - 1][key];
    const elapsedS = (samples[i].t - samples[i - 1].t) / 1000;
    forward = Math.max(forward, step - elapsedS);
    back = Math.max(back, -step);
  }
  return { forward, back };
}

/** How far `key` moved across the looks that have `ctx`. */
function spreadWhile(samples: Sample[], ctx: string, key: 'engine' | 'video'): number {
  const values = samples.filter((sample) => sample.ctx === ctx).map((sample) => sample[key]);
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

/** Notes, whenever the first fake video is moved, where it went and where the sound was. */
async function noteMovesOfVideo(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __moves: Array<{ target: number; engine: number }> };
    w.__moves = [];
    const fake = (window as unknown as { __yt: { players: PageFake[] } }).__yt.players[0];
    const seekTo = fake.seekTo.bind(fake);
    fake.seekTo = (seconds, ahead) => {
      w.__moves.push({ target: seconds, engine: window.encore!.session.transport!.positionS });
      seekTo(seconds, ahead);
    };
  });
}

/** The moves noted since `noteMovesOfVideo`. */
async function movesOfVideo(): Promise<Array<{ target: number; engine: number }>> {
  return page.evaluate(
    () => (window as unknown as { __moves: Array<{ target: number; engine: number }> }).__moves,
  );
}

const prepareButton = () => page.getByTestId('prepare-button');
const prepareSteps = () => page.getByTestId('prepare-steps');
const prepareNote = () => page.getByTestId('prepare-note');
const statusText = () => page.getByTestId('status-text');

test('1. loading a link asks the service only whether it runs; nothing is sent for it without Prepare', async () => {
  await expect(page.getByTestId('prepare')).toBeHidden();
  await expect(page.getByTestId('auto-prepare')).not.toBeChecked();
  // Nothing at page load: the first question comes with a link.
  expect(service.requests).toEqual([]);

  await pasteInto(page, LINK);
  await songIsVideo(VIDEO);
  await waitForPhase('ready');
  expect(service.requests).toEqual([{ method: 'GET', path: '/health' }]);
  // Past several poll intervals: still no word of the link.
  await page.waitForTimeout(1500);
  expect(service.songRequests()).toEqual([]);

  await expect(page.getByTestId('prepare')).toBeVisible();
  await expect(prepareButton()).toHaveText('Prepare for scoring');
  await expect(prepareButton()).toBeEnabled();
  // The note says what pressing it does.
  await expect(prepareNote()).toContainText('Downloads this video');
  await expect(prepareNote()).toContainText('service/README.md');
  await expect(prepareSteps()).toBeHidden();
  // Still the video's own clock, and the note says what preparing would add.
  const state = await appState();
  expect(state.clock).toBe('embed');
  expect(state.song).toEqual({ name: TITLE, durationS: VIDEO_S, hash: SONG_ID });
  await expect(page.getByTestId('embed-note')).toContainText('Prepare the song');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}'));
  expect(saved.autoPrepareLinks ?? false).toBe(false);
});

test('2. with the service not running Prepare is off, says why and points at the README, and the video still plays', async () => {
  await freshPage();
  service.up = false;
  await pasteInto(page, LINK);
  await songIsVideo(VIDEO);
  await waitForPhase('unavailable');

  await expect(prepareButton()).toBeDisabled();
  await expect(prepareButton()).toHaveAttribute('title', /not running/);
  await expect(prepareButton()).toHaveAttribute('title', /service\/README\.md/);
  await expect(prepareNote()).toContainText('The service is not running');
  await expect(prepareNote()).toContainText('service/README.md');
  expect(service.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /health']);
  await expectNetworkErrors(1);

  // The embedded player works as it did.
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  expect((await fakeHandle(0)).calls).toContain('playVideo');
  expect((await appState()).clock).toBe('embed');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  // Starting the service and coming back to the window turns the button on.
  service.up = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitForPhase('ready');
  await expect(prepareButton()).toBeEnabled();
  expect(service.songRequests()).toEqual([]);

  // Stopped again after the check: pressing Prepare asks once more, finds it
  // gone, says so, and sends the link nowhere.
  service.up = false;
  await prepareButton().click();
  await waitForPhase('unavailable');
  await expect(prepareButton()).toBeDisabled();
  await expect(statusText()).toContainText('service/README.md');
  expect((await appState()).status.kind).toBe('warn');
  expect(service.songRequests()).toEqual([]);
  await expectNetworkErrors(1);
});

test('3. Prepare shows the fetch queued, running and done, then the engine takes over and the video is muted', async () => {
  // A video that has never played, cued 1.5 s in, so the switch has a position
  // to carry.
  await freshPage();
  await loadLink();
  await seekTo(1.5);
  expect((await fakeHandle(0)).calls).toEqual(['cue:1.5']);

  await prepareButton().click();
  await expect(prepareButton()).toBeDisabled();
  await expect(prepareSteps()).toHaveText('Fetching audio: waiting');
  expect(service.songRequests()[0]).toEqual({ method: 'POST', path: '/songs/url', body: { url: CANONICAL } });

  service.status = linkStatus(VIDEO, stepStatus('running', 0.45));
  await expect(prepareSteps()).toHaveText('Fetching audio 45%');
  service.status = linkStatus(VIDEO, stepStatus('done', 1));
  await waitForPhase('prepared');

  // The engine is the song: its clock, under the video's own key.
  const state = await appState();
  expect(state.clock).toBe('engine');
  expect(
    await page.evaluate(() => window.encore!.session.transport === window.encore!.session.parts!.player),
  ).toBe(true);
  expect(state.song).toMatchObject({ name: TITLE, hash: SONG_ID });
  expect(state.durationS).toBeCloseTo(SONG_SECONDS, 1);
  expect(state.positionS).toBeCloseTo(1.5, 1);
  expect(state.player).toBe('ready');
  // The video stays, whole and muted, and is not the one that was destroyed.
  expect(state.embed).toEqual({ videoId: VIDEO });
  await expect(page.getByTestId('embed-region')).toBeVisible();
  expect(await page.locator('#embed-player iframe').count()).toBe(1);
  const fake = await fakeHandle(0);
  expect(fake.muted).toBe(true);
  expect(fake.calls).toContain('mute');
  expect(fake.destroyed).toBe(false);
  // The panel and the notes say what this mode is.
  await expect(prepareButton()).toHaveText('Prepared');
  await expect(prepareButton()).toBeDisabled();
  await expect(prepareNote()).toContainText("plays this song's audio");
  await expect(statusText()).toContainText('Prepared');
  await expect(page.getByTestId('embed-note')).toBeHidden();
  await expect(page.getByTestId('embed-offset')).toBeHidden();
  await expect(page.getByTestId('song-title')).toHaveText(TITLE);
  // Exactly the calls a prepare is: the link, the status, the audio.
  expect(service.count('POST', '/songs/url')).toBe(1);
  // Polled through running to done, then the audio fetched once.
  expect(service.count('GET', `/songs/${SONG_ID}`)).toBeGreaterThanOrEqual(2);
  expect(service.count('GET', `/songs/${SONG_ID}/audio`)).toBe(1);
});

test('4. after the switch the app\'s seek, Play and Pause drive the video while the engine keeps the time', async () => {
  const before = (await fakeHandle(0)).calls.length;
  // A video that has not started is cued again at the new position.
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction(() => Math.abs(window.encore!.store.state.positionS - 2.5) < 0.05);
  expect(await fakeCallsSince(0, before)).toEqual(['cue:2.5']);

  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await expect.poll(() => fakeCallsSince(0, before)).toContain('playVideo');
  await page.waitForTimeout(500);
  const playing = await appState();
  expect(playing.positionS).toBeGreaterThan(2.9);
  expect(playing.positionS).toBeLessThan(3.8);
  // The video's own clock runs beside the engine's, and it stays muted.
  expect(Math.abs((await videoClock()) - playing.positionS)).toBeLessThan(0.4);
  expect((await fakeHandle(0)).muted).toBe(true);

  // A seek while playing moves the video with seekTo, to where the engine is.
  const seeks = (await fakeHandle(0)).calls.filter((c) => c.startsWith('seekTo:')).length;
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForFunction(() => window.encore!.store.state.positionS < 2.6);
  const moved = (await fakeHandle(0)).calls.filter((c) => c.startsWith('seekTo:'));
  expect(moved).toHaveLength(seeks + 1);
  const target = Number(moved[moved.length - 1].split(':')[1]);
  expect(Math.abs(target - (await appState()).positionS)).toBeLessThan(0.3);

  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
  await expect.poll(() => fakeCallsSince(0, before)).toContain('pauseVideo');
  const held = (await appState()).positionS;
  await page.waitForTimeout(500);
  expect((await appState()).positionS).toBe(held);
});

test('5. a take recorded after the switch is filed under the video, on the engine clock, with no embed offset', async () => {
  // An offset is saved for the next embedded video; the engine does not use it.
  await page.evaluate(() => window.encore!.session.setEmbedOffset(0.04));
  await openFakeMic();
  await seekTo(0.2);

  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true, undefined, { timeout: 10_000 });
  expect((await appState()).clock).toBe('engine');
  await expect(statusText()).not.toContainText('approximate');
  await page.waitForTimeout(1200);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(1);

  const [take] = await readStoredTakes(page);
  expect(take.songHash).toBe(SONG_ID);
  expect(take.clock).toBe('engine');
  // Not calibrated, and the offset of 40 ms is not added on the engine clock.
  expect(take.latencyS).toBe(0);
  expect(take.durationS).toBeGreaterThan(1);
  expect(take.startedAtSongS).toBeGreaterThan(0.1);
  expect(take.frames.length).toBeGreaterThan(take.durationS * 80);
  for (let i = 1; i < take.frames.length; i++) expect(take.frames[i].t).toBeGreaterThan(take.frames[i - 1].t);
  expect(take.frames[0].t).toBeGreaterThan(take.startedAtSongS - 0.3);
  // Exact timing: no "approximate" note on this take.
  await expect(page.getByTestId('take-note')).toHaveCount(0);
  await expect(page.locator('[data-testid="take-item"]')).not.toHaveAttribute('data-clock', 'embed');
});

test('6. the video\'s own Play, Pause and scrubbing reach the engine', async () => {
  await seekTo(0.3);
  // Past the echo of the commands the app just sent the video.
  await page.waitForTimeout(1000);

  await callFake(page, 0, 'playVideo');
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await callFake(page, 0, 'pauseVideo');
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  // Played again, then scrubbed on the video's own timeline: first with a jump
  // of its clock, then the way the real one does it, through a spell of
  // buffering, which flags no jump of its own.
  await callFake(page, 0, 'playVideo');
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.waitForTimeout(300);
  await callFake(page, 0, 'seekTo', 2.4);
  await page.waitForFunction(() => window.encore!.store.state.positionS > 2.3);
  expect((await appState()).player).toBe('playing');
  await callFake(page, 0, 'scrubTo', 0.7);
  await page.waitForFunction(() => window.encore!.store.state.positionS < 1.5);
  // The engine carried on playing from there, and the video stayed muted.
  expect((await appState()).player).toBe('playing');
  expect((await fakeHandle(0)).muted).toBe(true);

  await callFake(page, 0, 'pauseVideo');
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('7. the video\'s own Play does not start the engine during a calibration, and the video is paused again', async () => {
  await seekTo(0.2);
  // Past the echo of the seek the app just sent the video.
  await page.waitForTimeout(1000);
  await page.getByTestId('calibrate').click();
  await page.waitForFunction(() => window.encore!.store.state.calibrating === true);
  const before = (await fakeHandle(0)).calls.length;

  await callFake(page, 0, 'playVideo');
  await expect.poll(() => fakeCallsSince(0, before + 1), { timeout: 5000 }).toContain('pauseVideo');
  await expect(statusText()).toContainText('Wait for calibration to finish before playing the video');
  expect((await appState()).player).not.toBe('playing');

  await page.waitForFunction(() => window.encore!.store.state.calibrating === false, undefined, {
    timeout: 30_000,
  });
  expect((await appState()).player).not.toBe('playing');
});

test('8. a video that drifts more than half a second is moved to the engine within one check', async () => {
  await seekTo(0.1);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  // Both are going: the fake video has finished buffering.
  await page.waitForFunction(
    () => (window as unknown as { __yt: { players: Array<{ state: number }> } }).__yt.players[0].state === 1,
  );
  const seeksOf = async (): Promise<string[]> =>
    (await fakeHandle(0)).calls.filter((c) => c.startsWith('seekTo:'));
  const before = (await seeksOf()).length;
  await noteMovesOfVideo();

  // Pushed 0.8 s ahead: past the limit for drift, short of a scrub.
  await page.evaluate(() => {
    (window as unknown as { __yt: { players: Array<{ baseS: number }> } }).__yt.players[0].baseS += 0.8;
  });
  await expect.poll(async () => (await seeksOf()).length, { timeout: 4000 }).toBe(before + 1);
  // Sent to where the sound was at that moment, not where it is by now.
  const [move] = await movesOfVideo();
  expect(Math.abs(move.target - move.engine)).toBeLessThan(0.05);
  // The engine was left alone: it is still playing from where it was, and the
  // video is back beside it.
  const engine = await appState();
  expect(engine.player).toBe('playing');
  expect(Math.abs((await videoClock()) - engine.positionS)).toBeLessThan(0.4);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('9. a video that stalls falls behind and is caught up, and the sound is never pulled back to it', async () => {
  await seekTo(0.1);
  // Past the echo of the seek the app just sent the video.
  await page.waitForTimeout(1000);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.waitForFunction(
    () => (window as unknown as { __yt: { players: Array<{ state: number }> } }).__yt.players[0].state === 1,
  );
  const seeksOf = async (): Promise<string[]> =>
    (await fakeHandle(0)).calls.filter((c) => c.startsWith('seekTo:'));
  const before = (await seeksOf()).length;
  await noteMovesOfVideo();

  // The network gives out for 1.3 s: the video stands still while the sound
  // goes on, and comes back 1.3 s behind it, which is not a scrub.
  await callFake(page, 0, 'stall', 1300);
  const positions: number[] = [];
  for (let i = 0; i < 12; i++) {
    positions.push((await appState()).positionS);
    await page.waitForTimeout(150);
  }
  for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
  expect(positions[positions.length - 1]).toBeGreaterThan(positions[0] + 1);
  expect((await appState()).player).toBe('playing');

  // The periodic check is what brings the video back to the sound.
  await expect.poll(async () => (await seeksOf()).length, { timeout: 4000 }).toBe(before + 1);
  const [move] = await movesOfVideo();
  expect(Math.abs(move.target - move.engine)).toBeLessThan(0.05);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('10. a failed fetch shows the step\'s error and Add again, which asks the service afresh', async () => {
  await freshPage();
  await loadLink();
  service.status = linkStatus(VIDEO, stepStatus('failed', 0.3, FETCH_ERROR));
  await prepareButton().click();
  await waitForPhase('failed');

  await expect(prepareNote()).toHaveText(FETCH_ERROR);
  await expect(prepareButton()).toHaveText('Add again');
  await expect(prepareButton()).toBeEnabled();
  await expect(statusText()).toHaveText(FETCH_ERROR);
  expect((await appState()).status.kind).toBe('error');
  expect(service.count('POST', '/songs/url')).toBe(1);
  // The video carries on as it was.
  const state = await appState();
  expect(state.clock).toBe('embed');
  expect(state.player).toBe('ready');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  // The fault is cured; adding again sends the link once more and prepares it.
  service.status = linkStatus(VIDEO, stepStatus('done', 1));
  await prepareButton().click();
  await waitForPhase('prepared');
  expect(service.count('POST', '/songs/url')).toBe(2);
  expect((await appState()).clock).toBe('engine');
});

test('11. a refused link shows the service\'s reason and can be added again', async () => {
  await freshPage();
  await loadLink();
  service.create = { status: 422, detail: TOO_LONG };
  await prepareButton().click();
  await waitForPhase('failed');
  await expect(prepareNote()).toHaveText(TOO_LONG);
  await expect(prepareButton()).toHaveText('Add again');
  // Refused when added: there was nothing to ask about.
  expect(service.songRequests().map((r) => r.method)).toEqual(['POST']);
  expect((await appState()).clock).toBe('embed');
  await expectNetworkErrors(1);
});

test('12. audio the cache lost is asked for again once, and reported if it is still gone', async () => {
  await freshPage();
  await loadLink();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));
  service.audio = [409, 'ok'];
  await prepareButton().click();
  await waitForPhase('prepared');
  expect(service.count('POST', '/songs/url')).toBe(2);
  expect(service.count('GET', `/songs/${SONG_ID}/audio`)).toBe(2);
  await expectNetworkErrors(1);

  await freshPage();
  await loadLink();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));
  service.audio = [409, 409];
  await prepareButton().click();
  await waitForPhase('failed');
  await expect(prepareNote()).toHaveText(AUDIO_MISSING);
  await expect(prepareButton()).toHaveText('Add again');
  expect(service.count('POST', '/songs/url')).toBe(2);
  expect(service.count('GET', `/songs/${SONG_ID}/audio`)).toBe(2);
  expect((await appState()).clock).toBe('embed');
  await expectNetworkErrors(2);
});

test('13. a take being recorded on the video holds the switch back until it ends', async () => {
  // The take of test 5 is the same song's; this test counts its own.
  await clearTakes();
  await freshPage();
  await loadLink();
  await openFakeMic();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));

  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true, undefined, { timeout: 10_000 });
  await prepareButton().click();
  await waitForPhase('waiting');
  await expect(prepareNote()).toContainText('Prepared; switching after this take');
  // Held: still the video's clock and still recording, well after the audio
  // came.
  await page.waitForTimeout(600);
  let state = await appState();
  expect(state.clock).toBe('embed');
  expect(state.recording).toBe(true);
  expect(state.prepare.phase).toBe('waiting');
  expect((await fakeHandle(0)).muted).toBe(false);

  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(1);
  await waitForPhase('prepared');
  state = await appState();
  expect(state.clock).toBe('engine');
  expect((await fakeHandle(0)).muted).toBe(true);

  // A take on the engine joins the one made over the video, in one list.
  await seekTo(0.2);
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true, undefined, { timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(2);
  const takes = await readStoredTakes(page);
  expect(takes.map((take) => take.songHash)).toEqual([SONG_ID, SONG_ID]);
  expect(takes.map((take) => take.clock).sort()).toEqual(['embed', 'engine']);
  await expect(page.locator('[data-testid="take-item"][data-clock="embed"]')).toHaveCount(1);
});

test('14. a new link or a dropped file stops a preparation under way: no more polling, nothing switches', async () => {
  await freshPage();
  await loadLink();
  service.status = linkStatus(VIDEO, stepStatus('running', 0.3));
  await prepareButton().click();
  await expect(prepareSteps()).toHaveText('Fetching audio 30%');

  // A newer link wins. The old song stops being asked about, and the new one
  // is offered Prepare afresh, with nothing sent for it.
  service.create = linkStatus(OTHER_VIDEO, stepStatus('queued'));
  service.status = linkStatus(OTHER_VIDEO, stepStatus('queued'));
  await pasteInto(page, `https://youtu.be/${OTHER_VIDEO}`);
  await songIsVideo(OTHER_VIDEO);
  await waitForPhase('ready');
  const asked = service.count('GET', `/songs/${SONG_ID}`);
  const posts = service.count('POST', '/songs/url');
  await page.waitForTimeout(2500);
  expect(service.count('GET', `/songs/${SONG_ID}`)).toBe(asked);
  expect(service.count('POST', '/songs/url')).toBe(posts);
  let state = await appState();
  expect(state.song?.hash).toBe(`yt-${OTHER_VIDEO}`);
  expect(state.clock).toBe('embed');
  await expect(prepareButton()).toBeEnabled();

  // A dropped file wins as well: the panel goes, and so does the video.
  service.status = linkStatus(OTHER_VIDEO, stepStatus('running', 0.2));
  await prepareButton().click();
  await expect(prepareSteps()).toHaveText('Fetching audio 20%');
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(
    () => window.encore!.store.state.song?.name === 'song.wav' && window.encore!.store.state.clock === 'engine',
  );
  await expect(page.getByTestId('prepare')).toBeHidden();
  const stopped = service.count('GET', `/songs/yt-${OTHER_VIDEO}`);
  await page.waitForTimeout(2500);
  expect(service.count('GET', `/songs/yt-${OTHER_VIDEO}`)).toBe(stopped);
  state = await appState();
  expect(state.prepare.phase).toBe('none');
  expect(state.embed).toBeNull();
  expect(state.song?.name).toBe('song.wav');
  expect(await page.locator('iframe').count()).toBe(0);
});

test('15. the automatic setting is off by default, is saved, and sends a link as it loads', async () => {
  await freshPage();
  const box = page.getByTestId('auto-prepare');
  await expect(box).not.toBeChecked();
  await expect(page.locator('label[for="auto-prepare"]')).toHaveText(
    'Prepare YouTube songs automatically (downloads the audio; see service/README.md)',
  );
  await box.check();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').autoPrepareLinks)).toBe(true);

  service.status = linkStatus(VIDEO, stepStatus('done', 1));
  await pasteInto(page, LINK);
  // No press of Prepare: the link goes to the service by itself, once.
  await waitForPhase('prepared');
  expect(service.count('POST', '/songs/url')).toBe(1);
  expect((await appState()).clock).toBe('engine');
  expect((await fakeHandle(0)).muted).toBe(true);

  // A link that loads while the service is down is sent once it is back and
  // the window is returned to, since the person asked for that.
  await freshPage();
  await expect(box).toBeChecked();
  service.up = false;
  service.status = linkStatus(VIDEO, stepStatus('done', 1));
  await pasteInto(page, LINK);
  await songIsVideo(VIDEO);
  await waitForPhase('unavailable');
  expect(service.songRequests()).toEqual([]);
  service.up = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitForPhase('prepared');
  expect(service.count('POST', '/songs/url')).toBe(1);
  await expectNetworkErrors(1);

  // Saved across a reload, and turned off again the same way.
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await expect(box).toBeChecked();
  await box.uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').autoPrepareLinks)).toBe(false);
  service.reset(VIDEO);
  await loadLink();
  await page.waitForTimeout(1200);
  expect(service.songRequests()).toEqual([]);
});

/** The first fake player as the page holds it, for the steps that drive it. */
interface PageFake {
  state: number;
  baseS: number;
  seekTo(seconds: number, ahead: boolean): void;
  pauseVideo(): void;
}

test('16. a loop set after the switch repeats on the engine and the video, and a video that wraps first never moves the sound', async () => {
  await freshPage();
  await loadLink();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));
  await prepareButton().click();
  await waitForPhase('prepared');

  // A and B on the engine's clock: 1 s to 3 s of its 4 s. The video has no
  // loop call of its own to record: it wraps by itself, with a seek to the
  // start of the loop, and the fake sees that as seekTo:1.
  await seekTo(1);
  await page.keyboard.press('[');
  await page.waitForFunction(() => window.encore!.store.state.loop !== null);
  await seekTo(3);
  await page.keyboard.press(']');
  await page.waitForFunction(() => window.encore!.store.state.loop?.endS === 3);
  await page.waitForFunction(() => Math.abs(window.encore!.store.state.positionS - 1) < 0.05);
  expect((await appState()).loop).toEqual({ startS: 1, endS: 3 });

  // The engine's own loop wraps announce nothing, so a move it is told of is
  // somebody's doing. The video's wraps are noted with where the sound was.
  await page.evaluate(() => {
    const seen = window as unknown as { __engineSeeks: number; __wrapAt: number[] };
    seen.__engineSeeks = 0;
    seen.__wrapAt = [];
    window.encore!.session.parts!.player.on('seek', () => (seen.__engineSeeks += 1));
    const fake = (window as unknown as { __yt: { players: PageFake[] } }).__yt.players[0];
    const seekTo = fake.seekTo.bind(fake);
    fake.seekTo = (seconds, ahead) => {
      if (seconds === 1) seen.__wrapAt.push(window.encore!.session.transport!.positionS);
      seekTo(seconds, ahead);
    };
  });
  const wrapsOf = async (): Promise<number> => (await fakeHandle(0)).calls.filter((c) => c === 'seekTo:1').length;

  // Past the echo of the commands the app just sent the video.
  await page.waitForTimeout(1000);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.waitForFunction(
    () => (window as unknown as { __yt: { players: PageFake[] } }).__yt.players[0].state === 1,
  );
  // The video runs 0.3 s ahead of the sound: inside the half second the
  // follower lets it be, and enough for it to reach the end of the loop and
  // wrap before the sound does.
  await page.evaluate(() => {
    (window as unknown as { __yt: { players: PageFake[] } }).__yt.players[0].baseS += 0.3;
  });

  const positions: number[] = [];
  for (let i = 0; i < 100 && (await wrapsOf()) < 2; i++) {
    positions.push((await appState()).positionS);
    await page.waitForTimeout(100);
  }
  expect(await wrapsOf()).toBeGreaterThanOrEqual(2);
  // The sound stayed inside the loop, and went round it by itself.
  expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(1);
  for (const position of positions) {
    expect(position).toBeGreaterThanOrEqual(1);
    expect(position).toBeLessThan(3);
  }
  const seen = await page.evaluate(() => {
    const store = window as unknown as { __engineSeeks: number; __wrapAt: number[] };
    return { engineSeeks: store.__engineSeeks, wrapAt: store.__wrapAt };
  });
  // The video did wrap with the sound still short of the end of the loop, and
  // the sound was not moved for it.
  expect(seen.wrapAt.some((positionS) => positionS > 2.5)).toBe(true);
  expect(seen.engineSeeks).toBe(0);
  expect((await appState()).player).toBe('playing');

  // Stop pauses the video and takes it to the start.
  await page.getByTestId('stop').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'ready');
  expect((await fakeHandle(0)).calls.slice(-2)).toEqual(['pauseVideo', 'seekTo:0']);

  // Clearing the loop clears it on the video as well: played on past 3 s, the
  // video no longer wraps.
  await page.getByTestId('loop-clear').click();
  await page.waitForFunction(() => window.encore!.store.state.loop === null);
  const wraps = await wrapsOf();
  await seekTo(2.4);
  await page.waitForTimeout(1000);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.positionS > 3.3);
  expect(await wrapsOf()).toBe(wraps);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('17. a pause pressed in the video just after the app\'s Play is put right by the next check, with the sound playing on', async () => {
  await seekTo(0.1);
  // Past the echo of the seek the app just sent the video.
  await page.waitForTimeout(1000);
  const playsOf = async (): Promise<number> => (await fakeHandle(0)).calls.filter((c) => c === 'playVideo').length;
  const before = await playsOf();

  // Play from the app and, the moment the video plays, pause it with its own
  // control: a few tens of milliseconds after the follower's command, well
  // inside the quiet it keeps for the echo of its commands, so the pause
  // passes as one.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const fake = (window as unknown as { __yt: { players: PageFake[] } }).__yt.players[0];
        (document.querySelector('[data-testid="play"]') as HTMLButtonElement).click();
        const timer = setInterval(() => {
          if (fake.state !== 1) return;
          clearInterval(timer);
          fake.pauseVideo();
          resolve();
        }, 5);
      }),
  );
  expect((await fakeHandle(0)).calls.at(-1)).toBe('pauseVideo');
  expect(await playsOf()).toBe(before + 1);
  // Not heard: the sound plays on.
  expect((await appState()).player).toBe('playing');

  // The check that comes next finds the sound going and the picture not, and
  // starts the picture again. The sound is still the master throughout.
  await page.waitForFunction(
    () => (window as unknown as { __yt: { players: PageFake[] } }).__yt.players[0].state === 1,
    undefined,
    { timeout: 6000 },
  );
  expect(await playsOf()).toBe(before + 2);
  expect((await appState()).player).toBe('playing');
  expect(Math.abs((await videoClock()) - (await appState()).positionS)).toBeLessThan(0.5);

  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

/** A file that is called audio and is not, so that loading it fails. */
const NOT_AUDIO = { name: 'bad.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('this is not audio') };

test('18. a service check not yet answered when a newer load fails is asked again: Prepare waits for the answer and an automatic send is not lost', async () => {
  await freshPage();
  let answer = service.holdHealth();
  await pasteInto(page, LINK);
  await songIsVideo(VIDEO);
  await waitForPhase('checking');
  await expect(prepareButton()).toBeDisabled();

  // A file that cannot be read overtakes the check and fails; the video stays.
  await page.getByTestId('song-input').setInputFiles(NOT_AUDIO);
  await expect(statusText()).toContainText('bad.mp3');
  expect((await appState()).clock).toBe('embed');
  // Nothing has said that the service runs, so Prepare is still off, and the
  // question was put again rather than taken for a yes.
  await expect.poll(() => service.count('GET', '/health')).toBe(2);
  expect((await appState()).prepare.phase).toBe('checking');
  await expect(prepareButton()).toBeDisabled();
  answer();
  await waitForPhase('ready');
  await expect(prepareButton()).toBeEnabled();
  expect(service.songRequests()).toEqual([]);

  // With the automatic setting on, the link that was waiting for that answer
  // is sent when it comes, though a newer load came and failed meanwhile.
  await page.getByTestId('auto-prepare').check();
  await freshPage();
  answer = service.holdHealth();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));
  await pasteInto(page, LINK);
  await songIsVideo(VIDEO);
  await waitForPhase('checking');
  await page.getByTestId('song-input').setInputFiles(NOT_AUDIO);
  await expect(statusText()).toContainText('bad.mp3');
  expect(service.songRequests()).toEqual([]);
  answer();
  await waitForPhase('prepared');
  expect(service.count('POST', '/songs/url')).toBe(1);
  expect((await appState()).clock).toBe('engine');

  // The default again, for whatever runs next.
  await page.getByTestId('auto-prepare').uncheck();
});

/** Waits until the engine's own clock has reached `positionS` in the song. */
async function waitForEngineAt(positionS: number): Promise<void> {
  await page.waitForFunction((s) => window.encore!.session.parts!.player.positionS >= s, positionS, {
    timeout: 20_000,
    polling: 50,
  });
}

test('19. a slow audio context is waited for before the song is handed over, so the position runs on across the switch without a step', async () => {
  await freshPage();
  await loadLink();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));
  // The video is playing, as it is when Prepare is pressed.
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  // The context has been let go, and takes 0.9 s to run again.
  await suspendContext(900);
  const callsBefore = (await fakeHandle(0)).calls.length;
  await startSampling();
  await prepareButton().click();
  await waitForPhase('prepared');
  const handedOverAt = (await appState()).positionS;
  // Handed over with the context running, so the engine's clock moves from the
  // first moment. Were the song left waiting for it, it would stand 0.9 s
  // behind the video, and the picture would run on ahead of it unseen. The song
  // is 4 s long, so the waits are for places in it, not for times.
  await waitForEngineAt(Math.min(handedOverAt + 0.9, 3.1));
  await callFake(page, 0, 'stall', 100);
  await waitForEngineAt(Math.min(handedOverAt + 1.5, 3.6));
  const samples = await stopSampling();

  const handedOver = samples.findIndex((sample) => sample.clock === 'engine');
  expect(handedOver).toBeGreaterThan(0);
  expect(samples[handedOver].ctx).toBe('running');
  // The song's position goes on without a step of half a second, or back.
  const song = stepsOf(samples, 'song');
  expect(song.forward).toBeLessThan(0.5);
  expect(song.back).toBeLessThan(0.1);
  // The engine carries on from where the video was, and keeps beside it.
  const last = samples[samples.length - 1];
  expect(last.engine).toBeGreaterThan(samples[handedOver].engine + 0.2);
  expect(Math.abs(last.engine - last.video)).toBeLessThan(0.4);
  expect(stepsOf(samples.slice(handedOver), 'engine').forward).toBeLessThan(0.5);
  // The video was neither paused nor moved by the follower.
  const calls = (await fakeHandle(0)).calls.slice(callsBefore);
  expect(calls.filter((call) => call.startsWith('seekTo:') || call === 'pauseVideo')).toEqual([]);
});

test('20. Play beside a slow audio context holds the video until the sound runs, then keeps it beside the sound', async () => {
  await freshPage();
  await loadLink();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));
  await prepareButton().click();
  await waitForPhase('prepared');
  await seekTo(0.2);
  // Past the echo of the seek the app just sent the video.
  await page.waitForTimeout(1000);
  await suspendContext(1200);
  // Note the context and the song's place whenever the video is told to play.
  await page.evaluate(() => {
    const w = window as unknown as { __plays: Array<{ ctx: string; engine: number }> };
    w.__plays = [];
    const { session } = window.encore!;
    const fake = (window as unknown as { __yt: { players: Array<{ playVideo(): void }> } }).__yt.players[0];
    const playVideo = fake.playVideo.bind(fake);
    fake.playVideo = () => {
      w.__plays.push({ ctx: session.parts!.engine.context.state, engine: session.parts!.player.positionS });
      playVideo();
    };
  });
  const callsBefore = (await fakeHandle(0)).calls.length;
  await startSampling();
  await page.getByTestId('play').click();
  // Playing as far as the app can tell, the song standing where it was left.
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  // The context runs 1.2 s on and the song plays from 0.2. By 2.6 it has played
  // for 2.4 s, past a periodic check (every 2 s), which would have pulled back
  // a video that had run on.
  await waitForEngineAt(2.6);
  const samples = await stopSampling();

  // While the context stood, neither the song nor the picture moved.
  expect(samples.filter((sample) => sample.ctx === 'suspended').length).toBeGreaterThan(20);
  expect(spreadWhile(samples, 'suspended', 'engine')).toBeLessThan(0.001);
  expect(spreadWhile(samples, 'suspended', 'video')).toBeLessThan(0.001);
  // The video was told to play once, with the context running and the song's
  // clock already moving.
  const plays = await page.evaluate(
    () => (window as unknown as { __plays: Array<{ ctx: string; engine: number }> }).__plays,
  );
  expect(plays).toHaveLength(1);
  expect(plays[0].ctx).toBe('running');
  expect(plays[0].engine).toBeGreaterThan(0.2);
  // Then it kept beside the song, and nothing was pulled around.
  const last = samples[samples.length - 1];
  expect(last.engine).toBeGreaterThan(1.5);
  expect(Math.abs(last.engine - last.video)).toBeLessThan(0.4);
  expect(stepsOf(samples, 'song').forward).toBeLessThan(0.5);
  expect(stepsOf(samples, 'engine').forward).toBeLessThan(0.5);
  const calls = (await fakeHandle(0)).calls.slice(callsBefore);
  expect(calls.filter((call) => call.startsWith('seekTo:'))).toEqual([]);
  expect((await appState()).player).toBe('playing');
});

test('21. a video played with its own button beside a slow audio context is joined by the sound, not pulled back to it', async () => {
  await freshPage();
  await loadLink();
  service.create = linkStatus(VIDEO, stepStatus('done', 1));
  await prepareButton().click();
  await waitForPhase('prepared');
  await seekTo(0.2);
  // Past the echo of the seek the app just sent the video.
  await page.waitForTimeout(1000);
  await suspendContext(1500);
  const callsBefore = (await fakeHandle(0)).calls.length;
  await startSampling();
  // The person plays the video itself. The sound is started from it, and its
  // clock stands until the context runs.
  await callFake(page, 0, 'playVideo');
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  // A moment's stall in the video, 1.1 s on: the sound is standing 1.1 s behind
  // the picture, and the video's coming back must not carry the sound off.
  await page.waitForTimeout(1100);
  await callFake(page, 0, 'stall', 100);
  await page.waitForFunction(() => window.encore!.session.parts!.engine.context.state === 'running');
  // The sound joined the picture at about 1.7 and has played on from there.
  await waitForEngineAt(2.4);
  const samples = await stopSampling();

  // The sound stood where it was left until the context ran.
  expect(samples.filter((sample) => sample.ctx === 'suspended').length).toBeGreaterThan(20);
  expect(spreadWhile(samples, 'suspended', 'engine')).toBeLessThan(0.001);
  // Then it took up where the picture was, and they ran on together.
  const last = samples[samples.length - 1];
  expect(last.engine).toBeGreaterThan(1.5);
  expect(Math.abs(last.engine - last.video)).toBeLessThan(0.4);
  // The picture kept going: it was not moved, and its clock never went back.
  expect(stepsOf(samples, 'video').back).toBeLessThan(0.05);
  const calls = (await fakeHandle(0)).calls.slice(callsBefore);
  expect(calls.filter((call) => call.startsWith('seekTo:') || call === 'pauseVideo')).toEqual([]);
  expect((await appState()).player).toBe('playing');
});
