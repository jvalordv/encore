/**
 * End-to-end proof of the lyrics line in real Chromium against the production
 * bundle. lrclib.net is routed to a fixture, so no request leaves the machine.
 * A dropped file is looked up, the line over the lane follows the song as it
 * plays (the fixture is four seconds long), and after a reload the same song
 * shows its lyrics from the IndexedDB cache with no second lookup.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PORT, SONG_FILE } from './fixtures';

const LRC = ['[00:00.20]First line', '[00:01.00]Second line', '[00:02.50]Third line', '[00:03.50]'].join('\n');

test('the lyrics line follows the song, and comes back from the cache', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  const lookups: string[] = [];
  await context.route('https://lrclib.net/api/**', (route) => {
    lookups.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ trackName: 'Lyric Song', artistName: 'Lyric Artist', syncedLyrics: LRC, plainLyrics: 'x' }),
    });
  });
  const errors: string[] = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));

  const bytes = readFileSync(SONG_FILE);
  const drop = async (target: Page): Promise<void> => {
    await target.goto('/');
    await target.waitForFunction(() => window.encore !== undefined);
    await target
      .getByTestId('song-input')
      .setInputFiles({ name: 'Lyric Artist - Lyric Song (Karaoke Version).wav', mimeType: 'audio/wav', buffer: bytes });
    await expect(target.getByTestId('status-text')).toContainText('Loaded');
  };

  await drop(page);
  await expect(page.getByTestId('lyrics-title')).toHaveValue('Lyric Song');
  await expect(page.getByTestId('lyrics-artist')).toHaveValue('Lyric Artist');
  await expect(page.getByTestId('lyrics-line')).toBeHidden();
  await page.getByTestId('lyrics-find').click();
  await expect(page.getByTestId('lyrics-status')).toContainText('Synced lyrics from LRCLIB');
  expect(lookups.length).toBeGreaterThan(0);
  const first = new URL(lookups[0]);
  expect(first.searchParams.get('track_name')).toBe('Lyric Song');
  expect(first.searchParams.get('artist_name')).toBe('Lyric Artist');
  // A file with no Karaoke badge: the line is on once lines exist.
  await expect(page.getByTestId('lyrics-line')).toBeVisible();

  await page.getByTestId('play').click();
  await expect(page.getByTestId('lyrics-now')).toHaveText('Second line');
  await expect(page.getByTestId('lyrics-next')).toHaveText('Third line');
  await expect(page.getByTestId('lyrics-now')).toHaveText('Third line');

  const before = lookups.length;
  await drop(page);
  await expect(page.getByTestId('lyrics-line')).toBeVisible();
  await expect(page.getByTestId('lyrics-status')).toContainText('Synced lyrics from LRCLIB');
  expect(lookups.length).toBe(before);
  expect(errors).toEqual([]);
  await context.close();
});
