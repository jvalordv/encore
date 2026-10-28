/**
 * End-to-end proof of learning mode in real Chromium against the production
 * bundle, with the service replaced by e2e/fake-service.ts (which serves the
 * stems and a two-note melody) and Chromium's fake microphone singing a steady
 * 440 Hz. Covered: in karaoke mode, the default, a recorded take shows no
 * report card, no Report button and no tips, and nothing was measured; after
 * the header toggle is set to Learning (and kept in settings), a take recorded
 * over the melody opens a report card with the in-tune share and the worst
 * phrases, its Tips button gives at most three tips, and switching back to
 * karaoke hides the card; on a karaoke track (the service found no singer) the
 * notice appears before the singer starts, word for word, with a Find the
 * original button that searches for the original, a take there gets no card,
 * and karaoke mode does not show the notice. Then the two scoring styles: the
 * Strict / Open selector shows only in learning mode and survives a reload; an
 * Open take over the melody opens a card with the share on the melody and a
 * freestyle line (the key comes from the stand-in's /key route), and a
 * Shift+click on a phrase marks and unmarks it free; and on a
 * karaoke track Strict offers Switch to Open, which switches the style, changes
 * the notice to a line about the song's key and lets a take there be scored.
 * The tests share one page and run in order, each starting from a reload.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { fileStatus, skippedStep, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { readAppState } from './fake-youtube';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

const VIDEO = 'dQw4w9WgXcQ';
const SONG_ID = 'file-fake';
const NOTICE =
  "Learning mode compares your singing with the original singer's. This is a karaoke track, " +
  "so there is no singer in it to compare against: you're on your own for this one.";

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

const appState = (): Promise<AppState> => readAppState(page);

/** Starts the page afresh against a service that is up with a finished song. */
async function freshPage(): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  service.reset(VIDEO);
  service.upload = fileStatus(SONG_ID, { separation: stepStatus('done', 1), reference: stepStatus('done', 1) });
}

/** Drops the song and waits for the karaoke track and the melody's verdict. */
async function dropAndWait(): Promise<void> {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => {
    const s = window.encore!.store.state;
    return s.song?.name === 'song.wav' && s.mix.available && s.reference.phase !== 'none';
  }, undefined, { timeout: 15_000 });
}

/** Opens the fake microphone. */
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

/**
 * Records from the start until the song has reached `untilS`, then saves the
 * take. Takes outlive a reload (they are in IndexedDB), so it waits for one
 * more than there were. Returns how many takes there are now.
 */
async function recordUntil(untilS: number): Promise<number> {
  const before = (await appState()).takes.length;
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording);
  await page.waitForFunction((s) => window.encore!.store.state.positionS > s, untilS);
  await page.getByTestId('record').click();
  await page.waitForFunction(
    (n) => !window.encore!.store.state.recording && window.encore!.store.state.takes.length === n,
    before + 1,
  );
  return before + 1;
}

test('1. karaoke mode, the default, shows no report card and no tips after a take', async () => {
  await freshPage();
  await expect(page.getByTestId('mode-karaoke')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mode-learning')).toHaveAttribute('aria-pressed', 'false');
  await dropAndWait();
  await openFakeMic();
  await recordUntil(3.7);

  await expect(page.getByTestId('take-item')).toHaveCount(1);
  await expect(page.getByTestId('report')).toBeHidden();
  await expect(page.getByTestId('report-card')).toHaveCount(0);
  await expect(page.getByTestId('take-report')).toHaveCount(0);
  await expect(page.getByTestId('tips')).toHaveCount(0);
  await expect(page.getByTestId('learning-notice')).toHaveCount(0);
  const state = await appState();
  expect(state.mode).toBe('karaoke');
  expect(state.takes[0].report).toBeUndefined();
  expect(state.reportTakeId).toBeNull();
});

test('2. learning mode: a take over the melody opens a report card, with tips on request', async () => {
  await freshPage();
  await page.getByTestId('mode-learning').click();
  await expect(page.getByTestId('mode-learning')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').mode)).toBe('learning');
  await dropAndWait();
  expect((await appState()).reference.phase).toBe('ready');
  await openFakeMic();
  await recordUntil(3.7);

  const card = page.getByTestId('report-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('report-headline')).toContainText('In tune:');
  await expect(page.getByTestId('report-timing')).toContainText('Timing:');
  await expect(page.getByTestId('take-report')).toHaveCount(1);
  // Tips come only when asked for, at most three.
  await expect(page.getByTestId('tips')).toHaveCount(0);
  await page.getByTestId('report-tips').click();
  const shown = (await page.getByTestId('tip').count()) + (await page.getByTestId('tips-none').count());
  expect(shown).toBeGreaterThanOrEqual(1);
  expect(await page.getByTestId('tip').count()).toBeLessThanOrEqual(3);

  const state = await appState();
  expect(state.takes[0].report).toBeDefined();
  expect(state.reportTakeId).toBe(state.takes[0].id);

  // Karaoke mode hides the card and the button, though the take keeps its report.
  await page.getByTestId('mode-karaoke').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('take-report')).toHaveCount(0);
  expect((await appState()).takes[0].report).toBeDefined();
});

test('3. a karaoke track says so before the take, offers the original, and gets no card', async () => {
  await freshPage();
  service.upload = fileStatus(SONG_ID, {
    separation: stepStatus('done', 1),
    reference: skippedStep('No singing found: the vocal is audible in only 3% of this track.'),
  });
  service.reference = 409;
  // Settings were kept by the last test: learning mode starts unless it is off.
  await page.getByTestId('mode-learning').click();
  await dropAndWait();
  expect((await appState()).reference.phase).toBe('skipped');

  const notice = page.getByTestId('learning-notice-text');
  await expect(notice).toHaveText(NOTICE);

  // Find the original searches for it as Originals (no key here, so the
  // search goes to YouTube's own page; the new tab is replaced by a note).
  await page.evaluate(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = (url) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    };
  });
  await page.getByTestId('find-original').click();
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened).toHaveLength(1);
  expect(decodeURIComponent(opened[0])).toContain('youtube.com/results');
  const searched = await appState();
  expect(searched.search.filter).toBe('original');
  expect(searched.search.originalOf).toBe('song');

  // Karaoke mode says nothing of it.
  await page.getByTestId('mode-karaoke').click();
  await expect(page.getByTestId('learning-notice')).toHaveCount(0);
  await page.getByTestId('mode-learning').click();
  await expect(notice).toHaveText(NOTICE);

  // A take on a karaoke track is not scored.
  await openFakeMic();
  const count = await recordUntil(1.5);
  await expect(page.getByTestId('take-item')).toHaveCount(count);
  await expect(page.getByTestId('report-card')).toHaveCount(0);
  // The earlier take, from test 2, still has its Report button; the new one has none.
  await expect(page.getByTestId('take-item').first().getByTestId('take-report')).toHaveCount(0);
  expect((await appState()).takes[0].report).toBeUndefined();
});

/** A finished song with its key and melody, as the service reports it. */
const KEYED_SONG = (): ReturnType<typeof fileStatus> =>
  fileStatus(SONG_ID, {
    separation: stepStatus('done', 1),
    key: stepStatus('done', 1),
    reference: stepStatus('done', 1),
  });

test('4. the Strict / Open selector shows only in learning mode, and survives a reload', async () => {
  await freshPage();
  const choices = page.getByTestId('scoring-choices');
  const hint = page.getByTestId('free-hint');

  await page.getByTestId('mode-karaoke').click();
  await expect(choices).toBeHidden();
  await expect(hint).toBeHidden();

  await page.getByTestId('mode-learning').click();
  await expect(choices).toBeVisible();
  await expect(hint).toContainText('Shift+click');
  await expect(page.getByTestId('scoring-strict')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('scoring-open')).toHaveAttribute('aria-pressed', 'false');

  await page.getByTestId('scoring-open').click();
  await expect(page.getByTestId('scoring-open')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').scoring)).toBe('open');

  await freshPage();
  await expect(page.getByTestId('mode-learning')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('scoring-open')).toHaveAttribute('aria-pressed', 'true');
  expect((await appState()).scoring).toBe('open');

  await page.getByTestId('scoring-strict').click();
  await expect(page.getByTestId('scoring-strict')).toHaveAttribute('aria-pressed', 'true');
});

test('5. an Open take over the fixture opens a card with the share on the melody and a freestyle line', async () => {
  await freshPage();
  service.upload = KEYED_SONG();
  await page.getByTestId('mode-learning').click();
  await page.getByTestId('scoring-open').click();
  await dropAndWait();
  // The key came from the stand-in's /key route, independently of the melody.
  await page.waitForFunction(() => window.encore!.store.state.key.phase === 'ready');
  expect(service.count('GET', `/songs/${SONG_ID}/key`)).toBe(1);

  // A Shift+click on the phrase marks it free and a second one unmarks it; a
  // plain click is left for turns. The playhead is at 0, so the lane shows the
  // song from 4.5 s before it to 1.5 s after, and 1 s is inside the phrase.
  const lane = page.locator('#lane-canvas');
  const box = await lane.boundingBox();
  if (!box) throw new Error('the lane has no box');
  const gutter = Math.min(56, box.width / 3);
  const onPhrase = { x: gutter + ((1 + 4.5) / 6) * (box.width - gutter), y: box.height / 2 };
  await lane.click({ position: onPhrase });
  expect((await appState()).freePhrases).toEqual([]);
  await lane.click({ position: onPhrase, modifiers: ['Shift'] });
  await page.waitForFunction(() => window.encore!.store.state.freePhrases.length === 1);
  expect((await appState()).freePhrases).toEqual([[0.5, 3.5]]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('encore.free.')).length)).toBe(1);
  await lane.click({ position: onPhrase, modifiers: ['Shift'] });
  await page.waitForFunction(() => window.encore!.store.state.freePhrases.length === 0);

  await openFakeMic();
  await recordUntil(3.7);

  await expect(page.getByTestId('report-card')).toBeVisible();
  await expect(page.getByTestId('report-card')).toHaveAttribute('data-style', 'open');
  // The fake microphone's steady A4 is the first melody note an octave up, which Open accepts.
  await expect(page.getByTestId('report-melody-share')).toContainText('On the melody:');
  await expect(page.getByTestId('report-freestyle')).toBeVisible();
  const report = (await appState()).takes[0].report;
  expect(report?.style).toBe('open');
  expect(report?.melodyShare).toBe(1);
  expect(report?.freestyle?.keyStatus).toBe('clear');

  // Karaoke mode hides it all again, the style included.
  await page.getByTestId('mode-karaoke').click();
  await expect(page.getByTestId('report-card')).toHaveCount(0);
  await expect(page.getByTestId('scoring-choices')).toBeHidden();
  await page.getByTestId('mode-learning').click();
  await page.getByTestId('scoring-strict').click();
});

test('6. a karaoke track offers Switch to Open, which switches the style and changes the notice', async () => {
  await freshPage();
  service.upload = fileStatus(SONG_ID, {
    separation: stepStatus('done', 1),
    key: stepStatus('done', 1),
    reference: skippedStep('No singing found: the vocal is audible in only 3% of this track.'),
  });
  service.reference = 409;
  await page.getByTestId('mode-learning').click();
  await page.getByTestId('scoring-strict').click();
  await dropAndWait();
  await page.waitForFunction(() => window.encore!.store.state.key.phase === 'ready');

  // Strict: W3's sentence, word for word, and the offer beside it.
  await expect(page.getByTestId('learning-notice-text')).toHaveText(NOTICE);
  await expect(page.getByTestId('learning-notice-offer')).toHaveText(
    "Switch to Open to be scored on the song's key instead.",
  );
  await expect(page.getByTestId('find-original')).toBeVisible();

  await page.getByTestId('switch-to-open').click();
  expect((await appState()).scoring).toBe('open');
  await expect(page.getByTestId('scoring-open')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('learning-notice-text')).toContainText("scored on the song's key");
  await expect(page.getByTestId('learning-notice-text')).not.toHaveText(NOTICE);
  await expect(page.getByTestId('learning-notice-offer')).toHaveCount(0);
  await expect(page.getByTestId('switch-to-open')).toHaveCount(0);
  await expect(page.getByTestId('find-original')).toBeVisible();

  // Open scores the track on its key, so a take there gets a card.
  await openFakeMic();
  await recordUntil(1.5);
  await expect(page.getByTestId('report-card')).toBeVisible();
  await expect(page.getByTestId('report-headline')).toContainText('no melody to follow');
  await expect(page.getByTestId('report-freestyle')).toContainText("in the song's key");

  await page.getByTestId('scoring-strict').click();
  await expect(page.getByTestId('learning-notice-text')).toHaveText(NOTICE);
});
