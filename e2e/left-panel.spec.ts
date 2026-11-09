/**
 * End-to-end proof of the quieter left panel in real Chromium. The (i) beside
 * a section title opens that section's explanation as a note even with Hover
 * help off, one at a time, closing on a second press and on Escape. The
 * panel's right edge is a keyboard-reachable separator: dragging it changes the
 * panel's width (and the lane's canvas follows) and survives a reload, the
 * arrow keys, Home and End resize it, Enter folds it into the icon rail, a drag
 * past the threshold folds it, and a rail icon unfolds it and scrolls to its
 * section. Reset all in Settings puts the size back. At phone width the handle
 * is gone and the collapse button remains. Nothing here uses window.confirm or
 * alert.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { stubService } from './fake-service';
import { PORT } from './fixtures';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await stubService(context, 'left-panel');
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('dialog', (dialog) => {
    pageErrors.push(`native dialog: ${dialog.message()}`);
    void dialog.dismiss();
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

const handle = () => page.getByTestId('panel-resizer');

/** The panel's width in pixels, as laid out. */
async function panelWidth(): Promise<number> {
  return (await page.locator('#song-panel').boundingBox())!.width;
}

/** The lane's box width and its canvas bitmap width in CSS pixels. */
async function laneWidths(): Promise<{ box: number; bitmap: number }> {
  return page.evaluate(() => {
    const lane = document.getElementById('pitch-lane')!;
    const canvas = document.getElementById('lane-canvas') as HTMLCanvasElement;
    return { box: lane.clientWidth, bitmap: canvas.width / (window.devicePixelRatio || 1) };
  });
}

/** Drags the handle by `dx` pixels with the mouse. */
async function dragHandle(dx: number): Promise<void> {
  const box = (await handle().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('1. the (i) beside a title shows its words even with Hover help off, one at a time', async () => {
  await page.evaluate(() => window.encore!.session.setHoverHelp(false));
  expect(await page.evaluate(() => window.encore!.store.state.hoverHelp)).toBe(false);

  const search = page.getByTestId('search');
  const searchInfo = search.getByTestId('info-button');
  const searchNote = search.getByTestId('info-note');
  await expect(searchInfo).toBeVisible();
  await expect(searchNote).toBeHidden();
  await expect(searchInfo).toHaveAttribute('aria-expanded', 'false');
  const noteId = await searchNote.getAttribute('id');
  expect(noteId).toBeTruthy();
  await expect(searchInfo).toHaveAttribute('aria-controls', noteId!);

  await searchInfo.click();
  await expect(searchNote).toBeVisible();
  await expect(searchNote).toContainText("opens YouTube's own search");
  await expect(searchInfo).toHaveAttribute('aria-expanded', 'true');
  // The note is in the panel, not a floating popup.
  await expect(page.getByTestId('hover-help')).toBeHidden();

  // A second press closes it.
  await searchInfo.click();
  await expect(searchNote).toBeHidden();
  await expect(searchInfo).toHaveAttribute('aria-expanded', 'false');

  // The keyboard: Enter opens, Space closes, Escape closes and keeps focus on the button.
  await searchInfo.focus();
  await page.keyboard.press('Enter');
  await expect(searchNote).toBeVisible();
  await page.keyboard.press('Space');
  await expect(searchNote).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(searchNote).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(searchNote).toBeHidden();
  await expect(searchInfo).toBeFocused();

  // Opening another closes the first.
  const devices = page.locator('#devices');
  await searchInfo.click();
  await expect(searchNote).toBeVisible();
  await devices.getByTestId('info-button').click();
  await expect(devices.getByTestId('info-note')).toBeVisible();
  await expect(devices.getByTestId('info-note')).toContainText('echo cancellation');
  await expect(searchNote).toBeHidden();
  await devices.getByTestId('info-button').click();
  await expect(devices.getByTestId('info-note')).toBeHidden();

  // The explanations are gone from the bars themselves.
  await expect(page.locator('#monitor-help')).toHaveCount(0);
  await expect(page.getByTestId('search-hint')).toHaveCount(0);
  await expect(page.getByTestId('singers-note')).toHaveCount(0);
  // Karaoke mode (the default) gives the Song reference no (i).
  await expect(page.getByTestId('song-reference').getByTestId('info-button')).toBeHidden();

  await page.evaluate(() => window.encore!.session.setHoverHelp(true));
});

test('1b. help that empties closes its open note, and the note stays closed when the words return', async () => {
  const devices = page.locator('#devices');
  const button = devices.getByTestId('info-button');
  const note = devices.getByTestId('info-note');
  await button.click();
  await expect(note).toBeVisible();
  const words = await devices.locator('[data-info]').getAttribute('data-help');
  expect(words).toBeTruthy();

  await devices.locator('[data-info]').evaluate((el) => el.setAttribute('data-help', ''));
  await expect(button).toBeHidden();
  await expect(note).toBeHidden();
  await devices.locator('[data-info]').evaluate((el, text) => el.setAttribute('data-help', text), words!);
  await expect(button).toBeVisible();
  await expect(note).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  // A focused button that is hidden hands its focus to the title, not to body.
  await button.focus();
  await devices.locator('[data-info]').evaluate((el) => el.setAttribute('data-help', ''));
  await expect(devices.locator('[data-info]')).toBeFocused();
  await devices.locator('[data-info]').evaluate((el, text) => el.setAttribute('data-help', text), words!);
});

test('2. dragging the handle resizes the panel, the lane follows, and a reload keeps it', async () => {
  const before = await panelWidth();
  expect(Math.round(before)).toBe(280);
  const laneBefore = await laneWidths();
  await expect(handle()).toHaveAttribute('role', 'separator');
  await expect(handle()).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle()).toHaveAttribute('aria-valuenow', '280');

  await dragHandle(100);
  await expect.poll(async () => Math.round(await panelWidth())).toBe(380);
  await expect(handle()).toHaveAttribute('aria-valuenow', '380');
  // The lane gave up the same width, and its canvas was re-measured to match.
  await expect
    .poll(async () => {
      const lane = await laneWidths();
      return [Math.round(laneBefore.box - lane.box), Math.abs(lane.bitmap - lane.box) < 1];
    })
    .toEqual([100, true]);

  // The width stays inside the limits: far to the right stops at the maximum.
  const max = Number(await handle().getAttribute('aria-valuemax'));
  await dragHandle(2000);
  await expect.poll(async () => Math.round(await panelWidth())).toBe(max);
  expect(max).toBeLessThanOrEqual(640);
  await dragHandle(-(max - 380));
  await expect.poll(async () => Math.round(await panelWidth())).toBe(380);

  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  expect(Math.round(await panelWidth())).toBe(380);
  await expect(handle()).toHaveAttribute('aria-valuenow', '380');
  const lane = await laneWidths();
  expect(Math.abs(lane.bitmap - lane.box)).toBeLessThan(1);
});

test('3. the separator takes the arrow keys, Home and End', async () => {
  await handle().focus();
  const start = Number(await handle().getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowRight');
  await expect(handle()).toHaveAttribute('aria-valuenow', String(start + 16));
  expect(Math.round(await panelWidth())).toBe(start + 16);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(handle()).toHaveAttribute('aria-valuenow', String(start - 16));
  await page.keyboard.press('Shift+ArrowRight');
  await expect(handle()).toHaveAttribute('aria-valuenow', String(start - 16 + 48));

  await page.keyboard.press('Home');
  await expect(handle()).toHaveAttribute('aria-valuenow', '220');
  expect(Math.round(await panelWidth())).toBe(220);
  const max = await handle().getAttribute('aria-valuemax');
  await page.keyboard.press('End');
  await expect(handle()).toHaveAttribute('aria-valuenow', max!);
  await page.keyboard.press('Home');
  // Arrow keys do not fold it: the narrowest expanded width holds.
  await page.keyboard.press('ArrowLeft');
  await expect(handle()).toHaveAttribute('aria-valuenow', '220');
  await expect(page.locator('#app')).toHaveAttribute('data-panel', 'open');
});

test('4. Enter and the buttons fold the panel into the rail and unfold it', async () => {
  const app = page.locator('#app');
  await handle().focus();
  await page.keyboard.press('Enter');
  await expect(app).toHaveAttribute('data-panel', 'rail');
  expect(Math.round(await panelWidth())).toBe(52);
  await expect(page.getByTestId('panel-rail')).toBeVisible();
  await expect(page.getByTestId('rail-dropzone')).toBeVisible();
  await expect(page.getByTestId('rail-takes')).toBeVisible();
  // A section that is not on the page has no icon.
  await expect(page.getByTestId('rail-karaoke')).toBeHidden();
  await expect(page.getByTestId('dropzone')).toBeHidden();
  await expect(handle()).toHaveAttribute('aria-valuenow', '52');
  await page.keyboard.press('Enter');
  await expect(app).toHaveAttribute('data-panel', 'open');
  await expect(page.getByTestId('dropzone')).toBeVisible();

  // The header button folds; the rail's own button unfolds.
  await page.getByTestId('panel-collapse').click();
  await expect(app).toHaveAttribute('data-panel', 'rail');
  await expect(page.getByTestId('panel-expand')).toBeFocused();
  // The lane has the freed width, canvas included.
  await expect
    .poll(async () => {
      const lane = await laneWidths();
      return [lane.box > 1000, Math.abs(lane.bitmap - lane.box) < 1];
    })
    .toEqual([true, true]);

  // It stays folded across a reload.
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await expect(app).toHaveAttribute('data-panel', 'rail');
  expect(Math.round(await panelWidth())).toBe(52);

  await page.getByTestId('panel-expand').click();
  await expect(app).toHaveAttribute('data-panel', 'open');
  await expect(page.getByTestId('panel-collapse')).toBeFocused();
});

test('5. dragging past the threshold folds it, and an icon in the rail unfolds it at its section', async () => {
  const app = page.locator('#app');
  await dragHandle(-600);
  await expect(app).toHaveAttribute('data-panel', 'rail');

  await page.getByTestId('rail-takes').click();
  await expect(app).toHaveAttribute('data-panel', 'open');
  await expect(page.locator('#takes')).toBeInViewport();

  // Dragging out of the rail unfolds it too.
  await page.getByTestId('panel-collapse').click();
  await expect(app).toHaveAttribute('data-panel', 'rail');
  await dragHandle(300);
  await expect(app).toHaveAttribute('data-panel', 'open');
  expect(await panelWidth()).toBeGreaterThanOrEqual(220);
});

test('6. Reset all puts the panel back to its default size', async () => {
  await handle().focus();
  await page.keyboard.press('End');
  expect(Math.round(await panelWidth())).toBeGreaterThan(300);
  expect(await page.evaluate(() => localStorage.getItem('encore.panel'))).not.toBeNull();

  await page.getByTestId('settings-toggle').click();
  await page.getByTestId('settings-reset').click();
  await page.getByTestId('settings-reset-yes').click();
  await page.getByTestId('settings-close').click();
  await expect.poll(async () => Math.round(await panelWidth())).toBe(280);
  await expect(page.locator('#app')).toHaveAttribute('data-panel', 'open');
  expect(await page.evaluate(() => localStorage.getItem('encore.panel'))).toBeNull();
});

test('7. at phone width the handle is gone and the collapse button remains', async () => {
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(handle()).toBeHidden();
  const collapse = page.getByTestId('panel-collapse');
  await expect(collapse).toBeVisible();
  // The panel keeps the stacked layout: full width, above the stage.
  const box = (await page.locator('#song-panel').boundingBox())!;
  const lane = (await page.locator('#pitch-lane').boundingBox())!;
  expect(box.width).toBeGreaterThan(500);
  expect(box.y + box.height).toBeLessThanOrEqual(lane.y + 1);
  await collapse.click();
  await expect(page.locator('#app')).toHaveAttribute('data-panel', 'rail');
  await expect(page.getByTestId('panel-expand')).toBeVisible();
  await page.getByTestId('panel-expand').click();
  await expect(page.locator('#app')).toHaveAttribute('data-panel', 'open');
  await page.setViewportSize({ width: 1280, height: 720 });
});
