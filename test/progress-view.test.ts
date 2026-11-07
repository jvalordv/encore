/**
 * Tests for the Progress view's words (src/app/progress.ts) and panel
 * (src/app/panels/progress.ts): units and signs, the direction lines, the
 * honest trend wording, the song picker, and the panel's visibility in the
 * two modes.
 */
import { describe, expect, it } from 'vitest';
import { takePoints } from '../src/analysis/progress';
import type { TakeReport } from '../src/analysis/score';
import { mountProgressPanel } from '../src/app/panels/progress';
import { ALL_SONGS, defaultSong, formatValue, MEASURES, progressRows, songChoices } from '../src/app/progress';
import type { StateStore } from '../src/app/state';
import type { TakeSummary } from '../src/app/takes';
import { byTestId, fakeHost } from './fake-dom';
import type { FakeElement } from './fake-dom';

const DAY = 86_400_000;
const T0 = new Date(2026, 10, 1, 12).getTime();

function strictTake(
  id: string,
  dayIndex: number,
  rate: number,
  bias: number,
  hash = 'h1',
  reference = 'chromatic',
): TakeSummary {
  const report = {
    notesCovered: 1,
    notesSung: 1,
    inTuneRate: rate,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange: { lowMidi: 60, highMidi: 72, highAtS: 0 },
    sungRange: { lowMidi: 57, highMidi: 69 },
    voice: { reference, summary: { biasCents: bias, within25: rate / 2, within50: rate } },
  } as unknown as TakeReport;
  return {
    id,
    songHash: hash,
    songName: hash === 'h1' ? 'First' : 'Second',
    createdAt: T0 + dayIndex * DAY,
    durationS: 10,
    latencyS: 0,
    sampleRate: 48000,
    report,
  };
}

const spec = (id: string) => {
  const found = MEASURES.find((m) => m.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe('formatValue', () => {
  it('shows shares as percent and changes as points, bias with a sign', () => {
    expect(formatValue(spec('inTune'), 0.667)).toBe('67%');
    expect(formatValue(spec('inTune'), 0.1, true)).toBe('+10 points');
    expect(formatValue(spec('bias'), 12.4)).toBe('+12 c');
    expect(formatValue(spec('bias'), -7)).toBe('-7 c');
    expect(formatValue(spec('bias'), 0.2)).toBe('0 c');
    expect(formatValue(spec('vibratoRate'), 5.46)).toBe('+5.5 Hz');
  });
});

describe('progressRows', () => {
  const takes = [strictTake('a', 0, 0.4, 10), strictTake('b', 3, 0.5, 6), strictTake('c', 10, 0.8, 2)];
  const points = takePoints(takes);

  it('has a row per measure present, with what the direction means', () => {
    const rows = progressRows(points, null);
    const bias = rows.find((r) => r.key === 'bias-chromatic');
    expect(bias?.qualifier).toBe('against the nearest semitone');
    expect(bias?.meaning).toContain('Closer to 0 c is better');
    expect(bias?.latest).toBe('+2 c');
    expect(bias?.best).toBe('+2 c');
    expect(rows.find((r) => r.key === 'inTune-strict')?.change).toBe('+35 points');
    expect(rows.find((r) => r.key === 'inTune-open')).toBeUndefined();
    expect(rows.find((r) => r.key === 'rangeWidth')?.latest).toBe('A3 to A4');
  });

  it('says plainly when a trend rests on few takes or too few takes', () => {
    const three = progressRows(points, null).find((r) => r.key === 'inTune-strict');
    expect(three?.trend).toMatch(/Rising about .* a week over 3 takes, the better way\. Only 3 takes/);
    const two = progressRows(points.slice(0, 2), null).find((r) => r.key === 'inTune-strict');
    expect(two?.trend).toMatch(/Not enough takes for a trend yet/);
    const bias = progressRows(points, null).find((r) => r.key === 'bias-chromatic');
    expect(bias?.trend).toContain('toward 0');
  });

  it('limits to one song', () => {
    const both = takePoints([...takes, strictTake('d', 1, 0.1, 0, 'h2')]);
    expect(progressRows(both, 'h2').find((r) => r.key === 'inTune-strict')?.takes).toBe(1);
    expect(progressRows(both, null).find((r) => r.key === 'inTune-strict')?.takes).toBe(4);
  });
});

describe('references in rows', () => {
  it('splits within 25, within 50 and bias by reference, one series otherwise', () => {
    const mixed = takePoints([
      strictTake('a', 0, 0.4, 10, 'h1', 'song_key'),
      strictTake('b', 1, 0.5, 6, 'h1', 'chromatic'),
      strictTake('c', 2, 0.6, 2, 'h1', 'song_key'),
    ]);
    const rows = progressRows(mixed, null);
    for (const id of ['within25', 'within50', 'bias']) {
      expect(rows.find((r) => r.key === id)).toBeUndefined();
      expect(rows.find((r) => r.key === `${id}-song_key`)?.takes).toBe(2);
      expect(rows.find((r) => r.key === `${id}-chromatic`)?.takes).toBe(1);
      expect(rows.find((r) => r.key === `${id}-estimated_key`)).toBeUndefined();
    }
    expect(rows.find((r) => r.key === 'bias-song_key')?.qualifier).toBe("against the song's key");
    // Held-note steadiness-type measures stay one series (range here).
    expect(rows.find((r) => r.key === 'rangeWidth')?.takes).toBe(3);
  });
});

describe('song picker', () => {
  const points = takePoints([strictTake('a', 0, 0.4, 1), strictTake('b', 1, 0.5, 1, 'h2')]);

  it('leads with all songs, then this song, then the rest', () => {
    const choices = songChoices(points, 'h1');
    expect(choices.map((c) => c.value)).toEqual([ALL_SONGS, 'h1', 'h2']);
    expect(choices[1].label).toContain('This song: First');
  });

  it('defaults to the loaded song when it has takes, else all songs', () => {
    expect(defaultSong(points, 'h2')).toBe('h2');
    expect(defaultSong(points, 'zzz')).toBe(ALL_SONGS);
    expect(defaultSong(points, null)).toBe(ALL_SONGS);
  });
});

type Mode = 'karaoke' | 'learning';
type Listener = (state: unknown, changed: Set<string>) => void;

function fakeStore(mode: Mode) {
  const state = { mode, song: { hash: 'h1' } };
  const subs = new Set<Listener>();
  const store = {
    state,
    subscribe: (fn: Listener) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  } as unknown as StateStore;
  const set = (m: Mode): void => {
    state.mode = m;
    for (const fn of subs) fn(state, new Set(['mode']));
  };
  return { store, set, subs };
}

describe('mountProgressPanel', () => {
  it('shows its button only in learning mode and opens with one point per take', async () => {
    const fake = fakeStore('karaoke');
    const host = fakeHost();
    const toggle = host.ownerDocument.createElement('button') as unknown as HTMLButtonElement & FakeElement;
    const takes = [strictTake('a', 0, 0.4, 1), strictTake('b', 1, 0.6, 1)];
    const dispose = mountProgressPanel(host, {
      store: fake.store,
      session: { listAllTakes: () => Promise.resolve(takes) },
      toggle,
    });
    expect(toggle.hidden).toBe(true);
    expect(host.hidden).toBe(true);

    fake.set('learning');
    expect(toggle.hidden).toBe(false);
    toggle.fire('click');
    expect(host.hidden).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    const row = byTestId(host, 'progress-row');
    expect(byTestId(row, 'progress-spark').dataset.points).toBe('2');
    expect(byTestId(host, 'progress-count').textContent).toContain('2 takes');

    fake.set('karaoke');
    expect(toggle.hidden).toBe(true);
    expect(host.hidden).toBe(true);

    dispose();
    expect(fake.subs.size).toBe(0);
    expect(toggle.listenerCount()).toBe(0);
  });

  it('loads once, redraws on a song change, and reloads only when the takes change', async () => {
    const fake = fakeStore('learning');
    const host = fakeHost();
    const toggle = host.ownerDocument.createElement('button') as unknown as HTMLButtonElement & FakeElement;
    let calls = 0;
    const takes = [strictTake('a', 0, 0.4, 1), strictTake('b', 1, 0.6, 1, 'h2')];
    mountProgressPanel(host, {
      store: fake.store,
      session: {
        listAllTakes: () => {
          calls++;
          return Promise.resolve(takes);
        },
      },
      toggle,
    });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    const emit = (...keys: string[]): void => {
      for (const fn of fake.subs) fn(fake.store.state, new Set(keys));
    };
    toggle.fire('click');
    await flush();
    expect(calls).toBe(1);

    (fake.store.state as { song: { hash: string } }).song = { hash: 'h2' };
    emit('song');
    await flush();
    expect(calls).toBe(1);

    toggle.fire('click');
    toggle.fire('click');
    await flush();
    expect(calls).toBe(1);

    emit('takes');
    await flush();
    expect(calls).toBe(2);

    toggle.fire('click');
    emit('takes');
    expect(calls).toBe(2);
    toggle.fire('click');
    await flush();
    expect(calls).toBe(3);
  });
});
