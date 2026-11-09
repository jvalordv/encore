/**
 * End-to-end proof of singer profiles in real Chromium: a second singer is
 * made from the header's dropdown, chosen (the Singers panel shows them), has
 * an empty Progress in the right-hand drawer (which opens with focus inside
 * and closes with the x, Escape and a press outside), is deleted from Manage
 * singers behind an in-app confirmation that names what goes, and the last
 * singer cannot be deleted. The transport buttons and the status line carry
 * plain words. Deleting a singer can keep their takes, which then list under
 * All singers as "No singer". Hover help shows after a short delay, hides on
 * Escape, and has a Settings switch. Nothing here uses window.confirm or alert.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { stubService } from './fake-service';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await stubService(context, 'profiles');
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

/** The name of the singer the header dropdown shows. */
async function headerSinger(): Promise<string> {
  return page.getByTestId('profile-select').evaluate((el) => {
    const select = el as HTMLSelectElement;
    return select.selectedOptions[0]?.textContent ?? '';
  });
}

test('the transport and the status line use plain words', async () => {
  await expect(page.getByTestId('loop-a')).toHaveAttribute('data-help', /Set loop start here/);
  await expect(page.getByTestId('loop-a')).toHaveAttribute('aria-label', 'Set loop start here');
  await expect(page.getByTestId('loop-b')).toHaveAttribute('aria-label', 'Set loop end here');
  await expect(page.getByTestId('loop-clear')).toHaveAttribute('aria-label', 'Repeat between A and B');
  await expect(page.getByTestId('key-down')).toHaveAttribute('aria-label', 'Lower the song by a semitone');
  await expect(page.getByTestId('key-up')).toHaveAttribute('aria-label', 'Raise the song by a semitone');
  await expect(page.getByTestId('key-readout')).toHaveAttribute('aria-label', 'Semitones from the original key');
  await expect(page.getByTestId('status-health')).toContainText('Mic delay: not calibrated (Mic check)');
  await expect(page.getByTestId('status-health')).toContainText('Pitch: idle');
  await expect(page.getByTestId('status-health')).toHaveAttribute('data-help', /Mic delay/);
});

test('hover help explains a disabled control and hands over to the next one at once', async () => {
  const help = page.getByTestId('hover-help');
  const play = page.getByTestId('play');
  const stop = page.getByTestId('stop');
  await expect(play).toBeDisabled();
  await expect(page.getByTestId('output-select')).toHaveAttribute('data-help', /.+/);
  const centre = async (id: string): Promise<{ x: number; y: number }> => {
    const box = await page.getByTestId(id).boundingBox();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  };
  await page.mouse.move(0, 400);
  const at = await centre('play');
  await page.mouse.move(at.x, at.y);
  await expect(help).toBeVisible();
  await expect(help).toContainText('Play or pause');
  // Moving to the next control while the popup shows swaps it with no delay.
  const next = await centre('stop');
  await page.mouse.move(next.x, next.y);
  await expect(help).toContainText('Stop and return', { timeout: 150 });
  await expect(stop).toBeDisabled();
  await page.mouse.move(0, 400);
  await expect(help).toBeHidden();
});

test('starts with one singer, and the Singers panel and header agree', async () => {
  expect(await headerSinger()).toBe('Singer 1');
  await expect(page.getByTestId('singer-a-profile')).toHaveValue(
    await page.getByTestId('profile-select').inputValue(),
  );
  await expect(page.getByTestId('singer-a-name')).toHaveValue('Singer 1');
});

test('makes a second singer from the header and switches to them', async () => {
  await page.getByTestId('profile-select').selectOption('@new');
  await expect(page.getByTestId('profile-dialog')).toBeVisible();
  // The name field has focus and a suggestion in it; type our own.
  await expect(page.getByTestId('profile-new-name')).toBeFocused();
  await page.getByTestId('profile-new-name').fill('Bo');
  await page.getByTestId('profile-new-create').click();
  await expect(page.getByTestId('profile-dialog')).toBeHidden();
  expect(await headerSinger()).toBe('Bo');
  await expect(page.getByTestId('singer-a-name')).toHaveValue('Bo');
  await expect(page.getByTestId('singer-a-profile')).toHaveValue(await page.getByTestId('profile-select').inputValue());
  expect(await page.evaluate(() => window.encore!.store.state.profiles.list.map((p) => p.name))).toEqual([
    'Singer 1',
    'Bo',
  ]);
});

test('Escape closes the dialog and gives focus back', async () => {
  // As a person at the keyboard has it: the dropdown is focused when they pick.
  await page.getByTestId('profile-select').focus();
  await page.getByTestId('profile-select').selectOption('@new');
  await expect(page.getByTestId('profile-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profile-dialog')).toBeHidden();
  await expect(page.getByTestId('profile-select')).toBeFocused();
  expect(await headerSinger()).toBe('Bo');
});

test('shows an empty Progress for the new singer in a drawer that closes three ways', async () => {
  await expect(page.getByTestId('progress-button')).toBeHidden();
  await page.getByTestId('mode-learning').click();
  await expect(page.getByTestId('progress-button')).toBeVisible();

  const lane = await page.getByTestId('lane-canvas').boundingBox();
  await page.getByTestId('progress-button').click();
  const drawer = page.getByTestId('progress');
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId('progress-close')).toBeFocused();
  await expect(page.getByTestId('progress-title')).toHaveText('Progress: Bo');
  await expect(page.getByTestId('progress-count')).toContainText('No learning takes for Bo yet');
  // It slides over the page at the right and does not push the lane around.
  const box = await drawer.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.x + box.width > viewport.width - 24).toBe(true);
  expect(await page.getByTestId('lane-canvas').boundingBox()).toEqual(lane);

  // Switching singer in the header redraws it at once.
  await page.getByTestId('profile-select').selectOption({ label: 'Singer 1' });
  await expect(page.getByTestId('progress-title')).toHaveText('Progress: Singer 1');
  await expect(drawer).toBeVisible();
  await page.getByTestId('profile-select').selectOption({ label: 'Bo' });
  await expect(page.getByTestId('progress-title')).toHaveText('Progress: Bo');

  // Escape.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('progress-button')).toBeFocused();
  // The x.
  await page.getByTestId('progress-button').click();
  await expect(drawer).toBeVisible();
  await page.getByTestId('progress-close').click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('progress-button')).toBeFocused();
  // A press outside.
  await page.getByTestId('progress-button').click();
  await expect(drawer).toBeVisible();
  await page.locator('.wordmark').click();
  await expect(drawer).toBeHidden();

  // Karaoke mode hides the button and closes the drawer.
  await page.getByTestId('progress-button').click();
  await expect(drawer).toBeVisible();
  await page.getByTestId('mode-karaoke').click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('progress-button')).toBeHidden();
});

test('keeps the Progress drawer through singer work, and Settings by keyboard replaces it', async () => {
  await page.getByTestId('mode-learning').click();
  await page.getByTestId('progress-button').click();
  const drawer = page.getByTestId('progress');
  await expect(drawer).toBeVisible();

  // A real press on the header dropdown is part of working with the drawer.
  await page.getByTestId('profile-select').dispatchEvent('pointerdown');
  await expect(drawer).toBeVisible();

  // Escape in the dialog over the drawer closes only the dialog, one layer at a time.
  await page.getByTestId('profile-select').selectOption('@manage');
  await expect(page.getByTestId('profile-dialog')).toBeVisible();
  const row = page.getByTestId('manage-row').first();
  await row.getByTestId('manage-delete').click();
  await expect(page.getByTestId('manage-warning')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('manage-warning')).toBeHidden();
  await expect(page.getByTestId('profile-dialog')).toBeVisible();
  // Focus is back on the Delete of the row that was pending, not lost.
  await expect(row.getByTestId('manage-delete')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profile-dialog')).toBeHidden();
  await expect(drawer).toBeVisible();

  // Settings opened from the keyboard fires no press, yet the drawers do not stack.
  await page.getByTestId('settings-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(drawer).toBeHidden();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('settings')).toBeHidden();
  await page.getByTestId('mode-karaoke').click();
});

test('puts a second singer in B\'s slot, and A and B are never the same one', async () => {
  await page.getByTestId('singer-b-on').check();
  await expect(page.getByTestId('singer-b-profile')).toBeVisible();
  const ids = await page.evaluate(() => window.encore!.store.state.profiles);
  expect(ids.secondId).not.toBeNull();
  expect(ids.secondId).not.toBe(ids.activeId);
  // Picking A's singer for B trades the two.
  await page.getByTestId('singer-b-profile').selectOption(ids.activeId);
  const after = await page.evaluate(() => window.encore!.store.state.profiles);
  expect(after).toMatchObject({ activeId: ids.secondId, secondId: ids.activeId });
  await page.getByTestId('singer-b-on').uncheck();
  // Back to Bo as singer A.
  await page.getByTestId('profile-select').selectOption({ label: 'Bo' });
  expect(await headerSinger()).toBe('Bo');
});

test('deletes a singer behind an in-app confirmation that says what goes', async () => {
  // One recording for Bo, so the confirmation has something to count.
  await page.evaluate(async () => {
    const { session, store } = window.encore!;
    const core = (session as unknown as { core: { takesReady: Promise<{ save(t: object): Promise<string> }> } }).core;
    await (
      await core.takesReady
    ).save({
      songHash: 'h1',
      songName: 'Seeded',
      createdAt: Date.now(),
      durationS: 4,
      latencyS: 0,
      sampleRate: 48000,
      voicedFrames: 100,
      frames: [],
      wav: new Blob([]),
      profileId: store.state.profiles.activeId,
    });
  });
  await page.getByTestId('profile-select').selectOption('@manage');
  await expect(page.getByTestId('profile-dialog')).toBeVisible();
  await expect(page.getByTestId('manage-row')).toHaveCount(await page.evaluate(() => window.encore!.store.state.profiles.list.length));
  const bo = page.getByTestId('manage-row').filter({ has: page.getByLabel('Name of Bo') });

  // Cancel changes nothing.
  await bo.getByTestId('manage-delete').click();
  await expect(page.getByTestId('manage-warning')).toContainText('cannot be undone');
  await expect(page.getByTestId('manage-warning')).toContainText('recordings');
  await expect(page.getByTestId('manage-warning')).toContainText('progress, streak, personal bests and range');
  await expect(page.getByTestId('manage-delete-confirm')).toHaveText('Delete Bo and 1 take');
  await page.getByTestId('manage-delete-cancel').click();
  await expect(page.getByTestId('manage-row').filter({ has: page.getByLabel('Name of Bo') })).toHaveCount(1);

  // Rename in place.
  await bo.getByTestId('manage-name').fill('Robin');
  await bo.getByTestId('manage-rename').click();
  await expect(page.getByLabel('Name of Robin')).toBeVisible();
  expect(await headerSinger()).toBe('Robin');

  // Delete for real.
  const robin = page.getByTestId('manage-row').filter({ has: page.getByLabel('Name of Robin') });
  await robin.getByTestId('manage-delete').click();
  await expect(page.getByTestId('manage-delete-confirm')).toHaveText('Delete Robin and 1 take');
  await page.getByTestId('manage-delete-confirm').click();
  await expect(page.getByTestId('manage-row')).toHaveCount(1);
  await expect(page.getByTestId('profile-dialog-note')).toContainText('Deleted Robin and 1 take');
  // The active singer fell back to the one that is left.
  expect(await headerSinger()).toBe('Singer 1');
  expect(await page.evaluate(() => window.encore!.store.state.profiles.list.map((p) => p.name))).toEqual(['Singer 1']);

  // The last singer cannot be deleted.
  await expect(page.getByTestId('manage-delete')).toBeDisabled();
  await expect(page.getByTestId('manage-only')).toBeVisible();
  await page.getByTestId('profile-dialog-close').click();
  await expect(page.getByTestId('profile-dialog')).toBeHidden();
});

test('deletes a singer but keeps their takes, which list as "No singer"', async () => {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => window.encore!.store.state.song !== null);
  // Cy sings one take of the loaded song.
  await page.evaluate(async () => {
    const { session, store } = window.encore!;
    const song = store.state.song!;
    const core = (
      session as unknown as {
        core: { takesReady: Promise<{ save(t: object): Promise<string> }>; takes: { refreshTakes(): Promise<void> } };
      }
    ).core;
    session.profiles.create('Cy');
    await (
      await core.takesReady
    ).save({
      songHash: song.hash,
      songName: song.name,
      createdAt: Date.now(),
      durationS: 4,
      latencyS: 0,
      sampleRate: 48000,
      voicedFrames: 100,
      frames: [],
      wav: new Blob([]),
      profileId: store.state.profiles.activeId,
    });
    await core.takes.refreshTakes();
  });
  expect(await headerSinger()).toBe('Cy');
  await expect(page.getByTestId('take-item')).toHaveCount(1);

  await page.getByTestId('profile-select').selectOption('@manage');
  const cy = page.getByTestId('manage-row').filter({ has: page.getByLabel('Name of Cy') });
  await cy.getByTestId('manage-delete').click();
  await expect(page.getByTestId('manage-delete-confirm')).toHaveText('Delete Cy and 1 take');
  await expect(page.getByTestId('manage-delete-keep')).toHaveText('Delete Cy, keep 1 take');
  await expect(page.getByTestId('manage-delete-cancel')).toBeVisible();
  await expect(page.getByTestId('manage-warning')).toContainText('No singer');
  await page.getByTestId('manage-delete-keep').click();
  await expect(page.getByTestId('profile-dialog-note')).toContainText('Deleted Cy; 1 take kept as No singer');
  await page.getByTestId('profile-dialog-close').click();

  // The take is marked, and is on nobody's own list.
  expect(await headerSinger()).toBe('Singer 1');
  const marked = await page.evaluate(async () => {
    const core = (window.encore!.session as unknown as { core: { takesReady: Promise<{ list(): Promise<Array<{ profileId?: string }>> }> } }).core;
    return (await (await core.takesReady).list()).map((t) => t.profileId);
  });
  expect(marked).toEqual(['none']);
  await expect(page.getByTestId('take-item')).toHaveCount(0);

  // Under All singers it is listed, playable, and named "No singer".
  await page.getByTestId('take-owner').selectOption('all');
  const item = page.getByTestId('take-item');
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId('take-label')).toContainText('No singer');
  await expect(item.getByTestId('take-play')).toBeVisible();
});

test('hover help appears after a delay, hides on Escape, and can be turned off in Settings', async () => {
  const help = page.getByTestId('hover-help');
  const target = page.getByTestId('library-toggle');
  await expect(target).not.toHaveAttribute('title', /.*/);
  await page.mouse.move(0, 400);
  await target.hover();
  // Not at once: the popup waits a moment.
  await expect(help).toBeHidden();
  await expect(help).toBeVisible();
  await expect(help).toContainText('Every song you have loaded');
  await expect(target).toHaveAttribute('aria-describedby', 'hover-help');
  const box = await help.boundingBox();
  const view = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(view.width);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(target).not.toHaveAttribute('aria-describedby', /.+/);

  // Keyboard focus shows it too.
  await page.mouse.move(0, 400);
  await page.getByTestId('settings-toggle').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(target).toBeFocused();
  await expect(help).toBeVisible();
  // Tabbing on hands the popup to the next control; Escape then hides it.
  await page.keyboard.press('Tab');
  await expect(help).toContainText('Every setting in one place');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // The Settings switch: on by default, off means no popup but the labels stay.
  await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('settings-hover-help')).toBeChecked();
  await page.getByTestId('settings-hover-help').uncheck();
  expect(await page.evaluate(() => window.encore!.store.state.hoverHelp)).toBe(false);
  await page.getByTestId('settings-close').click();
  await page.mouse.move(0, 400);
  await target.hover();
  await page.waitForTimeout(700);
  await expect(help).toBeHidden();
  await expect(target).toHaveText('Library');
  await expect(page.getByTestId('loop-a')).toHaveAttribute('aria-label', 'Set loop start here');

  // Back on again.
  await page.getByTestId('settings-toggle').click();
  await page.getByTestId('settings-hover-help').check();
  await page.getByTestId('settings-close').click();
  await page.mouse.move(0, 400);
  await target.hover();
  await expect(help).toBeVisible();
});
