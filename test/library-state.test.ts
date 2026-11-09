/**
 * Tests for the words and lists the Library panel draws
 * (src/app/library-state.ts): the service-only group, the row text, the
 * played-ago line and the playlist position.
 */
import { describe, expect, it } from 'vitest';
import { entryAfterLoad } from '../src/app/library';
import type { LibraryEntry } from '../src/app/library';
import {
  entriesFor,
  initialLibrary,
  lengthLabel,
  playedLabel,
  playlistPosition,
  referenceBadge,
  rowOf,
  serviceOnly,
  takesLabel,
} from '../src/app/library-state';
import type { SongSummary } from '../src/service/types';

function entry(id: string, over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    ...entryAfterLoad(null, { id, source: 'file', title: id, videoId: null, fileName: id, durationS: 125 }, 0),
    ...over,
  };
}

function row(id: string, over: Partial<SongSummary> = {}): SongSummary {
  return { id, name: id, source: 'file', duration_s: 60, steps_done: [], has_audio: true, updated_at: 1, ...over };
}

describe('serviceOnly', () => {
  it('lists uploads the Library does not have, with audio held', () => {
    const rows = [
      row('known'),
      row('only-here', { steps_done: ['separation'] }),
      row('no-audio', { has_audio: false }),
      row('yt-aaaaaaaaaaa', { source: 'youtube' }),
    ];
    expect(serviceOnly(rows, [entry('known')])).toEqual([
      { id: 'only-here', name: 'only-here', durationS: 60, stems: true },
    ]);
  });
});

describe('entriesFor', () => {
  it('lists everything newest first, or the favorites in order', () => {
    const entries = [entry('a'), entry('b', { favorite: true, order: 1 }), entry('c', { favorite: true, order: 0 })];
    expect(entriesFor({ view: 'all', entries }).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(entriesFor({ view: 'favorites', entries }).map((e) => e.id)).toEqual(['c', 'b']);
  });
});

describe('labels', () => {
  it('formats length, takes and prepared words', () => {
    expect(lengthLabel(125)).toBe('2:05');
    expect(lengthLabel(0)).toBe('');
    expect(takesLabel(1)).toBe('1 take');
    expect(takesLabel(3)).toBe('3 takes');
  });

  it('badges a song Melody, Key, Backing or nothing, with words that are the same in either mode', () => {
    expect(referenceBadge({ stems: false, melody: false, key: false })).toBeNull();
    expect(referenceBadge({ stems: false, melody: true, key: false })?.label).toBe('Melody');
    expect(referenceBadge({ stems: true, melody: true, key: true })?.label).toBe('Melody');
    expect(referenceBadge({ stems: true, melody: false, key: false })?.label).toBe('Backing');
    expect(referenceBadge({ stems: true, melody: false, key: true })?.label).toBe('Key');
    expect(referenceBadge({ stems: false, melody: false, key: true })?.label).toBe('Key');
    expect(referenceBadge({ stems: false, melody: false, key: true })?.title).toMatch(/no melody/);
    for (const entry of [
      { stems: false, melody: true, key: false },
      { stems: false, melody: false, key: true },
      { stems: true, melody: false, key: false },
    ]) {
      expect(referenceBadge(entry)?.title).not.toMatch(/learning|score/i);
    }
  });

  it('says when a song was last played', () => {
    const now = 10 * 24 * 3_600_000;
    expect(playedLabel(null, now)).toBe('never played');
    expect(playedLabel(now - 5_000, now)).toBe('just now');
    expect(playedLabel(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(playedLabel(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(playedLabel(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(playedLabel(now - 4 * 24 * 3_600_000, now)).toBe('4 days ago');
  });
});

describe('rowOf', () => {
  it('puts source, length and last played in the meta line', () => {
    const view = rowOf(entry('a', { lastPlayedAt: 1000, stems: true }), 1000 + 60_000);
    expect(view.meta).toEqual(['Upload', '2:05', '1 min ago']);
    expect(view.badge?.label).toBe('Backing');
  });

  it('leaves out an unknown length', () => {
    const view = rowOf(
      entry('yt-aaaaaaaaaaa', { source: 'youtube', videoId: 'aaaaaaaaaaa', durationS: 0, lastPlayedAt: null }),
      5,
    );
    expect(view.meta).toEqual(['YouTube', 'never played']);
  });
});

describe('playlistPosition', () => {
  it('says "n of m" for a favorite and nothing for another song', () => {
    const entries = [entry('a', { favorite: true, order: 0 }), entry('b', { favorite: true, order: 1 }), entry('c')];
    expect(playlistPosition(entries, 'b')).toBe('2 of 2');
    expect(playlistPosition(entries, 'c')).toBe('');
    expect(playlistPosition(entries, null)).toBe('');
  });
});

describe('initialLibrary', () => {
  it('starts shut with auto-advance on and no playlist', () => {
    expect(initialLibrary()).toMatchObject({ open: false, autoAdvance: true, playlist: { active: false } });
  });
});
