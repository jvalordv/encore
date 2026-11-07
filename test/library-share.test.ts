/**
 * Tests for exporting and importing favorites (src/app/library-share.ts):
 * the round trip, and that the import trusts nothing in the file.
 */
import { describe, expect, it } from 'vitest';
import { entryAfterLoad } from '../src/app/library';
import type { LibraryEntry } from '../src/app/library';
import {
  describeImport,
  exportFavorites,
  FAVORITES_KIND,
  MAX_IMPORT_ITEMS,
  parseFavorites,
} from '../src/app/library-share';

const HASH = 'ab'.repeat(32);

function fav(over: Partial<LibraryEntry>): LibraryEntry {
  return {
    ...entryAfterLoad(null, { id: 'x', source: 'file', title: 't', videoId: null, fileName: null, durationS: 1 }, 1),
    favorite: true,
    ...over,
  };
}

const file = (text: string): string => JSON.stringify({ kind: FAVORITES_KIND, version: 1, items: JSON.parse(text) });

describe('exportFavorites / parseFavorites', () => {
  it('round-trips the favorites in order, links and uploads', () => {
    const entries = [
      fav({ id: HASH, source: 'file', title: 'Mine', fileName: 'mine.mp3', durationS: 61, order: 1 }),
      fav({ id: 'yt-dQw4w9WgXcQ', source: 'youtube', title: 'Link', videoId: 'dQw4w9WgXcQ', durationS: 212, order: 0 }),
      fav({ id: 'yt-aaaaaaaaaaa', source: 'youtube', videoId: 'aaaaaaaaaaa', favorite: false }),
    ];
    const parsed = parseFavorites(exportFavorites(entries));
    expect(parsed.error).toBeNull();
    expect(parsed.skipped).toBe(0);
    expect(parsed.songs.map((s) => [s.id, s.source, s.title])).toEqual([
      ['yt-dQw4w9WgXcQ', 'youtube', 'Link'],
      [HASH, 'file', 'Mine'],
    ]);
    expect(parsed.songs[1]).toMatchObject({ fileName: 'mine.mp3', durationS: 61 });
  });
});

describe('parseFavorites', () => {
  it('refuses text that is not JSON or not a favorites file', () => {
    expect(parseFavorites('not json').error).toMatch(/not JSON/);
    expect(parseFavorites('[]').error).toMatch(/not an Encore favorites/);
    expect(parseFavorites('null').error).toMatch(/not an Encore favorites/);
    expect(parseFavorites(JSON.stringify({ kind: 'other', items: [] })).error).toMatch(/not an Encore/);
    expect(parseFavorites(JSON.stringify({ kind: FAVORITES_KIND })).error).toMatch(/not an Encore/);
  });

  it('refuses a missing or unknown version', () => {
    const msg = /different version of Encore/;
    expect(parseFavorites(JSON.stringify({ kind: FAVORITES_KIND, items: [] })).error).toMatch(msg);
    expect(parseFavorites(JSON.stringify({ kind: FAVORITES_KIND, version: 2, items: [] })).error).toMatch(msg);
  });

  it('skips malformed items and counts them', () => {
    const items = [
      { source: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'ok' },
      { source: 'youtube', videoId: 'short' },
      { source: 'youtube', videoId: '../../etc/passwd' },
      { source: 'file', id: 'not-a-hash' },
      { source: 'file', id: HASH.toUpperCase(), fileName: 'ok.mp3' },
      { source: 'spotify', id: 'x' },
      'text',
      null,
      42,
    ];
    const parsed = parseFavorites(file(JSON.stringify(items)));
    expect(parsed.songs).toHaveLength(2);
    expect(parsed.skipped).toBe(7);
    // A hash is stored in lower case, so it matches the service's ids.
    expect(parsed.songs[1]?.id).toBe(HASH);
  });

  it('drops duplicates, keeping the first', () => {
    const item = { source: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'first' };
    const parsed = parseFavorites(file(JSON.stringify([item, { ...item, title: 'second' }])));
    expect(parsed.songs.map((s) => s.title)).toEqual(['first']);
    expect(parsed.skipped).toBe(1);
  });

  it('cleans titles and lengths, and ignores unknown fields', () => {
    const parsed = parseFavorites(
      file(
        JSON.stringify([
          { source: 'youtube', videoId: 'dQw4w9WgXcQ', title: `  ${'t'.repeat(500)}  `, durationS: -5, evil: '<script>' },
          { source: 'youtube', videoId: 'aaaaaaaaaaa', title: 7, durationS: 'long' },
        ]),
      ),
    );
    expect(parsed.songs[0]?.title).toHaveLength(200);
    expect(parsed.songs[0]?.durationS).toBe(0);
    expect(parsed.songs[0]).not.toHaveProperty('evil');
    // A bad title falls back to the video id.
    expect(parsed.songs[1]).toMatchObject({ title: 'aaaaaaaaaaa', durationS: 0 });
  });

  it('takes no more than the cap', () => {
    const items = Array.from({ length: MAX_IMPORT_ITEMS + 5 }, (_, i) => ({
      source: 'youtube',
      videoId: `${String(i).padStart(11, 'a')}`,
    }));
    const parsed = parseFavorites(file(JSON.stringify(items)));
    expect(parsed.songs).toHaveLength(MAX_IMPORT_ITEMS);
    expect(parsed.skipped).toBe(5);
  });
});

describe('describeImport', () => {
  it('says how many came in, and what was skipped or is missing', () => {
    expect(describeImport(1, 0, 0)).toBe('Imported 1 favorite.');
    const text = describeImport(3, 2, 1);
    expect(text).toContain('Imported 3 favorites.');
    expect(text).toContain('2 items were skipped.');
    expect(text).toContain('1 upload is not in this browser or on the service');
  });
});
