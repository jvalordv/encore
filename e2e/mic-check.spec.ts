/**
 * End-to-end proof of the Mic check in real Chromium against the production
 * bundle, with Chromium's fake microphone and the service replaced by the
 * stand-in in e2e/fake-service.ts. The page is opened with `?micCheckScale=0.2`
 * (the test seam in src/app/session/mic-check.ts), so the four steps take
 * eight seconds instead of forty. Covered: the check runs its steps with the
 * prompts in plain words, borrows the player for its track and gives the song
 * back, posts a version 3 take marked `mic-check` with its labelled sections
 * and tuning, shows the advice, applies it to this device pair and the
 * latency, resets it; a YouTube video that is the song is paused for the run
 * and comes back paused where it was; and with the service away, the steps still run and the
 * card says the advice needs the service and offers the recording.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { callFake, FAKE_IFRAME_API, pasteInto, readFakeHandle, stubOembed } from './fake-youtube';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
    permissions: ['microphone'],
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await context.route(/(youtube|youtube-nocookie|ytimg|googlevideo|doubleclick|googleadservices)\.com/, (route) =>
    route.abort(),
  );
  await stubOembed(context);
  await context.route('https://www.youtube.com/iframe_api', (route) => {
    const config = JSON.stringify({ title: 'Test video', durationS: 213, readyDelayMs: 30, blockedIds: [] });
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: FAKE_IFRAME_API.replace('__CONFIG__', config),
    });
  });
  await context.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fake player</title>' }),
  );
  service = await stubService(context, 'dQw4w9WgXcQ');
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });
  await page.goto('/?micCheckScale=0.2');
  await page.waitForFunction(() => window.encore !== undefined);
});

test.afterEach(() => {
  expect(pageErrors, 'page errors').toEqual([]);
});

test.afterAll(async () => {
  await context.close();
});

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

const open = () => page.getByTestId('mic-check');
const panel = () => page.getByTestId('mic-check-panel');

test('1. the check runs its steps, gives the song back and shows the advice', async () => {
  await openFakeMic();
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => {
    const s = window.encore!.store.state;
    return s.song?.name === 'song.wav' && s.player === 'ready';
  });

  await expect(panel()).toBeHidden();
  await open().click();
  await expect(panel()).toBeVisible();
  await expect(page.getByTestId('mic-check-range-low')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('mic-check-range-high').click();
  await expect(page.getByTestId('mic-check-range-high')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('mic-check-start').click();

  await expect(page.getByTestId('mic-check-prompt')).toHaveText('Stay quiet');
  await expect(page.getByTestId('mic-check-countdown')).toBeVisible();
  await expect(page.getByTestId('mic-check-prompt')).toHaveText('Stay silent while the melody plays');
  await expect(page.getByTestId('mic-check-prompt')).toHaveText('Sing along with the melody');
  await expect(page.getByTestId('mic-check-prompt')).toHaveText('Keep singing, the melody has stopped');

  await expect(page.getByTestId('mic-check-title')).toBeVisible({ timeout: 30_000 });
  const state = await page.evaluate(() => window.encore!.store.state);
  expect(state.micCheck.phase).toBe('result');
  // The song that was loaded is back, untouched and paused at the start.
  expect(state.song?.name).toBe('song.wav');
  expect(state.player).toBe('ready');
  expect(state.recording).toBe(false);

  // The service got a version 3 take that says what it is.
  expect(service.count('POST', '/takes/analyse')).toBe(1);
  const take = service.analysedTake as {
    version: number;
    take: { kind: string };
    trace: { sections: Array<{ label: string; kind: string; startS: number; endS: number }>; environment: { tuning: unknown } };
  };
  expect(take.version).toBe(3);
  expect(take.take.kind).toBe('mic-check');
  expect(take.trace.sections.map((s) => s.label)).toEqual(['quiet', 'speakers', 'sing-along', 'sing-alone']);
  expect(take.trace.sections[0]!.startS).toBe(0);
  expect(take.trace.environment.tuning).toMatchObject({ drawMarginDb: 8, clarityThreshold: 0.9 });

  await expect(page.getByTestId('mic-check-findings')).toContainText('Your room is quiet.');
  await expect(page.getByTestId('mic-check-table')).toContainText('8.0 dB → 11.0 dB');
  await expect(page.getByTestId('mic-check-table')).toContainText('not set → 120 ms');
});

test('2. Use these settings writes the tuning and the latency; Reset returns the defaults', async () => {
  await page.getByTestId('mic-check-apply').click();
  await expect(page.getByTestId('mic-check-apply')).toHaveText('Settings in use');
  const applied = await page.evaluate(() => ({
    tuning: window.encore!.session.micTuning,
    latencyS: window.encore!.store.state.latencyS,
    stored: Object.keys(window.encore!.session.settings.micTuningByDevicePair).length,
  }));
  expect(applied.tuning).toMatchObject({ drawMarginDb: 11, clarityThreshold: 0.85, bleedMatchCents: 30 });
  expect(applied.latencyS).toBeCloseTo(0.12, 5);
  expect(applied.stored).toBe(1);

  await page.getByTestId('mic-check-reset').click();
  const reset = await page.evaluate(() => ({
    tuning: window.encore!.session.micTuning,
    stored: Object.keys(window.encore!.session.settings.micTuningByDevicePair).length,
  }));
  expect(reset.tuning).toMatchObject({ drawMarginDb: 8, clarityThreshold: 0.9 });
  expect(reset.stored).toBe(0);

  await page.getByTestId('mic-check-close').click();
  await expect(panel()).toBeHidden();
});

test('3. with the service away the steps still run and the recording is offered', async () => {
  service.up = false;
  const errorsBefore = pageErrors.length;
  await open().click();
  await page.getByTestId('mic-check-start').click();
  await expect(page.getByTestId('mic-check-message')).toContainText('needs the service', { timeout: 30_000 });
  await expect(page.getByTestId('mic-check-save-wav')).toBeVisible();
  await expect(page.getByTestId('mic-check-save-json')).toBeVisible();
  const state = await page.evaluate(() => window.encore!.store.state);
  expect(state.micCheck.phase).toBe('failed');
  expect(state.micCheck.takeId).not.toBeNull();
  expect(state.song?.name).toBe('song.wav');
  service.up = true;
  // The browser logs the refused connection itself; nothing else may appear.
  for (const entry of pageErrors.splice(errorsBefore)) expect(entry).toMatch(/Failed to load resource/);
  await page.getByTestId('mic-check-close').click();
});

test('4. Cancel stops the check, drops the recording and restores the song', async () => {
  await open().click();
  await page.getByTestId('mic-check-start').click();
  await expect(page.getByTestId('mic-check-cancel')).toBeVisible();
  await page.getByTestId('mic-check-cancel').click();
  await expect(page.getByTestId('mic-check-message')).toHaveText('Mic check cancelled.');
  const state = await page.evaluate(() => window.encore!.store.state);
  expect(state.micCheck.phase).toBe('cancelled');
  expect(state.micCheck.takeId).toBeNull();
  expect(state.song?.name).toBe('song.wav');
  expect(state.recording).toBe(false);
  await page.getByTestId('mic-check-close').click();
});

test('5. a video that is the song is paused for the check and comes back paused where it was', async () => {
  await pasteInto(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.waitForFunction(
    () => window.encore!.store.state.player === 'ready' && window.encore!.store.state.clock === 'embed',
  );
  await callFake(page, 0, 'seekTo', 30, 1);
  await callFake(page, 0, 'playVideo');
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await open().click();
  await page.getByTestId('mic-check-start').click();
  await expect(page.getByTestId('mic-check-prompt')).toHaveText('Stay quiet');
  // The check runs on the audio player; the video is not the clock now.
  const during = await page.evaluate(() => window.encore!.store.state);
  expect(during.clock).toBe('engine');
  expect((await readFakeHandle(page, 0)).calls).toContain('pauseVideo');
  await expect(page.getByTestId('mic-check-title')).toBeVisible({ timeout: 30_000 });
  const after = await page.evaluate(() => window.encore!.store.state);
  expect(after.clock).toBe('embed');
  expect(after.embed).toEqual({ videoId: 'dQw4w9WgXcQ' });
  expect(after.player).toBe('paused');
  expect(after.positionS).toBeGreaterThan(29);
  expect(after.positionS).toBeLessThan(40);
  await page.getByTestId('mic-check-close').click();
});
