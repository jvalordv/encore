/**
 * Tests for the fun extras' words and pictures: the chip, stars and
 * personal-best lines in each skin's voice (src/app/fun.ts), the card
 * layout's wrapping and positions and the saved file's name
 * (src/app/card-layout.ts), the PNG export where a canvas exists, and the
 * panels: the streak chip in both modes, the stars and flourish on the card
 * in learning mode only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TakeReport } from '../src/analysis/score';
import { CARD_FAILED, drawCard, renderCardPng } from '../src/app/card-image';
import { CARD_MARGIN, CARD_WIDTH, cardFileName, layoutCard, localDateString, wrapText } from '../src/app/card-layout';
import type { CardContent, Measure } from '../src/app/card-layout';
import { localDay } from '../src/analysis/streak';
import { personalBestText, starGlyphs, starsLineFor, starsText, streakChipText } from '../src/app/fun';
import { mountReportPanel } from '../src/app/panels/report';
import { mountStreakPanel } from '../src/app/panels/streak';
import { StateStore, initialState } from '../src/app/state';
import type { TakeSummary } from '../src/app/takes';
import { SKINS } from '../src/skins';
import { arcade } from '../src/skins/arcade';
import { dreamhouse } from '../src/skins/dreamhouse';
import { studio } from '../src/skins/studio';
import { byTestId, fakeHost } from './fake-dom';

/** Ten pixels per character, bold or not: wrapping is then exact. */
const tenPerChar: Measure = (text) => text.length * 10;

const content: CardContent = {
  title: 'Take report',
  songName: 'A Song',
  date: '2026-11-07',
  stars: '2 of 3 stars',
  personalBest: 'New personal best: in tune on the melody 80%, up from 70%.',
  headline: 'In tune: 80% of the notes you sang.',
  lines: ['Timing: on the beat.', 'Your range sits inside the song.'],
  skinName: 'encore, Studio skin',
};

describe('words per skin', () => {
  it('says the streak in the skin voice, singular and plural, with no judgement words', () => {
    expect(streakChipText([10, 11, 12], 12, studio)).toBe('3 days in a row');
    expect(streakChipText([12], 12, studio)).toBe('1 day in a row');
    expect(streakChipText([12], 12, arcade)).toBe('DAY 1 STREAK');
    expect(streakChipText([10, 11], 12, dreamhouse)).toBe('2 days in a row 💖');
    expect(streakChipText([5], 12, studio)).toBe('');
  });

  it('says stars and the personal best with both numbers', () => {
    expect(starsText(2, studio)).toBe('2 of 3 stars');
    expect(starsText(0, studio)).toBe('');
    expect(starGlyphs(2)).toBe('★★☆');
    const best = { measure: 'inTune', nowPercent: 82, wasPercent: 70 } as const;
    expect(personalBestText(best, studio)).toBe('New personal best: in tune on the melody 82%, up from 70%.');
    for (const skin of SKINS) expect(personalBestText(best, skin)).toContain('82%');
  });
});

describe('card layout', () => {
  it('hard-splits a word wider than the card so no line runs off', () => {
    const title = 'A'.repeat(23);
    const lines = wrapText(`${title} ok`, 50, 10, false, tenPerChar);
    expect(lines.join('')).toBe(`${title}ok`);
    for (const l of lines) expect(tenPerChar(l, 10, false)).toBeLessThanOrEqual(50);
    const laid = layoutCard({ ...content, songName: title }, tenPerChar);
    for (const item of laid.items) {
      expect(item.x + tenPerChar(item.text, item.size, item.bold)).toBeLessThanOrEqual(CARD_WIDTH - CARD_MARGIN);
    }
  });

  it('wraps to the width and splits a long word', () => {
    expect(wrapText('aa bb cc dd', 50, 10, false, tenPerChar)).toEqual(['aa bb', 'cc dd']);
    expect(wrapText('abcdefghijkl mm', 50, 10, false, tenPerChar)).toEqual(['abcde', 'fghij', 'kl mm']);
    expect(wrapText('', 50, 10, false, tenPerChar)).toEqual([]);
  });

  it('places every line inside the card, top to bottom, in order', () => {
    const layout = layoutCard(content, tenPerChar);
    expect(layout.width).toBe(CARD_WIDTH);
    expect(layout.items.map((i) => i.text).slice(0, 3)).toEqual(['Take report', 'A Song', '2026-11-07']);
    let last = 0;
    for (const item of layout.items) {
      expect(item.x).toBe(CARD_MARGIN);
      expect(item.y).toBeGreaterThan(last);
      expect(tenPerChar(item.text, item.size, item.bold)).toBeLessThanOrEqual(CARD_WIDTH - 2 * CARD_MARGIN);
      last = item.y;
    }
    expect(layout.height).toBeGreaterThan(last);
    expect(layout.items.some((i) => i.color === 'hit' && i.text.startsWith('New personal best'))).toBe(true);
  });

  it('leaves out stars and personal best when they are not due, and wraps long lines', () => {
    const plain = layoutCard({ ...content, stars: '', personalBest: '', lines: ['word '.repeat(60)] }, tenPerChar);
    expect(plain.items.some((i) => i.color === 'hit')).toBe(false);
    expect(plain.items.filter((i) => i.text.startsWith('word')).length).toBeGreaterThan(1);
  });

  it('names the file <song>-<date>-card.png', () => {
    expect(cardFileName('My Song (live).mp3', '2026-11-07')).toBe('My-Song-live-2026-11-07-card.png');
    expect(cardFileName('???', '2026-11-07')).toBe('song-2026-11-07-card.png');
    expect(localDateString(new Date(2026, 10, 7, 23, 59).getTime())).toBe('2026-11-07');
  });
});

describe('the stars line names its measure', () => {
  it('says which share the stars were earned on', () => {
    expect(starsLineFor(report(0.8), studio)).toBe('2 of 3 stars (in tune on the melody 80%)');
    const open = { ...report(0.5), style: 'open' as const, freestyle: { inKey: 19, offKey: 1, unclear: 0, passing: 0, offNotes: [], keyStatus: 'clear' as const }, noMelody: true };
    expect(starsLineFor(open, studio)).toBe('3 of 3 stars (on the melody or in key 95%)');
    expect(starsLineFor(report(0.3), studio)).toBe('');
  });
});

describe('saving the card without a silent failure', () => {
  const fake = {} as Document;
  it('gives the blob, and null for a null result or a rejection', async () => {
    const blob = new Blob(['x']);
    expect(await drawCard(async () => blob, fake, content)).toBe(blob);
    expect(await drawCard(async () => null, fake, content)).toBeNull();
    expect(await drawCard(() => Promise.reject(new Error('no')), fake, content)).toBeNull();
    expect(CARD_FAILED).toBe('Could not draw the card in this browser.');
  });
});

describe('card PNG export', () => {
  it('gives a PNG blob where a canvas exists, and null where none does', async () => {
    const hasCanvas = typeof document !== 'undefined' && document.createElement('canvas').getContext?.('2d') != null;
    if (!hasCanvas) {
      // Node has no canvas: the pure layout above is what is tested here, and
      // the end-to-end run checks the real PNG's signature.
      expect(typeof document).toBe('undefined');
      return;
    }
    const blob = await renderCardPng(document, content);
    expect(blob?.type).toBe('image/png');
  });
});

const report = (inTuneRate: number): TakeReport => ({
  notesCovered: 4,
  notesSung: 4,
  inTuneRate,
  frames: { hit: 0, okay: 0, miss: 0 },
  timingBiasS: null,
  notes: [],
  worstPhrases: [],
  songRange: { lowMidi: 60, highMidi: 72, highAtS: 1 },
  sungRange: { lowMidi: 60, highMidi: 72 },
});

const summary = (id: string, createdAt: number, r: TakeReport): TakeSummary => ({
  id,
  songHash: 'h1',
  songName: 'A Song.mp3',
  createdAt,
  durationS: 4,
  latencyS: 0,
  sampleRate: 48000,
  report: r,
});

describe('the report card panel', () => {
  const session = {
    seek: () => undefined,
    playTake: async () => undefined,
    findOriginal: () => undefined,
    showReport: () => undefined,
    setScoring: () => undefined,
    setPhraseFree: async () => undefined,
  };

  function mounted(mode: 'karaoke' | 'learning') {
    const store = new StateStore({
      ...initialState(),
      mode,
      takes: [summary('b', 2, report(0.82)), summary('a', 1, report(0.7))],
      reportTakeId: 'b',
    });
    const host = fakeHost();
    mountReportPanel(host, { store, session });
    return host;
  }

  it('shows stars, the personal-best line and Save card in learning mode', () => {
    const host = mounted('learning');
    expect(byTestId(host, 'report-stars').textContent).toBe('★★☆ 2 of 3 stars (in tune on the melody 82%)');
    expect(byTestId(host, 'report-pb').textContent).toContain('82%, up from 70%');
    expect(byTestId(host, 'report-save-card').textContent).toBe('Save card (.png)');
  });

  it('shows none of it in karaoke mode, where there is no card at all', () => {
    const host = mounted('karaoke');
    expect(host.byTestId('report-card')).toBeUndefined();
    expect(host.byTestId('report-stars')).toBeUndefined();
    expect(host.byTestId('report-pb')).toBeUndefined();
  });
});

describe('the streak chip panel', () => {
  it('redraws at local midnight and stops on dispose', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 7, 23, 59, 0));
      const today = localDay(Date.now());
      const store = new StateStore({ ...initialState(), library: { ...initialState().library, daysSung: [today] } });
      const host = fakeHost();
      const dispose = mountStreakPanel(host, { store });
      expect(host.textContent).toBe('1 day in a row');
      vi.advanceTimersByTime(3 * 86_400_000);
      expect(host.textContent).toBe('');
      expect(vi.getTimerCount()).toBe(1);
      dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const day = 86_400_000;

  it('shows the streak in both modes and hides without one', () => {
    // The chip counts local days, so the test must too (a UTC day is off by one near midnight).
    const today = localDay(Date.now());
    for (const mode of ['karaoke', 'learning'] as const) {
      const state = initialState();
      const store = new StateStore({ ...state, mode });
      const host = fakeHost();
      mountStreakPanel(host, { store });
      expect(host.hidden).toBe(true);
      store.patch({ library: { ...store.state.library, daysSung: [today - 1, today] } });
      expect(host.hidden).toBe(false);
      expect(host.textContent).toBe('2 days in a row');
    }
  });
});
