/**
 * End-to-end proof of range and key (W6b) in real Chromium against the
 * production bundle, with the Python service replaced by the stand-in: a
 * dropped song with a melody gets the Key control; pressing + twice moves the
 * melody the lane is given up two semitones (read off the control's data
 * attributes and the state, not pixels) and puts the pitch shifter in the
 * engine's graph with its delay stated; the choice survives a reload for the
 * song; Reset takes the shifter out again.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { fileStatus, stepStatus, stubService } from './fake-service';
import type { FakeService } from './fake-service';
import { PORT, SONG_FILE } from './fixtures';

const SONG_ID = 'file-fake';

let context: BrowserContext;
let page: Page;
let service: FakeService;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  service = await stubService(context, 'dQw4w9WgXcQ');
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });
});

test.afterAll(async () => {
  await context.close();
});

/** Loads the song and waits for its melody to be on the lane. */
async function loadWithMelody(): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.encore !== undefined);
  const done = fileStatus(SONG_ID, { separation: stepStatus('done', 1), reference: stepStatus('done', 1) });
  service.upload = done;
  service.status = done;
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await expect(page.getByTestId('reference-status')).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 });
}

const shiftBox = () => page.getByTestId('key-shift');

test('+ twice moves the melody up two semitones and puts the shifter in the graph', async () => {
  await loadWithMelody();
  // The melody's first note is A3 (57), unshifted, with no shifter in the path.
  await expect(shiftBox()).toHaveAttribute('data-first-note', '57');
  await expect(shiftBox()).toHaveAttribute('data-shift', '0');
  expect(await page.evaluate(() => window.encore!.session.parts!.player.shifterInGraph)).toBe(false);

  await page.getByTestId('key-up').click();
  await page.getByTestId('key-up').click();
  await expect(page.getByTestId('key-readout')).toHaveText('+2');
  await expect(shiftBox()).toHaveAttribute('data-first-note', '59');
  const state = await page.evaluate(() => {
    const { session, store } = window.encore!;
    const player = session.parts!.player;
    return {
      shift: store.state.keyShift.shift,
      playerShift: player.shift,
      inGraph: player.shifterInGraph,
      delayS: player.shiftDelayS,
      exported: session.melodyForExport()?.notes.map((n) => n.midi),
    };
  });
  expect(state.shift).toBe(2);
  expect(state.playerShift).toBe(2);
  expect(state.inGraph).toBe(true);
  expect(state.delayS).toBeGreaterThan(0.03);
  expect(state.delayS).toBeLessThan(0.06);
  // The MIDI export moves with it.
  expect(state.exported).toEqual([59, 66]);
});

test('the shift is kept for the song across a reload, and Reset takes the shifter out', async () => {
  await loadWithMelody();
  await expect(shiftBox()).toHaveAttribute('data-shift', '2');
  await expect(shiftBox()).toHaveAttribute('data-first-note', '59');
  expect(await page.evaluate(() => window.encore!.session.parts!.player.shifterInGraph)).toBe(true);

  await page.getByTestId('key-reset').click();
  await expect(shiftBox()).toHaveAttribute('data-shift', '0');
  await expect(shiftBox()).toHaveAttribute('data-first-note', '57');
  expect(await page.evaluate(() => window.encore!.session.parts!.player.shifterInGraph)).toBe(false);
  expect(pageErrors, 'page errors').toEqual([]);
});
