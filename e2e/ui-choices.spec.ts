/**
 * End-to-end proof that the panel choices survive a reload and travel with
 * the settings export, in real Chromium against the production bundle with the
 * service stubbed. A song and a take of it are written into the app; the
 * Library's All singers switch is set and the song's takes opened, the Takes
 * list is switched to everyone, the Library is put on Favorites and the Mic
 * check on the higher voice, and after a reload all five are as they were.
 * Then the song panel is widened, the settings are exported, Reset all puts the
 * width and every choice back to its default, and importing the file restores
 * the width and the choices. The tests share one page and run in order.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubService, fileStatus } from './fake-service';
import { PORT, SONG_FILE } from './fixtures';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
let exportedPath = '';
let defaultWidth = 0;
let widenedWidth = 0;

const songBytes = readFileSync(SONG_FILE);

const handle = () => page.getByTestId('panel-resizer');
const row = () => page.getByTestId('library-item').filter({ has: page.locator('[data-testid="library-title"]:text-is("one")') });

async function panelWidth(): Promise<number> {
  return Math.round((await page.locator('#song-panel').boundingBox())!.width);
}

async function openLibrary(): Promise<void> {
  if (await page.getByTestId('library').isHidden()) await page.getByTestId('library-toggle').click();
  await expect(page.getByTestId('library')).toBeVisible();
}

async function openSettings(): Promise<void> {
  if (await page.getByTestId('settings').isHidden()) await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('settings')).toBeVisible();
}

async function openMicCheck(): Promise<void> {
  if (await page.getByTestId('mic-check-panel').isHidden()) await page.getByTestId('mic-check').click();
  await expect(page.getByTestId('mic-check-panel')).toBeVisible();
}

async function reload(): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
}

/** Writes one take record of `songHash` into the app's take database. */
async function seedTake(songHash: string): Promise<void> {
  const wavBase64 = songBytes.toString('base64');
  await page.evaluate(
    async ({ songHash: hash, wavBase64: b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('encore');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('takes', 'readwrite');
        tx.objectStore('takes').put({
          id: crypto.randomUUID(),
          songHash: hash,
          songName: 'one',
          createdAt: Date.now() - 60_000,
          durationS: 4,
          latencyS: 0,
          sampleRate: 48000,
          startedAtSongS: 0,
          frames: [],
          wav: new Blob([bytes], { type: 'audio/wav' }),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { songHash, wavBase64 },
  );
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  const service = await stubService(context, 'ui-choices');
  service.status = fileStatus('stored');
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('dialog', (dialog) => {
    pageErrors.push(`native dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
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

test('the All singers switch, an open row and the Takes filter are kept after a reload', async () => {
  await page.getByTestId('song-input').setInputFiles({ name: 'one.wav', mimeType: 'audio/wav', buffer: songBytes });
  await expect(page.getByTestId('status-text')).toContainText('Loaded one.wav');
  const hash = await page.evaluate(() => window.encore!.store.state.song!.hash);
  await seedTake(hash);

  await openLibrary();
  await expect(row().getByTestId('library-takes-toggle')).toContainText('1 take');
  await page.getByTestId('library-all-singers').check();
  await row().getByTestId('library-takes-toggle').click();
  await expect(row().getByTestId('library-take')).toHaveCount(1);
  await page.getByTestId('take-owner').selectOption('all');
  await page.getByTestId('library-tab-favorites').click();
  await openMicCheck();
  await page.getByTestId('mic-check-range-high').click();
  await expect(page.getByTestId('mic-check-range-high')).toHaveAttribute('aria-pressed', 'true');

  await reload();
  await openLibrary();
  await expect(page.getByTestId('library-tab-favorites')).toHaveAttribute('aria-pressed', 'true');
  await openMicCheck();
  await expect(page.getByTestId('mic-check-range-high')).toHaveAttribute('aria-pressed', 'true');
  // The row list is hidden behind Favorites; the row's state is read from All.
  await page.getByTestId('library-tab-all').click();
  await expect(page.getByTestId('library-all-singers')).toBeChecked();
  await expect(row().getByTestId('library-takes-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(row().getByTestId('library-take')).toHaveCount(1);
  await expect(page.getByTestId('take-owner')).toHaveValue('all');
  await page.getByTestId('library-tab-favorites').click();
});

test('a panel width and the choices go into the export, Reset all clears them and an import brings them back', async () => {
  defaultWidth = await panelWidth();
  await handle().focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  widenedWidth = await panelWidth();
  expect(widenedWidth).toBe(defaultWidth + 96);

  await openSettings();
  const download = page.waitForEvent('download');
  await page.getByTestId('settings-export').click();
  const file = await download;
  exportedPath = (await file.path()) ?? '';
  const exported = JSON.parse(readFileSync(exportedPath, 'utf8'));
  expect(exported.layout).toEqual({ width: widenedWidth, collapsed: false });
  expect(exported.ui).toMatchObject({
    libraryAllSingers: true,
    takesScope: 'all',
    libraryView: 'favorites',
    micCheckRange: 'high',
  });
  expect(exported.ui.libraryExpanded).toHaveLength(1);

  await page.getByTestId('settings-reset').click();
  await page.getByTestId('settings-reset-yes').click();
  await expect(page.getByTestId('settings-notice')).toContainText('back to its default');
  expect(await panelWidth()).toBe(defaultWidth);
  await expect(page.getByTestId('take-owner')).toHaveValue('mine');
  await openLibrary();
  await expect(page.getByTestId('library-all-singers')).not.toBeChecked();
  await expect(row().getByTestId('library-takes-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('library-tab-favorites')).toHaveAttribute('aria-pressed', 'false');
  await openMicCheck();
  await expect(page.getByTestId('mic-check-range-low')).toHaveAttribute('aria-pressed', 'true');

  // The reset is kept across a reload too.
  await reload();
  expect(await panelWidth()).toBe(defaultWidth);

  await openSettings();
  await page.getByTestId('settings-import-file').setInputFiles(exportedPath);
  await expect(page.getByTestId('settings-notice')).toContainText('Panel layout');
  expect(await panelWidth()).toBe(widenedWidth);
  await expect(page.getByTestId('take-owner')).toHaveValue('all');
  await openLibrary();
  await expect(page.getByTestId('library-all-singers')).toBeChecked();
  await expect(page.getByTestId('library-tab-favorites')).toHaveAttribute('aria-pressed', 'true');
  await openMicCheck();
  await expect(page.getByTestId('mic-check-range-high')).toHaveAttribute('aria-pressed', 'true');
  // Rows are listed under All songs, so read the open row there.
  await page.getByTestId('library-tab-all').click();
  await expect(row().getByTestId('library-takes-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('library-tab-favorites').click();

  // And the import is kept across a reload.
  await reload();
  expect(await panelWidth()).toBe(widenedWidth);
});
