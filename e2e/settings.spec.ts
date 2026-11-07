/**
 * End-to-end proof of the Settings drawer in real Chromium against the
 * production bundle: open it, change the skin and the note guide, reload and
 * see both kept (in the drawer and at the inline controls), set a search key,
 * and export the settings as a download that carries no key unless the box is
 * ticked. The tests share one page and run in order.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PORT } from './fixtures';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

const KEY = 'AIzaSyTestKeyForSettings0123456789';

async function openSettings(): Promise<void> {
  if (await page.getByTestId('settings').isHidden()) await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('settings')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: `http://localhost:${PORT}` });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });
  await page.goto('/');
  await page.waitForFunction(() => window.encore !== undefined);
});

test.afterAll(async () => {
  await context.close();
  expect(pageErrors).toEqual([]);
});

test('the skin and the note guide changed in Settings survive a reload', async () => {
  await openSettings();
  await page.getByTestId('settings-skin').selectOption('arcade');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'arcade');
  // The header's own switcher follows.
  await expect(page.locator('#skin-switcher')).toHaveValue('arcade');
  await page.getByTestId('settings-note-guide').check();
  await expect(page.getByTestId('note-guide-toggle')).toBeChecked();

  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'arcade');
  await expect(page.getByTestId('note-guide-toggle')).toBeChecked();
  await openSettings();
  await expect(page.getByTestId('settings-skin')).toHaveValue('arcade');
  await expect(page.getByTestId('settings-note-guide')).toBeChecked();
});

test('the inline note guide and the drawer stay in step', async () => {
  await openSettings();
  await page.getByTestId('note-guide-toggle').uncheck();
  await expect(page.getByTestId('settings-note-guide')).not.toBeChecked();
  await page.getByTestId('settings-note-guide').check();
  await expect(page.getByTestId('note-guide-toggle')).toBeChecked();
});

test('the export has no search key unless the box is ticked', async () => {
  await openSettings();
  const key = page.getByTestId('settings-search-key');
  await key.fill(KEY);
  await key.blur();
  await expect(page.getByTestId('settings-search-note')).toHaveText('Key saved.');
  // Masked until Show is ticked.
  await expect(key).toHaveAttribute('type', 'password');

  const plain = page.waitForEvent('download');
  await page.getByTestId('settings-export').click();
  const first = await plain;
  expect(first.suggestedFilename()).toBe('encore-settings.json');
  const text = readFileSync((await first.path()) ?? '', 'utf8');
  expect(text).not.toContain(KEY);
  const file = JSON.parse(text);
  expect(file.settings.noteGuide).toBe(true);
  expect(file.skin).toBe('arcade');
  expect('youtubeApiKey' in file.settings).toBe(false);

  await page.getByTestId('settings-export-key').check();
  const withKey = page.waitForEvent('download');
  await page.getByTestId('settings-export').click();
  const second = await withKey;
  expect(readFileSync((await second.path()) ?? '', 'utf8')).toContain(KEY);
});
