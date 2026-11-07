/**
 * End-to-end proof of two singers in real Chromium against the production
 * bundle, with the service replaced by e2e/fake-service.ts. Chromium's fake
 * capture plays one file for every device, so singer B's mic is the page's own
 * 330 Hz tone through the `?secondFake` seam (src/duet/second-mic.ts), beside
 * singer A's 440 Hz fake microphone. Covered: two mics in learning mode, each
 * with its own meter, a take that gives one report card per singer, titled by
 * name and measured on what that mic sang (A near 69, B near 64); one mic
 * taking turns, where the melody's two phrases go A then B, a real click on a
 * phrase cycles it to B, both and back, the choice outlives a reload, and a
 * take gives each singer a card with the phrase both sang marked shared; and
 * the Hands-Free warning beside a Bluetooth headset's mic in both pickers.
 * The tests share one page and run in order.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { gutterWidth } from '../src/render/lane-geometry';
import { fileStatus, REFERENCE_FIXTURE, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { readAppState } from './fake-youtube';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const SONG_ID = 'file-fake';

/** Two phrases with a 1 s rest between: 0.5 to 1.5 s and 2.5 to 3.5 s. */
const TWO_PHRASES = (() => {
  const f0_hz = Array.from({ length: 400 }, (_, i) => {
    const t = i * 0.01;
    if (t >= 0.5 && t < 1.5) return 220;
    return t >= 2.5 && t < 3.5 ? 329.63 : 0;
  });
  return {
    ...REFERENCE_FIXTURE,
    contour: { hop_s: 0.01, t0_s: 0, f0_hz, confidence: f0_hz.map((hz) => (hz > 0 ? 0.95 : 0)) },
    notes: [
      { onset_s: 0.5, offset_s: 1.5, midi: 57, cents_mean: 0, cents_std: 4, scoop_cents: 0 },
      { onset_s: 2.5, offset_s: 3.5, midi: 64, cents_mean: 0, cents_std: 4, scoop_cents: 0 },
    ],
    unpitched_regions: [],
  };
})();

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

const appState = (): Promise<AppState> => readAppState(page);

/** Starts the page afresh in learning mode with the second-mic seam, settings cleared. */
async function freshPage(reference: unknown = REFERENCE_FIXTURE): Promise<void> {
  await page.goto('/?secondFake');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  service.reset(VIDEO);
  service.upload = fileStatus(SONG_ID, { separation: stepStatus('done', 1), reference: stepStatus('done', 1) });
  service.reference = reference as typeof REFERENCE_FIXTURE;
  await page.getByTestId('mode-learning').click();
}

/** Drops the song and waits for the karaoke track and the melody. */
async function dropAndWait(): Promise<void> {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.song?.name === 'song.wav' && s.mix.available && s.reference.phase === 'ready';
    },
    undefined,
    { timeout: 15_000 },
  );
}

/** Opens the fake microphone (singer A's). */
async function openFakeMic(): Promise<void> {
  const options = await page.$$eval('#input-select option', (list) =>
    (list as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? '' })),
  );
  const fake = options.find((o) => !o.value.startsWith('@') && /fake/i.test(o.text));
  await page.selectOption('#input-select', fake ? fake.value : '@default');
  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.tracker === 'running' && s.framesPerSecond > 50;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Records from the start until the song has reached `untilS`, then saves the take. */
async function recordUntil(untilS: number): Promise<void> {
  const before = (await appState()).takes.length;
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording);
  await page.waitForFunction((s) => window.encore!.store.state.positionS > s, untilS);
  await page.getByTestId('record').click();
  await page.waitForFunction(
    (n) => !window.encore!.store.state.recording && window.encore!.store.state.takes.length === n,
    before + 1,
  );
}

test('1. two mics: each singer has a meter and a report card, measured on their own mic', async () => {
  await freshPage();
  await dropAndWait();
  await openFakeMic();
  await page.getByTestId('singer-a-name').fill('Ann');
  await page.getByTestId('singer-a-name').press('Tab');
  await page.getByTestId('singer-b-on').check();
  await page.getByTestId('singer-b-name').fill('Bo');
  await page.getByTestId('singer-b-name').press('Tab');
  // The picker says "System default"; the seam makes that the 330 Hz tone.
  await page.getByTestId('singer-b-input').selectOption('@default');
  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.singers[1]?.input.open && s.duet.kind === 'two-mics';
    },
    undefined,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('singer-b-state')).toHaveText('Hearing you');
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').duet);
  expect(settings).toMatchObject({ secondSinger: true, names: ['Ann', 'Bo'] });

  await recordUntil(3.7);
  const cards = page.getByTestId('report-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).getByTestId('report-title')).toHaveText('Take report: Ann');
  await expect(cards.nth(1).getByTestId('report-title')).toHaveText('Take report: Bo');
  await expect(cards.nth(1)).toHaveAttribute('data-singer', '1');

  const [take] = (await appState()).takes;
  expect(take.duet?.mode).toBe('two-mics');
  // A sang 440 Hz (MIDI 69), B 330 Hz (MIDI 64): each report is of its own mic.
  expect(take.report?.sungRange?.highMidi).toBeGreaterThan(68);
  expect(take.duet?.reportB.sungRange?.highMidi).toBeGreaterThan(63);
  expect(take.duet?.reportB.sungRange?.highMidi).toBeLessThan(65);
  // Tips are per card: asking on B's card shows tips under B's alone.
  await cards.nth(1).getByTestId('report-tips').click();
  await expect(page.getByTestId('report-card').nth(1).getByTestId('report-tips')).toBeDisabled();
  await expect(page.getByTestId('report-card').nth(0).getByTestId('report-tips')).toBeEnabled();
});

test('2. one mic: turns go A then B, a click on the lane cycles a phrase, and each singer gets a card', async () => {
  await freshPage(TWO_PHRASES);
  await dropAndWait();
  await openFakeMic();
  await page.getByTestId('singer-b-on').check();
  await page.waitForFunction(() => window.encore!.store.state.duet.turns.length === 2);
  let duet = (await appState()).duet;
  expect(duet.kind).toBe('one-mic');
  expect(duet.turnSource).toBe('phrases');
  expect(duet.turns.map((t) => t.who)).toEqual(['a', 'b']);

  // Look at the second phrase, then click it on the lane: B's turn becomes both.
  await page.evaluate(() => window.encore!.session.seek(3));
  await page.waitForFunction(() => Math.abs(window.encore!.store.state.positionS - 3) < 0.2);
  const canvas = page.getByTestId('lane-canvas');
  const box = (await canvas.boundingBox())!;
  const gutter = gutterWidth(box.width);
  // At song time 3 the lane shows 4.5 s before the playhead and 1.5 s after it.
  const xAt = (t: number): number => box.x + gutter + ((t - (3 - 4.5)) / 6) * (box.width - gutter);
  await page.mouse.click(xAt(3), box.y + box.height / 2);
  await page.waitForFunction(() => window.encore!.store.state.duet.turns[1]?.who === 'both');
  // A click in the rest between the phrases changes nothing.
  await page.mouse.click(xAt(2), box.y + box.height / 2);
  expect((await appState()).duet.turns.map((t) => t.who)).toEqual(['a', 'both']);
  // The choice is kept for the song.
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => window.encore!.store.state.duet.turns.length === 2, undefined, { timeout: 15_000 });
  expect((await appState()).duet.turns.map((t) => t.who)).toEqual(['a', 'both']);

  await openFakeMic();
  await page.evaluate(() => window.encore!.session.seek(0));
  await recordUntil(3.8);
  const cards = page.getByTestId('report-card');
  await expect(cards).toHaveCount(2);
  const [take] = (await appState()).takes;
  expect(take.duet?.mode).toBe('one-mic');
  expect(take.duet?.shared).toEqual([[2.5, 3.5]]);
  // A has both phrases, B only the one they share; the shared phrase is marked.
  expect(take.report?.notes.map((n) => n.index)).toEqual([0, 1]);
  expect(take.duet?.reportB.notes.map((n) => n.index)).toEqual([1]);
  await expect(cards.nth(0).locator('[data-shared="true"]')).toHaveCount(1);
  await expect(cards.nth(1).locator('[data-shared="true"]')).toHaveCount(1);
});

test('3. karaoke mode: the strip names whose turn it is and judges no one', async () => {
  await freshPage(TWO_PHRASES);
  await page.getByTestId('mode-karaoke').click();
  await dropAndWait();
  await page.getByTestId('singer-b-on').check();
  await page.waitForFunction(() => window.encore!.store.state.duet.turns.length === 2);
  await openFakeMic();
  await recordUntil(3.8);
  const [take] = (await appState()).takes;
  expect(take.report).toBeUndefined();
  expect(take.duet).toBeUndefined();
  await expect(page.getByTestId('report-card')).toHaveCount(0);
});

test('4. a Bluetooth Hands-Free mic is warned about in both pickers', async () => {
  await freshPage();
  await page.evaluate(() => {
    const devices = navigator.mediaDevices;
    const real = devices.enumerateDevices.bind(devices);
    devices.enumerateDevices = async () => [
      ...(await real()),
      {
        kind: 'audioinput',
        deviceId: 'bt-headset',
        groupId: 'bt',
        label: 'Headset (Test Buds Hands-Free AG Audio)',
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ];
    // The headset is not really there: opening it fails at once, which is all
    // the pickers' warning needs.
    devices.getUserMedia = () => Promise.reject(new DOMException('gone', 'NotFoundError'));
    devices.dispatchEvent(new Event('devicechange'));
  });
  await page.getByTestId('singer-b-on').check();
  await expect(page.locator('#input-select option[value="bt-headset"]')).toHaveCount(1);
  await expect(page.getByTestId('input-hands-free')).toBeHidden();
  await expect(page.getByTestId('singer-b-hands-free')).toBeHidden();
  await page.selectOption('#input-select', 'bt-headset');
  await expect(page.getByTestId('input-hands-free')).toBeVisible();
  await expect(page.getByTestId('input-hands-free')).toContainText('call quality');
  await page.getByTestId('singer-b-input').selectOption('bt-headset');
  await expect(page.getByTestId('singer-b-hands-free')).toBeVisible();
  await page.selectOption('#input-select', '@default');
  await expect(page.getByTestId('input-hands-free')).toBeHidden();
});
