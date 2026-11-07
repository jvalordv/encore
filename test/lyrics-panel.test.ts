/**
 * Tests for the lyrics panel (src/app/panels/lyrics.ts): the lane line reads
 * the raw position (as the lane does), is off by default on a karaoke track,
 * toggles with the checkbox, and the size cap guard is pure.
 */
import { describe, expect, it } from 'vitest';
import { LYRICS_MAX_BYTES, lyricsTooLarge, mountLyricsPanel } from '../src/app/panels/lyrics';
import { StateStore, initialState } from '../src/app/state';
import { LyricsController } from '../src/lyrics/controller';
import { memoryLyricsStore } from '../src/lyrics/store';
import { byTestId, fakeHost } from './fake-dom';

const LRC = '[00:01.00]First\n[00:03.00]Second\n';

describe('lyricsTooLarge', () => {
  it('rejects only sizes over 1 MB', () => {
    expect(lyricsTooLarge(LYRICS_MAX_BYTES)).toBe(false);
    expect(lyricsTooLarge(LYRICS_MAX_BYTES + 1)).toBe(true);
  });
});

describe('lyrics panel line', () => {
  async function setup(embed: boolean) {
    const store = new StateStore(initialState());
    const controller = new LyricsController(memoryLyricsStore(), {
      find: async () => ({ synced: LRC, plain: null, title: 'S', artist: 'A' }),
    });
    const host = fakeHost();
    const lineHost = fakeHost();
    mountLyricsPanel(host, { store, controller, lineHost });
    const song = { hash: 'h', name: 'A - S.mp3', durationS: 10 } as never;
    store.patch({ song, clock: embed ? 'embed' : 'engine', embedOffsetS: 0.5 });
    await controller.find();
    return { store, controller, host, lineHost };
  }
  it('uses the raw position even on the embed clock', async () => {
    const { store, lineHost } = await setup(true);
    store.patch({ positionS: 1.2 });
    expect(lineHost.hidden).toBe(false);
    expect(byTestId(lineHost, 'lyrics-now').textContent).toBe('First');
    // 3.2 s less the 0.5 s embed offset would still read First.
    store.patch({ positionS: 3.2 });
    expect(byTestId(lineHost, 'lyrics-now').textContent).toBe('Second');
  });

  it('shows by default off a karaoke track and hides with the checkbox', async () => {
    const { store, host, lineHost } = await setup(false);
    store.patch({ positionS: 3.2 });
    expect(lineHost.hidden).toBe(false);
    const box = byTestId(host, 'lyrics-shown');
    box.checked = false;
    box.fire('change');
    await Promise.resolve();
    expect(lineHost.hidden).toBe(true);
  });

  it('is hidden with no lyrics loaded', () => {
    const store = new StateStore(initialState());
    const lineHost = fakeHost();
    const controller = new LyricsController(memoryLyricsStore(), { find: async () => null });
    mountLyricsPanel(fakeHost(), { store, controller, lineHost });
    expect(lineHost.hidden).toBe(true);
  });
});
