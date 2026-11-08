/**
 * Tests for the detail and tip of a replay item (src/app/replay-detail.ts):
 * the detail line carries every measured trait and omits the unmeasured,
 * the lyric is quoted from the synced lines, and the tip follows the dominant
 * measured problem at its named thresholds. Also that describeVoice and
 * describeReport attach them to the worst notes and worst phrases.
 */
import { describe, expect, it } from 'vitest';
import { SCORING_STYLES } from '../src/analysis/score';
import { TIP_THRESHOLDS } from '../src/coach/tips';
import type { NoteResult, PhraseResult, TakeReport } from '../src/analysis/score';
import type { VoiceNote } from '../src/analysis/voice';
import { measureVoice } from '../src/analysis/voice';
import { momentTexts } from '../src/app/panels/voice-block';
import { describeReport } from '../src/app/report';
import {
  lyricQuote,
  MAX_LYRIC_CHARS,
  measurePhrase,
  phraseDetail,
  phraseTip,
  REPLAY_TIP_THRESHOLDS as T,
  voiceNoteDetail,
  voiceNoteTip,
} from '../src/app/replay-detail';
import { describeVoice } from '../src/app/voice-report';

const LINES = [
  { t: 1, text: 'First line' },
  { t: 5, text: '' },
  { t: 6, text: 'Second line' },
];

function voiceNote(over: Partial<VoiceNote> = {}): VoiceNote {
  return {
    onsetS: 12,
    offsetS: 12.8,
    midi: 71.6,
    centsOff: -40,
    stdCents: null,
    scoopCents: null,
    driftCps: null,
    vibrato: null,
    ...over,
  };
}

describe('lyricQuote', () => {
  it('quotes the line sung at the time, and nothing before, in a break or with no lyrics', () => {
    expect(lyricQuote(LINES, 2)).toBe('“First line”');
    expect(lyricQuote(LINES, 6.5)).toBe('“Second line”');
    expect(lyricQuote(LINES, 0.5)).toBe('');
    expect(lyricQuote(LINES, 5.5)).toBe('');
    expect(lyricQuote([], 2)).toBe('');
    expect(lyricQuote(undefined, 2)).toBe('');
  });

  it('cuts a long line', () => {
    const quote = lyricQuote([{ t: 0, text: 'la '.repeat(100) }], 1);
    expect(quote.length).toBe(MAX_LYRIC_CHARS + 2);
    expect(quote.endsWith('…”')).toBe(true);
  });
});

describe('voiceNoteDetail', () => {
  it('says what was sung against the tone, how far, and how long, with nothing unmeasured', () => {
    const text = voiceNoteDetail(voiceNote(), 'song_key', '');
    expect(text).toBe("sang C5 against the tone of the song's key C5: 40 c flat; held 0.8 s.");
  });

  it('adds each measured trait with its number and direction', () => {
    const note = voiceNote({
      stdCents: 22.4,
      scoopCents: 31,
      driftCps: -18,
      vibrato: { rateHz: 5.46, extentCents: 47.2, regularity: 0.8 },
    });
    const text = voiceNoteDetail(note, 'estimated_key', '“First line”');
    expect(text).toBe(
      '“First line”; sang C5 against the tone of the estimated key C5: 40 c flat; held 0.8 s; spread 22 c; ' +
        'first 150 ms 31 c under the rest; drift 18 c/s flat; vibrato 5.5 Hz, 47 c either side.',
    );
  });

  it('says over for a scoop from above and sharp for rising drift', () => {
    const text = voiceNoteDetail(voiceNote({ centsOff: 30, scoopCents: -12, driftCps: 9 }), 'chromatic', '');
    expect(text).toContain('nearest semitone');
    expect(text).toContain('30 c sharp');
    expect(text).toContain('12 c over the rest');
    expect(text).toContain('9 c/s sharp');
  });
});

describe('voiceNoteTip', () => {
  it('names the scoop when it is the dominant problem, at its threshold', () => {
    expect(voiceNoteTip(voiceNote({ scoopCents: T.scoopCents }))).toMatch(/^Start on the note, not below it/);
    expect(voiceNoteTip(voiceNote({ scoopCents: -T.scoopCents }))).toMatch(/^Start on the note, not above it/);
  });

  it('falls back to the pitch tip just under every threshold', () => {
    const under = voiceNote({
      scoopCents: T.scoopCents - 1,
      driftCps: T.driftCps - 1,
      stdCents: T.wobbleCents - 1,
      vibrato: { rateHz: 5, extentCents: T.vibratoWideCents - 1, regularity: 1 },
    });
    expect(voiceNoteTip(under)).toBe('You landed under the tone. Aim slightly above where it feels right.');
    expect(voiceNoteTip({ ...under, centsOff: 40 })).toBe('You landed above the tone. Relax the push on the onset.');
  });

  it('picks the measure furthest past its threshold', () => {
    const note = voiceNote({ scoopCents: T.scoopCents * 1.2, driftCps: T.driftCps * 2 });
    expect(voiceNoteTip(note)).toMatch(/crept up/);
    expect(voiceNoteTip({ ...note, driftCps: -T.driftCps * 2 })).toMatch(/sagged/);
  });

  it('names a wobble and a wide vibrato', () => {
    expect(voiceNoteTip(voiceNote({ stdCents: T.wobbleCents * 2 }))).toMatch(/wobbled/);
    const wide = voiceNote({ vibrato: { rateHz: 5, extentCents: T.vibratoWideCents * 2, regularity: 1 } });
    expect(voiceNoteTip(wide)).toMatch(/vibrato swings wide/);
  });

  it('names a far-off note by its direction', () => {
    expect(voiceNoteTip(voiceNote({ centsOff: -T.farCents * 2 }))).toMatch(/under the tone/);
    expect(voiceNoteTip(voiceNote({ centsOff: T.farCents * 2 }))).toMatch(/above the tone/);
  });
});

function noteResult(index: number, over: Partial<NoteResult> = {}): NoteResult {
  return {
    index,
    onsetS: index,
    offsetS: index + 0.8,
    midi: 60,
    frames: 50,
    meanCents: 0,
    stdCents: null,
    scoopUpCents: null,
    onsetDeltaS: null,
    heldRatio: null,
    ...over,
  };
}

const PHRASE: PhraseResult = {
  first: 1,
  last: 3,
  startS: 61,
  endS: 66.5,
  meanAbsCents: 41.6,
  missShare: 0.3,
  hitShare: 0.4,
};

describe('measurePhrase and phraseDetail', () => {
  const notes = [
    noteResult(0, { meanCents: 90 }),
    noteResult(1, { meanCents: -40, onsetDeltaS: -0.2, scoopUpCents: 50 }),
    noteResult(2, { meanCents: -20, onsetDeltaS: -0.1 }),
    noteResult(3, { meanCents: null }),
    noteResult(4, { meanCents: 70 }),
  ];

  it('takes the medians of the notes inside the phrase only', () => {
    expect(measurePhrase(PHRASE, notes)).toEqual({
      biasCents: -30,
      timingS: -0.15000000000000002,
      scoopCents: 50,
      sung: 2,
      of: 3,
    });
  });

  it('words the time, lyric, shares, error and each measured trait', () => {
    const text = phraseDetail(PHRASE, measurePhrase(PHRASE, notes), '“Second line”');
    expect(text).toBe(
      '“Second line”; 1:01 to 1:06, 5.5 s; 40% of frames on target, 30% close, 30% off; 42 c off on average; ' +
        'median note 30 c flat; median entry 150 ms early; first 150 ms 50 c under the rest; 2 of 3 notes sung.',
    );
  });

  it('leaves out what was not measured, and an old take without hit share', () => {
    const bare = { biasCents: null, timingS: null, scoopCents: null, sung: 0, of: 3 };
    const { hitShare: _unused, ...old } = PHRASE;
    const text = phraseDetail(old, bare, '');
    expect(text).toBe('1:01 to 1:06, 5.5 s; 30% of frames off; 42 c off on average; 0 of 3 notes sung.');
  });
});

describe('phraseTip', () => {
  const none = { biasCents: null, timingS: null, scoopCents: null, sung: 3, of: 3 };
  const lateS = SCORING_STYLES.strict.timingTipS;

  it('names late and early entries at the style timing limit', () => {
    expect(phraseTip({ ...none, timingS: lateS })).toMatch(/behind the beat/);
    expect(phraseTip({ ...none, timingS: -lateS })).toMatch(/ahead of the beat/);
    expect(phraseTip({ ...none, timingS: lateS }, 'open')).toBeUndefined();
    expect(phraseTip({ ...none, timingS: SCORING_STYLES.open.timingTipS }, 'open')).toMatch(/behind the beat/);
  });

  it('names a lean and a scoop at their thresholds', () => {
    expect(phraseTip({ ...none, biasCents: -T.phraseBiasCents })).toMatch(/under the notes/);
    expect(phraseTip({ ...none, biasCents: T.phraseBiasCents })).toMatch(/above the notes/);
    expect(phraseTip({ ...none, scoopCents: T.phraseScoopCents })).toMatch(/not below it/);
    expect(phraseTip({ ...none, scoopCents: -T.phraseScoopCents })).toMatch(/not above it/);
  });

  it('prefers the measure furthest past its threshold', () => {
    expect(phraseTip({ ...none, timingS: lateS * 1.1, biasCents: T.phraseBiasCents * 3 })).toMatch(/above/);
  });

  it('gives no tip when no measure reaches its threshold, or nothing was measured', () => {
    expect(phraseTip({ ...none, timingS: lateS * 0.9, biasCents: -(T.phraseBiasCents - 1) })).toBeUndefined();
    expect(phraseTip(none)).toBeUndefined();
  });

  it('shares its numbers with the take-level tips table', () => {
    expect(T.scoopCents).toBe(TIP_THRESHOLDS.scoopCents);
    expect(T.driftCps).toBe(TIP_THRESHOLDS.driftCps);
  });
});

describe('momentTexts', () => {
  const view = { text: 'a', atS: 0, detail: 'numbers', tip: 'advice' };
  const doc = { createElement: () => ({ dataset: {}, className: '', textContent: '' }) } as unknown as Document;

  it('always shows the measured detail but the tip only when asked for', () => {
    const ids = (show: boolean): string[] =>
      momentTexts(doc, view, show).map((n) => n.dataset.testid ?? 'summary');
    expect(ids(false)).toEqual(['summary', 'report-moment-detail']);
    expect(ids(true)).toEqual(['summary', 'report-moment-detail', 'report-moment-tip']);
  });
});

describe('the replay items on the card', () => {
  const midiToHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

  it('gives each worst note of the voice a detail line with its lyric, and a tip', () => {
    const frames: Array<{ t: number; f0: number }> = [];
    let t = 0;
    for (const midi of [60, 64, 67.4, 72]) {
      for (let i = 0; i < 80; i++) frames.push({ t: t + i * 0.01, f0: midiToHz(midi) });
      t += 0.8;
      for (let i = 0; i < 12; i++) frames.push({ t: t + i * 0.01, f0: 0 });
      t += 0.12;
    }
    const lines = [{ t: 0, text: 'Hello there' }];
    const view = describeVoice(measureVoice(frames, null), lines);
    expect(view.worstNotes).toHaveLength(1);
    const [row] = view.worstNotes;
    expect(row.detail).toMatch(/^“Hello there”; sang G4 against the nearest semitone G4: 40 c sharp; held 0\.8 s/);
    expect(row.detail).toContain('spread 0 c; first 150 ms level with the rest; drift 0 c/s.');
    expect(row.tip).toBeTruthy();
    expect(describeVoice(measureVoice(frames, null)).worstNotes[0].detail).not.toContain('“');
  });

  it('gives each worst phrase of a Strict card a detail line and a tip', () => {
    const report = {
      style: 'strict',
      notesCovered: 3,
      notesSung: 3,
      inTuneRate: 0.5,
      frames: { hit: 1, okay: 1, miss: 1 },
      timingBiasS: null,
      notes: [noteResult(1, { meanCents: -40 }), noteResult(2, { meanCents: -50 }), noteResult(3, { meanCents: -60 })],
      worstPhrases: [PHRASE],
      songRange: { lowMidi: 55, highMidi: 70 },
      sungRange: null,
    } as unknown as TakeReport;
    const view = describeReport(report, LINES);
    expect(view.phrases[0].text).toMatch(/^1:01 to 1:06: 42 c off on average/);
    expect(view.phrases[0].detail).toContain('“Second line”');
    expect(view.phrases[0].tip).toMatch(/under the notes/);
  });
});
