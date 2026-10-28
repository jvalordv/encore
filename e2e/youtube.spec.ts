/**
 * End-to-end proof of playing a YouTube link inside the app, in real Chromium
 * against the production bundle, with YouTube itself replaced: Playwright
 * routing serves a fake IFrame API script (and a blank page for the iframe)
 * and refuses every other request to YouTube's hosts, so the run never
 * reaches the network. The fake `YT.Player` replaces its target with a real
 * iframe, keeps a clock that runs while it "plays", fires the events the real
 * one does, and can be told from the test to start an ad or raise an error.
 * Covered: nothing is fetched until a link is used, and an unreachable
 * YouTube says so; pasting a link loads it; the player pane is at least 480
 * by 270, never covered and not restyled in every skin and at window sizes
 * from wide to phone width, whole inside the page (or reachable by scrolling
 * the stage when the window is narrower than the player), with the lane beside
 * or below it; Play starts it, the time advances and Pause holds; Stop and A
 * and B go through it; a take recorded over it is marked approximate and
 * replays by itself, and the video's own play button takes over from it; an ad
 * stops everything; calibration is not played over, even from the iframe's own
 * controls; errors and a blocked autoplay say so; dropping a file swaps back
 * to the audio player and destroys the YouTube one; a video that cannot be
 * embedded fails the load, says the song in use is still loaded and leaves it,
 * a video playing on or a file, as it was; with nothing loaded the same
 * failure says only why; a newer load wins over an older one; a video loading
 * behind the one in use never covers it and replaces it only when ready.
 * The service is stubbed as well, answering its health check and the upload of a
 * dropped file: loading and playing links must never send one to it, which
 * every test checks. The tests
 * share one page and run in order, each building on the state the last left
 * behind.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { stubService } from './fake-service';
import type { FakeService } from './fake-service';
import {
  FAKE_IFRAME_API,
  callFake,
  countFakePlayers,
  pasteInto,
  readAppState,
  readFakeHandle,
  readStoredTakes,
  setReadyDelay,
} from './fake-youtube';
import type { FakeHandle } from './fake-youtube';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const OTHER_VIDEO = 'aB3_x-Y9zQ0';
/** A video that cannot be embedded: the fake reports error 150 for it. */
const BLOCKED_VIDEO = 'bLoCkEd_vid';
/** What error 150 says: the video may not exist, or its owner blocks apps. */
const NOT_PLAYABLE =
  'YouTube would not play that video here: it may not exist or its owner blocks other apps. Check the link.';
/** Added to a failed load's message while a song is loaded and stays. */
const SONG_KEPT = 'The previous song is still loaded.';
const LINK = `https://www.youtube.com/watch?v=${VIDEO}&list=PLignored`;
const TITLE = 'Fake Video Title';
/** 3:33, so the song panel and the time readout have a length to show. */
const DURATION_S = 213;
const SKINS = ['studio', 'arcade', 'dreamhouse'] as const;

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
/** Unexpected requests to YouTube's hosts (there must be none). */
const strayRequests: string[] = [];
/** Requests the stubs answered, in order. */
const served: string[] = [];
/** Every request for the IFrame API script, answered or refused. */
const apiAttempts: string[] = [];
/** While true the IFrame API script is refused, as if YouTube were down. */
let failApi = false;
/** The service stand-in; a link is only ever answered a health check. */
let service: FakeService;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
    permissions: ['microphone'],
  });
  // The page links Google Fonts; an empty sheet keeps the run offline-safe.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  // Routes registered later win, so the stubs below sit over this catch-all.
  await context.route(/(youtube|youtube-nocookie|ytimg|googlevideo|doubleclick|googleadservices)\.com/, (route) => {
    strayRequests.push(route.request().url());
    return route.abort();
  });
  await context.route('https://www.youtube.com/iframe_api', (route) => {
    apiAttempts.push(route.request().url());
    if (failApi) return route.abort();
    served.push(route.request().url());
    const config = JSON.stringify({ title: TITLE, durationS: DURATION_S, readyDelayMs: 30, blockedIds: [BLOCKED_VIDEO] });
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: FAKE_IFRAME_API.replace('__CONFIG__', config),
    });
  });
  await context.route('https://www.youtube-nocookie.com/embed/**', (route) => {
    served.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>fake player</title><body style="margin:0;background:#111;color:#ddd;font:14px sans-serif">fake YouTube player</body>',
    });
  });
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
  // Nothing is sent to the service for a link unless Prepare is pressed. A
  // dropped file is offered to it for its karaoke track, which is not a link.
  const beyondUploads = service.songRequests().filter((r) => !(r.method === 'POST' && r.path === '/songs'));
  expect(beyondUploads, 'requests to the service beyond health checks and uploads').toEqual([]);
});

test.afterAll(async () => {
  await context.close();
});

/** A copy of the app state as the page holds it right now. */
function appState(): Promise<AppState> {
  return readAppState(page);
}

/** What the n-th fake player has recorded about itself. */
function fakeHandle(index: number): Promise<FakeHandle> {
  return readFakeHandle(page, index);
}

/** Calls a control method on the n-th fake player. */
function fakeDo(index: number, method: string, ...args: Array<string | number>): Promise<void> {
  return callFake(page, index, method, ...args);
}

/** Pastes `text` as if from the clipboard, onto the page or onto a field. */
function pasteText(text: string, selector?: string): Promise<void> {
  return pasteInto(page, text, selector);
}

/** How many fake players have been built so far. */
function playerCount(): Promise<number> {
  return countFakePlayers(page);
}

/** Sets how long the next fake players take to report ready. */
function readyAfter(ms: number): Promise<void> {
  return setReadyDelay(page, ms);
}

/**
 * Waits until the video is the song in use and idle. The pane's `embed` state
 * is set as soon as a link starts loading, so it alone says nothing about a
 * song; the song's own hash and the clock change only when the video takes
 * over.
 */
async function songIsVideo(id: string): Promise<void> {
  await page.waitForFunction(
    (hash) => {
      const state = window.encore!.store.state;
      return state.song?.hash === hash && state.clock === 'embed' && state.player === 'ready';
    },
    `yt-${id}`,
  );
}

/**
 * Resolves once the lane, the player pane and the lane's bitmap have kept the
 * same size for two animation frames, which is what a resize needs to settle.
 * It gives up after two seconds, so a layout that never settles fails the
 * assertions after it instead of hanging here.
 */
async function layoutSettled(): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const box = (selector: string): string => {
          const r = document.querySelector(selector)?.getBoundingClientRect();
          return r ? `${r.x},${r.y},${r.width},${r.height}` : 'none';
        };
        const snapshot = (): string => {
          const canvas = document.querySelector<HTMLCanvasElement>('#lane-canvas');
          return [
            box('#pitch-lane'),
            box('#embed-region'),
            box('#embed-player iframe'),
            `${canvas?.width}x${canvas?.height}`,
            `${window.innerWidth}x${window.innerHeight}`,
          ].join('|');
        };
        const giveUp = setTimeout(resolve, 2000);
        let last = snapshot();
        let stable = 0;
        const step = (): void => {
          const now = snapshot();
          stable = now === last ? stable + 1 : 0;
          last = now;
          if (stable >= 2) {
            clearTimeout(giveUp);
            resolve();
          } else {
            requestAnimationFrame(step);
          }
        };
        requestAnimationFrame(step);
      }),
  );
}

/** The takes in IndexedDB, without their audio. */
function readTakes(): ReturnType<typeof readStoredTakes> {
  return readStoredTakes(page);
}

test('1. nothing from YouTube is fetched until a link is used, and the player pane is hidden', async () => {
  expect(served).toEqual([]);
  expect(apiAttempts).toEqual([]);
  await expect(page.getByTestId('embed-region')).toBeHidden();
  await expect(page.getByTestId('dropzone')).toHaveText(
    'Drop an mp3 here, click to choose one, or paste a YouTube link',
  );
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.locator('script[src*="youtube"]').count()).toBe(0);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'strict-origin-when-cross-origin');
  await expect(page.locator('#app')).toHaveAttribute('data-embed', 'off');
  const state = await appState();
  expect(state.clock).toBe('engine');
  expect(state.embed).toBeNull();
  await expect(page.getByTestId('embed-offset')).toBeHidden();
});

test('2. an unreachable YouTube says so, leaves the page as it was, and does not try again by itself', async () => {
  failApi = true;
  const errorsBefore = pageErrors.length;
  await pasteText(LINK);
  await expect(page.getByTestId('status-text')).toHaveText('Could not reach YouTube. Check the connection.');
  const state = await appState();
  expect(state.status.kind).toBe('error');
  expect(apiAttempts).toHaveLength(1);
  expect(state.embed).toBeNull();
  expect(state.clock).toBe('engine');
  expect(state.player).toBe('empty');
  await expect(page.getByTestId('embed-region')).toBeHidden();
  expect(await page.locator('script[src*="iframe_api"]').count()).toBe(0);

  // The browser logs the refused script as a console error; that is expected.
  for (let i = 0; i < 10 && pageErrors.length === errorsBefore; i++) await page.waitForTimeout(100);
  for (const entry of pageErrors.splice(errorsBefore)) expect(entry).toMatch(/Failed to load resource/);
  failApi = false;
  await page.waitForTimeout(300);
  expect(apiAttempts).toHaveLength(1);
});

test('3. pasting a link anywhere loads it: the title, the length, a cued player and no autoplay', async () => {
  await pasteText(LINK);
  await page.waitForFunction(() => window.encore!.store.state.player === 'ready' && window.encore!.store.state.clock === 'embed');

  const state = await appState();
  expect(state.embed).toEqual({ videoId: VIDEO });
  expect(state.song).toEqual({ name: TITLE, durationS: DURATION_S, hash: `yt-${VIDEO}` });
  await expect(page.getByTestId('song-title')).toHaveText(TITLE);
  await expect(page.getByTestId('song-duration')).toHaveText('3:33');
  await expect(page.getByTestId('status-text')).toHaveText(
    `Loaded ${TITLE} (3:33) from YouTube. Pick a microphone, then press Play.`,
  );
  await expect(page.getByTestId('embed-region')).toBeVisible();
  await expect(page.getByTestId('embed-note')).toBeVisible();
  await expect(page.getByTestId('embed-offset')).toBeVisible();
  await expect(page.getByTestId('play')).toBeEnabled();

  // The API script was fetched once, now; the iframe is in the nocookie host.
  expect(served.filter((url) => url.endsWith('/iframe_api'))).toHaveLength(1);
  const iframe = page.locator('#embed-player iframe');
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute('src', new RegExp(`^https://www\\.youtube-nocookie\\.com/embed/${VIDEO}\\?`));

  const fake = await fakeHandle(0);
  expect(fake.options.host).toBe('https://www.youtube-nocookie.com');
  expect(fake.options.videoId).toBe(VIDEO);
  expect(fake.options.playerVars).toEqual({
    enablejsapi: 1,
    origin: `http://localhost:${PORT}`,
    playsinline: 1,
    rel: 0,
    controls: 1,
  });
  // Cued, never played: the app does not rely on autoplay.
  expect(fake.calls).toEqual([]);
  await expect(page.locator('#app')).toHaveAttribute('data-embed', 'on');
  // The retry after the refused script is a second attempt, and it worked.
  expect(apiAttempts).toHaveLength(2);

  // Nudging a video that has not started cues it again at the new time. The
  // player would start playing if it were asked to seek, and it must not.
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => Math.abs(window.encore!.store.state.positionS - 5) < 0.5);
  expect((await appState()).player).toBe('ready');
  expect((await fakeHandle(0)).calls).toEqual(['cue:5']);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.encore!.store.state.positionS === 0);
  expect((await fakeHandle(0)).calls).toEqual(['cue:5', 'cue:0']);
  expect((await appState()).player).toBe('ready');
});

test('4. the player pane is at least 480 by 270, never covered or restyled, and whole inside the page at every width', async () => {
  const sizes = [
    { width: 1280, height: 720 },
    { width: 1366, height: 657 },
    { width: 1600, height: 900 },
    { width: 1000, height: 800 },
    // Beside the song column the stage is narrowest just above 780 px, where
    // the song panel moves above it; the stacked layout then runs on down.
    { width: 800, height: 800 },
    { width: 781, height: 800 },
    { width: 780, height: 800 },
    { width: 760, height: 800 },
    { width: 740, height: 800 },
    { width: 600, height: 800 },
    { width: 560, height: 800 },
    // Narrower than the player's frame: the stage scrolls sideways.
    { width: 500, height: 800 },
    { width: 375, height: 812 },
  ];
  for (const skin of SKINS) {
    await page.selectOption('#skin-switcher', skin);
    for (const size of sizes) {
      await page.setViewportSize(size);
      await layoutSettled();
      // A stacked page is taller than the window; bring the player into it.
      await page.evaluate(() => {
        document.querySelector('#embed-player iframe')!.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
      const report = await page.evaluate(() => {
        const rect = (element: Element) => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
        };
        const query = (selector: string) => document.querySelector(selector)!;
        const iframe = query('#embed-player iframe') as HTMLIFrameElement;
        const stage = query('#stage') as HTMLElement;
        const box = iframe.getBoundingClientRect();
        const hit = (x: number, y: number) => document.elementFromPoint(x, y) === iframe;
        const chain = [iframe, query('.embed-slot'), query('.embed-player'), query('.embed-region')];
        const styles = chain.map((el) => {
          const cs = getComputedStyle(el);
          return {
            transform: cs.transform,
            filter: cs.filter,
            opacity: cs.opacity,
            clipPath: cs.clipPath,
            overflow: cs.overflow,
            blend: cs.mixBlendMode,
            after: getComputedStyle(el, '::after').content,
            before: getComputedStyle(el, '::before').content,
          };
        });
        return {
          iframe: rect(iframe),
          region: rect(query('#embed-region')),
          lane: rect(query('#pitch-lane')),
          stage: { ...rect(stage), scrollWidth: stage.scrollWidth, clientWidth: stage.clientWidth },
          centreIsIframe: hit(box.x + box.width / 2, box.y + box.height / 2),
          cornersAreIframe: [
            hit(box.x + 2, box.y + 2),
            hit(box.right - 2, box.y + 2),
            hit(box.x + 2, box.bottom - 2),
            hit(box.right - 2, box.bottom - 2),
          ],
          styles,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      const where = `${skin} at ${size.width}x${size.height}`;
      expect(report.iframe.width, where).toBeGreaterThanOrEqual(480);
      expect(report.iframe.height, where).toBeGreaterThanOrEqual(270);
      expect(Math.abs(report.iframe.width / report.iframe.height - 16 / 9), where).toBeLessThan(0.02);
      // The player never sticks out of its frame, whatever the window.
      expect(report.iframe.x, where).toBeGreaterThanOrEqual(report.region.x - 0.5);
      expect(report.iframe.right, where).toBeLessThanOrEqual(report.region.right + 0.5);
      expect(report.iframe.y, where).toBeGreaterThanOrEqual(report.region.y - 0.5);
      expect(report.iframe.bottom, where).toBeLessThanOrEqual(report.region.bottom + 0.5);
      // The page itself never scrolls sideways.
      expect(report.scrollWidth, where).toBeLessThanOrEqual(report.innerWidth);
      // Not clipped, scaled, blended or tinted, and no pseudo-element on it.
      for (const style of report.styles) {
        expect(style.transform, where).toBe('none');
        expect(style.filter, where).toBe('none');
        expect(style.opacity, where).toBe('1');
        expect(style.clipPath, where).toBe('none');
        expect(style.blend, where).toBe('normal');
        expect(['none', 'normal'], where).toContain(style.after);
        expect(['none', 'normal'], where).toContain(style.before);
      }
      // Nothing around the player clips it (the iframe's overflow is its own).
      for (const style of report.styles.slice(1)) expect(style.overflow, where).toBe('visible');
      // The lane stays usable and does not overlap the player.
      expect(report.lane.width, where).toBeGreaterThanOrEqual(300);
      expect(report.lane.height, where).toBeGreaterThanOrEqual(150);
      const apart =
        report.lane.x >= report.region.right - 1 || report.lane.y >= report.region.bottom - 1;
      expect(apart, where).toBe(true);
      // Beside the player on wide windows, below it on narrower ones.
      if (size.width >= 1150) expect(report.lane.x, where).toBeGreaterThanOrEqual(report.region.right);
      else expect(report.lane.y, where).toBeGreaterThanOrEqual(report.region.bottom);

      const scrolls = report.stage.scrollWidth > report.stage.clientWidth + 1;
      if (size.width >= 560) {
        // Room for the whole frame: it sits inside the stage and the window,
        // with nothing over it.
        expect(scrolls, where).toBe(false);
        expect(report.region.right, where).toBeLessThanOrEqual(report.stage.right + 0.5);
        expect(report.region.right, where).toBeLessThanOrEqual(report.innerWidth);
        expect(report.centreIsIframe, where).toBe(true);
        expect(report.cornersAreIframe, where).toEqual([true, true, true, true]);
      } else {
        // Too narrow for a 480 pixel player: the stage scrolls, and each end
        // of the player can be brought into view with nothing over it.
        expect(scrolls, where).toBe(true);
        const ends = await page.evaluate(() => {
          const stage = document.querySelector('#stage') as HTMLElement;
          const iframe = document.querySelector('#embed-player iframe') as HTMLIFrameElement;
          const hit = (x: number, y: number) => document.elementFromPoint(x, y) === iframe;
          stage.scrollLeft = 0;
          const first = iframe.getBoundingClientRect();
          const start = [hit(first.x + 2, first.y + 2), hit(first.x + 2, first.bottom - 2)];
          stage.scrollLeft = stage.scrollWidth;
          const last = iframe.getBoundingClientRect();
          const end = [hit(last.right - 2, last.y + 2), hit(last.right - 2, last.bottom - 2)];
          stage.scrollLeft = 0;
          return { start, end, endRight: last.right, innerWidth: window.innerWidth };
        });
        expect(ends.start, where).toEqual([true, true]);
        expect(ends.end, where).toEqual([true, true]);
        expect(ends.endRight, where).toBeLessThanOrEqual(ends.innerWidth);
      }
    }
  }
  await page.selectOption('#skin-switcher', 'studio');
  await page.setViewportSize({ width: 1280, height: 720 });
  await layoutSettled();
  await page.evaluate(() => window.scrollTo(0, 0));
});

test('5. Play starts the video, the title and time advance, and Pause holds the time', async () => {
  const play = page.getByTestId('play');
  await expect(play).toHaveText('Play');
  await play.click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await expect(play).toHaveText('Pause');
  expect((await fakeHandle(0)).calls).toContain('playVideo');

  await page.waitForFunction(() => window.encore!.store.state.positionS > 0.8);
  const playing = await appState();
  expect(playing.positionS).toBeLessThan(2.5);
  await expect(page.getByTestId('song-title')).toHaveText(TITLE);
  await expect(page.getByTestId('time')).toHaveText(/^0:0[0-9] \/ 3:33$/);
  // The song clock is the player's clock.
  const fake = await page.evaluate(() => {
    const yt = (window as unknown as { __yt: { players: Array<{ getCurrentTime(): number }> } }).__yt;
    return { player: yt.players[0].getCurrentTime(), session: window.encore!.session.transport!.positionS };
  });
  expect(Math.abs(fake.session - fake.player)).toBeLessThan(0.3);

  const first = (await appState()).positionS;
  await page.waitForTimeout(500);
  const second = (await appState()).positionS;
  expect(second - first).toBeGreaterThan(0.3);
  expect(second - first).toBeLessThan(0.8);

  await play.click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
  await expect(play).toHaveText('Play');
  const held = (await appState()).positionS;
  await page.waitForTimeout(600);
  expect((await appState()).positionS).toBe(held);
});

test('6. Stop goes back to the start, and A and B loop a passage of the video', async () => {
  expect((await appState()).positionS).toBeGreaterThan(0.5);
  await page.getByTestId('stop').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'ready');
  expect((await appState()).positionS).toBe(0);
  expect((await fakeHandle(0)).calls.slice(-2)).toEqual(['pauseVideo', 'seekTo:0']);

  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.waitForTimeout(600);
  await page.keyboard.press('[');
  await page.waitForTimeout(900);
  await page.keyboard.press(']');
  const loop = (await appState()).loop;
  expect(loop).not.toBeNull();
  expect(loop!.endS - loop!.startS).toBeGreaterThan(0.5);
  expect(loop!.endS - loop!.startS).toBeLessThan(1.6);

  // The poll finds the end within a quarter of a second, so the position
  // stays in the loop, give or take that, and keeps coming back to its start.
  const positions: number[] = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    positions.push((await appState()).positionS);
  }
  for (const position of positions) {
    expect(position).toBeGreaterThanOrEqual(loop!.startS - 0.1);
    expect(position).toBeLessThanOrEqual(loop!.endS + 0.5);
  }
  expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(0.3);
  const wraps = (await fakeHandle(0)).calls.filter((c) => c.startsWith('seekTo:') && c !== 'seekTo:0');
  expect(wraps.length).toBeGreaterThanOrEqual(2);

  await page.keyboard.press('l');
  await page.waitForFunction(() => window.encore!.store.state.loop === null);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('7. the embed offset field is saved and applies only to takes over the video; the take is marked approximate', async () => {
  const offset = page.getByTestId('embed-offset-input');
  await offset.fill('40');
  await offset.press('Enter');
  await page.waitForFunction(() => window.encore!.store.state.embedOffsetS === 0.04);
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').embedOffsetS as number,
  );
  expect(saved).toBe(0.04);
  // Out of range is limited to half a second; the field shows what was kept.
  await offset.fill('900');
  await offset.press('Enter');
  await expect(offset).toHaveValue('500');
  await offset.fill('40');
  await offset.press('Enter');
  await expect(offset).toHaveValue('40');

  // Open the fake microphone, as the solo loop does.
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

  // Record starts the video itself and waits for it to play.
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true, undefined, { timeout: 10_000 });
  expect((await appState()).player).toBe('playing');
  await expect(page.getByTestId('status-text')).toContainText('Timing over a YouTube video is approximate.');
  await page.waitForTimeout(1500);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(1);
  // Stopping the take paused the video it had started.
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  const [take] = await readTakes();
  expect(take.songHash).toBe(`yt-${VIDEO}`);
  expect(take.clock).toBe('embed');
  // Not calibrated, so the whole latency is the embed offset.
  expect(take.latencyS).toBe(0.04);
  expect(take.durationS).toBeGreaterThan(1);
  expect(take.durationS).toBeLessThan(3);
  expect(take.startedAtSongS).toBeGreaterThan(0);
  expect(take.frames.length).toBeGreaterThan(take.durationS * 80);
  for (let i = 1; i < take.frames.length; i++) expect(take.frames[i].t).toBeGreaterThan(take.frames[i - 1].t);
  expect(take.frames[0].t).toBeGreaterThan(take.startedAtSongS - 0.3);
  expect(take.frames[take.frames.length - 1].t).toBeLessThan(take.startedAtSongS + take.durationS + 0.3);

  await expect(page.getByTestId('take-note')).toHaveText('approximate timing');
  await expect(page.locator('[data-testid="take-item"]')).toHaveAttribute('data-clock', 'embed');
});

test('8. replaying that take over the video plays the take by itself and says so', async () => {
  await page.getByTestId('take-play').click();
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId !== null);
  await expect(page.getByTestId('status-text')).toContainText('by itself');
  await expect(page.getByTestId('status-text')).toContainText('not synced yet');
  // The audio player holds no song, so nothing was mixed under the take.
  expect(await page.evaluate(() => window.encore!.session.parts!.player.stemIds())).toEqual([]);
  expect((await fakeHandle(0)).calls.filter((c) => c === 'pauseVideo').length).toBeGreaterThan(0);
  // The take's own length: the replay ends by itself.
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId === null, undefined, { timeout: 10_000 });
  await expect(page.getByTestId('take-play')).toHaveText('Play');

  // The video's own play button, inside the iframe, never passes through the
  // app's Play; it still takes over from a take playing by itself.
  const soloOf = (): Promise<unknown> =>
    page.evaluate(() => (window.encore!.session as unknown as { solo: unknown }).solo);
  await page.getByTestId('take-play').click();
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId !== null);
  expect(await soloOf()).not.toBeNull();
  await fakeDo(0, 'playVideo');
  await page.waitForFunction(
    () => window.encore!.store.state.playingTakeId === null && window.encore!.store.state.player === 'playing',
  );
  expect(await soloOf()).toBeNull();
  await expect(page.getByTestId('take-play')).toHaveText('Play');
  // The video keeps playing: it was the take that gave way.
  const startedAt = (await appState()).positionS;
  await page.waitForFunction(
    (from) => window.encore!.store.state.player === 'playing' && window.encore!.store.state.positionS > from + 0.3,
    startedAt,
  );
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('9. an ad stops the clock, the lane and recording, and says so', async () => {
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.waitForTimeout(400);
  await fakeDo(0, 'startAd', 'adadadadada', 15);
  await page.waitForFunction(() => window.encore!.store.state.player === 'ad', undefined, { timeout: 3000 });
  await expect(page.getByTestId('status-text')).toContainText('An ad is playing in the video');
  await expect(page.getByTestId('play')).toHaveText('Pause');
  // The song panel keeps the song's own title and length.
  await expect(page.getByTestId('song-title')).toHaveText(TITLE);
  await expect(page.getByTestId('song-duration')).toHaveText('3:33');
  // The clock stands still at the last song position, not at the ad's time.
  const first = (await appState()).positionS;
  await page.waitForTimeout(500);
  expect((await appState()).positionS).toBe(first);
  expect(first).toBeGreaterThan(0.3);

  // Record cannot start over an ad.
  await page.getByTestId('record').click();
  await expect(page.getByTestId('status-text')).toContainText('An ad is playing in the video. Press Record again', {
    timeout: 8000,
  });
  expect((await appState()).recording).toBe(false);
  expect(await readTakes()).toHaveLength(1);

  // The ad ends and the song carries on from where it was.
  await fakeDo(0, 'endAd');
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing', undefined, { timeout: 3000 });
  await expect(page.getByTestId('status-text')).toHaveText('The ad ended.');
  await page.waitForTimeout(400);
  expect((await appState()).positionS).toBeGreaterThan(first);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('10. calibrating pauses the video for the chirps and picks it up afterwards', async () => {
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  const before = (await fakeHandle(0)).calls;

  // The song, a video here, would drown the chirps; the fake microphone never
  // hears them, so the run ends in the usual warning.
  await page.getByTestId('calibrate').click();
  await page.waitForFunction(() => window.encore!.store.state.calibrating === true);
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
  expect((await fakeHandle(0)).calls.slice(before.length)).toContain('pauseVideo');

  // The video can also be started with YouTube's own controls inside the
  // iframe, which skip the Play button (disabled for the run). It must not
  // run over the chirps either, so it is paused again at once.
  const duringRun = (await fakeHandle(0)).calls.length;
  await fakeDo(0, 'playVideo');
  await expect
    .poll(async () => (await fakeHandle(0)).calls.slice(duringRun + 1), { timeout: 5000 })
    .toContain('pauseVideo');
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
  expect((await appState()).calibrating).toBe(true);

  await page.waitForFunction(() => window.encore!.store.state.calibrating === false, undefined, {
    timeout: 30_000,
  });

  // The video was only paused for the run, so it carries on afterwards.
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  const calls = (await fakeHandle(0)).calls.slice(before.length);
  expect(calls.indexOf('pauseVideo')).toBeGreaterThanOrEqual(0);
  expect(calls.lastIndexOf('playVideo')).toBeGreaterThan(calls.indexOf('pauseVideo'));
  expect((await appState()).status.kind).toBe('warn');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('11. a blocked autoplay and the documented errors say what to do', async () => {
  await fakeDo(0, 'blockAutoplay');
  await expect(page.getByTestId('status-text')).toHaveText('Press Play to start the video.');
  expect((await appState()).status.kind).toBe('warn');

  // These are about the video in use, which is the song, so none of them says
  // a previous song is still loaded.
  const messages: Array<[number, string]> = [
    [100, 'That video is private or was removed.'],
    [153, 'YouTube refused the embed because no referrer reached it.'],
    [150, NOT_PLAYABLE],
  ];
  for (const [code, text] of messages) {
    await fakeDo(0, 'fireError', code);
    await expect(page.getByTestId('status-text')).toHaveText(text);
    expect((await appState()).status.kind).toBe('error');
  }
  // After an error Play says why instead of doing nothing.
  await page.evaluate(() => window.encore!.store.setStatus('Cleared.'));
  await page.getByTestId('play').click();
  await expect(page.getByTestId('status-text')).toHaveText(NOT_PLAYABLE);
});

test('12. dropping a file swaps back to the audio player and destroys the YouTube player', async () => {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => window.encore!.store.state.clock === 'engine' && window.encore!.store.state.player === 'ready');

  const state = await appState();
  expect(state.embed).toBeNull();
  expect(state.song?.name).toBe('song.wav');
  expect(state.song?.hash).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId('song-title')).toHaveText('song.wav');
  await expect(page.getByTestId('embed-region')).toBeHidden();
  await expect(page.getByTestId('embed-offset')).toBeHidden();
  await expect(page.getByTestId('embed-note')).toBeHidden();
  await expect(page.locator('#app')).toHaveAttribute('data-embed', 'off');
  expect(await page.locator('iframe').count()).toBe(0);
  expect((await fakeHandle(0)).destroyed).toBe(true);
  expect(
    await page.evaluate(() => window.encore!.session.transport === window.encore!.session.parts!.player),
  ).toBe(true);
  // The video's takes belong to the video; the file has none yet.
  await expect(page.getByTestId('take-item')).toHaveCount(0);

  // The audio player works as the transport again.
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.positionS > 0.5);
  expect((await appState()).player).toBe('playing');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  // A take on the file keeps the engine clock and takes no embed offset, though
  // one is still saved for the next video.
  expect((await appState()).embedOffsetS).toBe(0.04);
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true, undefined, { timeout: 10_000 });
  await page.waitForTimeout(1200);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(1);
  const fileTake = (await readTakes()).find((take) => !take.songHash.startsWith('yt-'))!;
  expect(fileTake.clock).toBe('engine');
  expect(fileTake.latencyS).toBe(0);
  await expect(page.getByTestId('take-note')).toHaveCount(0);
});

test('13. a link typed in the box loads with Load or Enter, a second link replaces the first, junk is refused', async () => {
  const input = page.getByTestId('link-input');

  await input.fill('definitely not a link');
  await page.getByTestId('link-load').click();
  await expect(page.getByTestId('status-text')).toHaveText('That does not look like a YouTube link.');
  expect((await appState()).clock).toBe('engine');

  // Pasting into another field is the singer's own business.
  await pasteText(LINK, '#latency-input');
  await page.waitForTimeout(300);
  expect((await appState()).embed).toBeNull();

  // A link with a start time, loaded with the button. The file stops meanwhile.
  await input.fill(`https://youtu.be/${OTHER_VIDEO}?t=1m30s`);
  await page.getByTestId('link-load').click();
  await page.waitForFunction(() => window.encore!.store.state.clock === 'embed' && window.encore!.store.state.player === 'ready');
  const second = await fakeHandle(1);
  expect(second.options.videoId).toBe(OTHER_VIDEO);
  expect(second.options.playerVars.start).toBe(90);
  await page.waitForFunction(() => Math.abs(window.encore!.store.state.positionS - 90) < 0.5);
  expect(await page.evaluate(() => window.encore!.session.parts!.player.state)).toBe('paused');
  expect((await appState()).song?.hash).toBe(`yt-${OTHER_VIDEO}`);

  // Pasting into the link box itself also loads, and replaces that video.
  await input.fill('');
  await pasteText(`https://youtu.be/${VIDEO}`, '#link-input');
  await page.waitForFunction(() => window.encore!.store.state.embed?.videoId === 'dQw4w9WgXcQ' && window.encore!.store.state.player === 'ready');
  expect((await fakeHandle(1)).destroyed).toBe(true);
  expect(await page.locator('#embed-player iframe').count()).toBe(1);

  // Enter in the box loads too.
  await input.fill(`https://music.youtube.com/watch?v=${OTHER_VIDEO}`);
  await input.press('Enter');
  await page.waitForFunction(() => window.encore!.store.state.embed?.videoId === 'aB3_x-Y9zQ0' && window.encore!.store.state.player === 'ready');
  expect((await fakeHandle(2)).destroyed).toBe(true);
  expect(await page.locator('#embed-player iframe').count()).toBe(1);

  // A link dragged in from another tab arrives as text, not as a file; a
  // uri-list may start with a comment line.
  await page.evaluate((link) => {
    const data = new DataTransfer();
    data.setData('text/uri-list', `# dragged from the address bar\r\n${link}`);
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, `https://youtu.be/${VIDEO}`);
  await page.waitForFunction(() => window.encore!.store.state.embed?.videoId === 'dQw4w9WgXcQ' && window.encore!.store.state.player === 'ready');
  expect((await fakeHandle(3)).destroyed).toBe(true);
  expect(await page.locator('#embed-player iframe').count()).toBe(1);

  // Dropped text that is not a link changes nothing.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'just some words');
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  expect((await appState()).embed).toEqual({ videoId: VIDEO });
});

test('14. a video that cannot be embedded fails the load, says the song in use is still loaded, and leaves it as it was', async () => {
  const blocked = `https://youtu.be/${BLOCKED_VIDEO}`;
  const message = `${NOT_PLAYABLE} ${SONG_KEPT}`;

  // A video is the song, with a take of its own on the list, and it is
  // playing when the other link fails. A red error beside a song that goes on
  // would read as if the song had gone, so the message has to say it has not.
  const before = await appState();
  expect(before.clock).toBe('embed');
  expect(before.song?.hash).toBe(`yt-${VIDEO}`);
  await expect(page.getByTestId('take-item')).toHaveCount(1);
  const inUse = (await playerCount()) - 1;
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  const playingFrom = (await appState()).positionS;
  await pasteText(blocked);
  await expect(page.getByTestId('status-text')).toHaveText(message);
  expect((await appState()).player).toBe('playing');
  // Past the fake's error delay and the settle time, the message still stands.
  await page.waitForTimeout(1300);
  await expect(page.getByTestId('status-text')).toHaveText(message);
  const kept = await appState();
  expect(kept.status.kind).toBe('error');
  expect(kept.clock).toBe('embed');
  expect(kept.embed).toEqual({ videoId: VIDEO });
  expect(kept.song).toEqual(before.song);
  // The video played on through the failure.
  expect(kept.player).toBe('playing');
  expect(kept.positionS).toBeGreaterThan(playingFrom + 1);
  await expect(page.getByTestId('embed-region')).toBeVisible();
  // The new player was closed; the one in use is still there and untouched.
  expect(await playerCount()).toBe(inUse + 2);
  expect((await fakeHandle(inUse + 1)).destroyed).toBe(true);
  expect((await fakeHandle(inUse)).destroyed).toBe(false);
  expect(await page.locator('#embed-player iframe').count()).toBe(1);
  // The takes are still the video's, and the video still plays and pauses.
  await expect(page.getByTestId('take-item')).toHaveCount(1);
  expect((await fakeHandle(inUse)).calls).toContain('playVideo');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  // The same with a file as the song: it stays, and the pane closes again.
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(
    () =>
      window.encore!.store.state.clock === 'engine' &&
      window.encore!.store.state.player === 'ready' &&
      window.encore!.store.state.song?.name === 'song.wav',
  );
  const built = await playerCount();
  await pasteText(blocked);
  await expect(page.getByTestId('status-text')).toHaveText(message);
  await page.waitForTimeout(1300);
  await expect(page.getByTestId('status-text')).toHaveText(message);
  const file = await appState();
  expect(file.status.kind).toBe('error');
  expect(file.embed).toBeNull();
  expect(file.clock).toBe('engine');
  expect(file.song?.name).toBe('song.wav');
  await expect(page.getByTestId('embed-region')).toBeHidden();
  await expect(page.locator('#app')).toHaveAttribute('data-embed', 'off');
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await playerCount()).toBe(built + 1);
  expect((await fakeHandle(built)).destroyed).toBe(true);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
});

test('15. a newer load wins over an older one that is still loading', async () => {
  // A link that is slow to become ready, then another one straight away: only
  // the second ever becomes the song, and the first player is closed.
  const first = await playerCount();
  await readyAfter(700);
  await pasteText(`https://youtu.be/${VIDEO}`);
  await readyAfter(30);
  await pasteText(`https://youtu.be/${OTHER_VIDEO}`);
  await songIsVideo(OTHER_VIDEO);
  // Past the slow one's delay, so a late answer from it would have shown.
  await page.waitForTimeout(900);
  const state = await appState();
  expect(state.song?.hash).toBe(`yt-${OTHER_VIDEO}`);
  expect(state.embed).toEqual({ videoId: OTHER_VIDEO });
  expect(await playerCount()).toBe(first + 2);
  expect((await fakeHandle(first)).destroyed).toBe(true);
  expect((await fakeHandle(first + 1)).destroyed).toBe(false);
  expect(await page.locator('#embed-player iframe').count()).toBe(1);

  // A file dropped while a link is still loading wins over it as well.
  const second = await playerCount();
  await readyAfter(700);
  await pasteText(`https://youtu.be/${VIDEO}`);
  await readyAfter(30);
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(
    () =>
      window.encore!.store.state.clock === 'engine' &&
      window.encore!.store.state.player === 'ready' &&
      window.encore!.store.state.song?.name === 'song.wav',
  );
  await page.waitForTimeout(900);
  const after = await appState();
  expect(after.clock).toBe('engine');
  expect(after.embed).toBeNull();
  expect(after.song?.name).toBe('song.wav');
  expect((await fakeHandle(second)).destroyed).toBe(true);
  expect(await page.locator('iframe').count()).toBe(0);
  await expect(page.getByTestId('embed-region')).toBeHidden();
});

test('16. a video loading behind the one in use never covers it, and replaces it only when ready', async () => {
  // A video is the song (the last test left a file).
  await readyAfter(30);
  await pasteText(`https://youtu.be/${VIDEO}`);
  await songIsVideo(VIDEO);
  const inUse = (await playerCount()) - 1;

  // From here on, note each song and clock the state shows, in order.
  await page.evaluate(() => {
    const tagOf = (state: { clock: string; song: { hash: string } | null }): string =>
      `${state.clock}:${state.song?.hash ?? 'none'}`;
    const seen: string[] = [tagOf(window.encore!.store.state)];
    (window as unknown as { __songs: string[] }).__songs = seen;
    window.encore!.store.subscribe((state) => {
      const tag = tagOf(state);
      if (seen[seen.length - 1] !== tag) seen.push(tag);
    });
  });

  // Another link, slow to become ready.
  await readyAfter(1500);
  await pasteText(`https://youtu.be/${OTHER_VIDEO}`);
  await page.waitForFunction((count) => {
    return (window as unknown as { __yt: { players: unknown[] } }).__yt.players.length === count;
  }, inUse + 2);
  await readyAfter(30);

  // The video in use is still the song, and in front of the one loading.
  const loading = await appState();
  expect(loading.clock).toBe('embed');
  expect(loading.song?.hash).toBe(`yt-${VIDEO}`);
  expect(loading.embed).toEqual({ videoId: VIDEO });
  const pane = await page.evaluate(() => {
    const slots = [...document.querySelectorAll<HTMLElement>('#embed-player > .embed-slot')];
    // Newest first, so the video in use is the last.
    const iframes = slots.map((slot) => slot.querySelector('iframe')!);
    const use = iframes[iframes.length - 1].getBoundingClientRect();
    const top = document.elementFromPoint(use.x + use.width / 2, use.y + use.height / 2);
    const same = iframes.every((frame) => {
      const r = frame.getBoundingClientRect();
      return r.x === use.x && r.y === use.y && r.width === use.width && r.height === use.height;
    });
    return {
      slots: slots.length,
      inert: slots.map((slot) => slot.inert),
      topIsInUse: top === iframes[iframes.length - 1],
      same,
    };
  });
  expect(pane.slots).toBe(2);
  expect(pane.inert).toEqual([true, false]);
  expect(pane.same).toBe(true);
  expect(pane.topIsInUse).toBe(true);

  // It still plays while the other one loads.
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  expect((await fakeHandle(inUse)).calls).toContain('playVideo');

  // Ready: the new video takes over, and the old one is paused and closed.
  await songIsVideo(OTHER_VIDEO);
  const done = await appState();
  expect(done.clock).toBe('embed');
  expect(done.song?.hash).toBe(`yt-${OTHER_VIDEO}`);
  await expect(page.getByTestId('status-text')).toContainText('from YouTube');
  const old = await fakeHandle(inUse);
  expect(old.destroyed).toBe(true);
  expect(old.calls).toEqual(['playVideo', 'pauseVideo', 'destroy']);
  const fresh = await fakeHandle(inUse + 1);
  expect(fresh.destroyed).toBe(false);
  expect(fresh.calls).toEqual([]);
  expect(await page.locator('#embed-player iframe').count()).toBe(1);
  expect(await page.locator('#embed-player > .embed-slot').evaluate((slot) => (slot as HTMLElement).inert)).toBe(false);
  // The song went straight from one video to the other, never back to a file.
  expect(await page.evaluate(() => (window as unknown as { __songs: string[] }).__songs)).toEqual([
    `embed:yt-${VIDEO}`,
    `embed:yt-${OTHER_VIDEO}`,
  ]);
});

test('17. with nothing loaded, a video that cannot be embedded says only why', async () => {
  // A fresh page has no song to keep, so nothing is added to the message.
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  expect((await appState()).player).toBe('empty');

  await pasteText(`https://youtu.be/${BLOCKED_VIDEO}`);
  await expect(page.getByTestId('status-text')).toHaveText(NOT_PLAYABLE);
  await page.waitForTimeout(1300);
  await expect(page.getByTestId('status-text')).toHaveText(NOT_PLAYABLE);
  const state = await appState();
  expect(state.status.kind).toBe('error');
  expect(state.player).toBe('empty');
  expect(state.embed).toBeNull();
  await expect(page.getByTestId('embed-region')).toBeHidden();
  expect(await page.locator('iframe').count()).toBe(0);
});
