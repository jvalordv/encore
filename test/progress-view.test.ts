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
import type { FakeDocument, FakeElement } from './fake-dom';

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

const PROFILES = {
  list: [
    { id: 'p1', name: 'Ann', colour: null },
    { id: 'p2', name: 'Bo', colour: null },
  ],
  activeId: 'p1',
  secondId: null as string | null,
  legacyId: 'p1',
};

function fakeStore(mode: Mode) {
  const state = { mode, song: { hash: 'h1' }, profiles: { ...PROFILES }, library: { open: false }, ui: { progressSong: null as string | null } };
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
  const emit = (...keys: string[]): void => {
    for (const fn of subs) fn(state, new Set(keys));
  };
  return { store, set, subs, emit };
}

type Button = HTMLButtonElement & FakeElement;

/** The panel over a fake store, with the header button and the Settings button. */
function setup(mode: Mode, takes: TakeSummary[]) {
  const fake = fakeStore(mode);
  const host = fakeHost();
  const doc = host.ownerDocument as unknown as FakeDocument;
  const toggle = doc.createElement('button') as unknown as Button;
  const settingsToggle = doc.createElement('button') as unknown as Button;
  settingsToggle.setAttribute('aria-expanded', 'false');
  const calls = { list: 0, library: [] as boolean[], settingsClicks: 0 };
  settingsToggle.addEventListener('click', () => calls.settingsClicks++);
  const dispose = mountProgressPanel(host, {
    store: fake.store,
    session: {
      listAllTakes: () => {
        calls.list++;
        return Promise.resolve(takes);
      },
      setLibraryOpen: (open: boolean) => void calls.library.push(open),
      // The Session remembers the choice in state.ui and announces it.
      setUiChoices: (patch: { progressSong?: string | null }) => {
        if (patch.progressSong === undefined) return;
        const before = fake.store.state.ui.progressSong;
        (fake.store.state.ui as { progressSong: string | null }).progressSong = patch.progressSong;
        if (before !== patch.progressSong) fake.emit('ui');
      },
    },
    toggle,
    settingsToggle,
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  return { fake, host, doc, toggle, settingsToggle, calls, dispose, flush };
}

const esc = { key: 'Escape', defaultPrevented: false, preventDefault() {} };

describe('mountProgressPanel', () => {
  it('shows its button only in learning mode and opens with one point per take', async () => {
    const t = setup('karaoke', [strictTake('a', 0, 0.4, 1), strictTake('b', 1, 0.6, 1)]);
    expect(t.toggle.hidden).toBe(true);
    expect(t.host.hidden).toBe(true);

    t.fake.set('learning');
    expect(t.toggle.hidden).toBe(false);
    t.toggle.fire('click');
    expect(t.host.hidden).toBe(false);
    await t.flush();
    const row = byTestId(t.host, 'progress-row');
    expect(byTestId(row, 'progress-spark').dataset.points).toBe('2');
    expect(byTestId(t.host, 'progress-count').textContent).toContain('2 takes');
    expect(byTestId(t.host, 'progress-title').textContent).toBe('Progress: Ann');

    t.fake.set('karaoke');
    expect(t.toggle.hidden).toBe(true);
    expect(t.host.hidden).toBe(true);

    t.dispose();
    expect(t.fake.subs.size).toBe(0);
    expect(t.toggle.listenerCount()).toBe(0);
    expect(t.doc.listenerCount()).toBe(0);
  });

  it('loads once, redraws on a song change, and reloads only when the takes change', async () => {
    const t = setup('learning', [strictTake('a', 0, 0.4, 1), strictTake('b', 1, 0.6, 1, 'h2')]);
    t.toggle.fire('click');
    await t.flush();
    expect(t.calls.list).toBe(1);

    (t.fake.store.state as { song: { hash: string } }).song = { hash: 'h2' };
    t.fake.emit('song');
    await t.flush();
    expect(t.calls.list).toBe(1);

    t.toggle.fire('click');
    t.toggle.fire('click');
    await t.flush();
    expect(t.calls.list).toBe(1);

    t.fake.emit('takes');
    await t.flush();
    expect(t.calls.list).toBe(2);

    t.toggle.fire('click');
    t.fake.emit('takes');
    expect(t.calls.list).toBe(2);
    t.toggle.fire('click');
    await t.flush();
    expect(t.calls.list).toBe(3);
  });

  it('shows only the active singer takes and redraws when the singer changes', async () => {
    const mine = strictTake('a', 0, 0.4, 1);
    const old = strictTake('b', 1, 0.6, 1);
    const hers = { ...strictTake('c', 2, 0.8, 1), profileId: 'p2' };
    const t = setup('learning', [mine, old, hers]);
    t.toggle.fire('click');
    await t.flush();
    // Two takes with no profile belong to the first singer; the third is Bo's.
    expect(byTestId(t.host, 'progress-count').textContent).toContain('2 takes');

    const state = t.fake.store.state as { profiles: typeof PROFILES };
    state.profiles = { ...PROFILES, activeId: 'p2' };
    t.fake.emit('profiles');
    expect(byTestId(t.host, 'progress-title').textContent).toBe('Progress: Bo');
    await t.flush();
    expect(t.calls.list).toBe(2);
    expect(byTestId(t.host, 'progress-count').textContent).toContain('1 take ');

    // A singer with nothing yet sees an empty view that names them.
    state.profiles = { ...PROFILES, list: [...PROFILES.list, { id: 'p3', name: 'Cy', colour: null }], activeId: 'p3' };
    t.fake.emit('profiles');
    await t.flush();
    expect(byTestId(t.host, 'progress-count').textContent).toContain('No learning takes for Cy yet');
    expect(t.host.byTestId('progress-row')).toBeUndefined();
  });

  it('forgets the remembered song only when the singer really changes', async () => {
    const t = setup('learning', [strictTake('a', 0, 0.4, 1)]);
    const state = t.fake.store.state as { profiles: typeof PROFILES; ui: { progressSong: string | null } };
    state.ui.progressSong = 'h9';
    // A change to the list while the drawer is shut (a rename) keeps the choice.
    state.profiles = { ...PROFILES, list: [{ id: 'p1', name: 'Anna', colour: null }, PROFILES.list[1]] };
    t.fake.emit('profiles');
    expect(state.ui.progressSong).toBe('h9');
    state.profiles = { ...PROFILES, activeId: 'p2' };
    t.fake.emit('profiles');
    expect(state.ui.progressSong).toBeNull();
    // The drawer has not loaded since, but a later rename is not a switch.
    state.ui.progressSong = 'h8';
    state.profiles = { ...PROFILES, activeId: 'p2', list: [PROFILES.list[0], { id: 'p2', name: 'Bob', colour: null }] };
    t.fake.emit('profiles');
    expect(state.ui.progressSong).toBe('h8');
  });

  it('moves focus in, and closes with the x, Escape and a press outside', () => {
    const t = setup('learning', [strictTake('a', 0, 0.4, 1)]);
    const closeButton = byTestId(t.host, 'progress-close');
    const outside = t.doc.createElement('div');

    t.toggle.fire('click');
    expect(t.doc.activeElement).toBe(closeButton);
    expect(t.calls.library).toEqual([false]);

    // A press inside leaves it open.
    t.doc.dispatch('pointerdown', { target: closeButton });
    expect(t.host.hidden).toBe(false);

    // Escape closes it and returns focus to its button.
    t.doc.dispatch('keydown', esc);
    expect(t.host.hidden).toBe(true);
    expect(t.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(t.doc.activeElement).toBe(t.toggle);

    // The x does the same.
    t.toggle.fire('click');
    closeButton.fire('click');
    expect(t.host.hidden).toBe(true);
    expect(t.doc.activeElement).toBe(t.toggle);

    // A press outside closes it but leaves focus where the singer put it.
    t.toggle.fire('click');
    outside.focus();
    t.doc.dispatch('pointerdown', { target: outside });
    expect(t.host.hidden).toBe(true);
    expect(t.doc.activeElement).toBe(outside);

    // Closed, Escape does nothing.
    t.doc.dispatch('keydown', esc);
    expect(t.host.hidden).toBe(true);
  });

  it('gives way to the Settings and Library drawers when it opens, and they to it', () => {
    const t = setup('learning', []);
    t.settingsToggle.setAttribute('aria-expanded', 'true');
    t.toggle.fire('click');
    expect(t.calls.settingsClicks).toBe(1);
    expect(t.calls.library).toEqual([false]);

    (t.fake.store.state as { library: { open: boolean } }).library = { open: true };
    t.fake.emit('library');
    expect(t.host.hidden).toBe(true);
  });
});
