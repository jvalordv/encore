/**
 * Tests for the words around the two scoring styles, all pure: the karaoke-
 * track notice in Strict (unchanged, with the offer to switch) and in Open
 * (scored on the key, or why it cannot be), which card opens for which take,
 * and the report card's text for an Open take and for a Strict one with free
 * phrases: the share on the melody, the share of free notes in key, each note
 * off key with how far, and a plain word when the key was unclear or missing.
 */
import { describe, expect, it } from 'vitest';
import type { FreestyleReport, NoteResult, TakeReport } from '../src/analysis/score';
import {
  KARAOKE_TRACK_NOTICE,
  karaokeTrackNotice,
  openReport,
  openSwitchOffer,
  OPEN_SWITCH_OFFER,
  openTrackNotice,
  SCORING_CHOICES,
} from '../src/app/learning';
import { initialKey, keyStateOf, missingKey } from '../src/app/key-state';
import { describeReport, MAX_OFF_NOTES } from '../src/app/report';
import { initialState } from '../src/app/state';
import type { AppState } from '../src/app/state';
import type { TakeSummary } from '../src/app/takes';
import { gradeRuns } from '../src/render/pitch-lane';
import type { LaneFrame } from '../src/render/pitch-lane';

const stateWith = (fields: Partial<AppState>): AppState => ({ ...initialState(), ...fields });
const song = { name: 'tune.mp3', durationS: 100, hash: 'hash-file' };
const SKIPPED = {
  phase: 'skipped',
  notes: 0,
  message: 'No singing found: the vocal is audible in only 3% of this track.',
} as const;
const karaokeTrack = (fields: Partial<AppState> = {}): AppState =>
  stateWith({ song, reference: SKIPPED, mode: 'learning', ...fields });

describe('the karaoke-track notice', () => {
  it('is W3\'s sentence exactly in Strict, with the offer to switch to Open beside it', () => {
    expect(karaokeTrackNotice(karaokeTrack())).toBe(KARAOKE_TRACK_NOTICE);
    expect(openSwitchOffer(karaokeTrack())).toBe(OPEN_SWITCH_OFFER);
    expect(OPEN_SWITCH_OFFER).toBe("Switch to Open to be scored on the song's key instead.");
  });

  it('offers nothing in Open, in karaoke mode, or on a song with a singer', () => {
    expect(openSwitchOffer(karaokeTrack({ scoring: 'open' }))).toBeNull();
    expect(openSwitchOffer(karaokeTrack({ mode: 'karaoke' }))).toBeNull();
    expect(openSwitchOffer(stateWith({ song, mode: 'learning' }))).toBeNull();
  });

  it('is one plain line in Open saying the track is scored on its key', () => {
    const state = karaokeTrack({ scoring: 'open', key: keyStateOf({ tuning_cents: 0, segments: [
      { start_s: 0, end_s: 10, tonic: 0, mode: 'major', confidence: 0.9 },
    ] }) });
    const line = karaokeTrackNotice(state);
    expect(line).toBe("This is a karaoke track, so you're scored on the song's key: notes that fit it count as in key.");
    expect(line).not.toContain('\n');
  });

  it('says why when there is no key to score on', () => {
    const open = (key: AppState['key']) => karaokeTrackNotice(karaokeTrack({ scoring: 'open', key }));
    expect(open(keyStateOf({ tuning_cents: 0, segments: [
      { start_s: 0, end_s: 10, tonic: null, mode: null, confidence: 0.1 },
    ] }))).toContain('the service could not read its key');
    expect(open(missingKey('The service did not read this song\'s key.'))).toBe(
      "This is a karaoke track, and no key is available (The service did not read this song's key), " +
        "so you're judged on steadiness only.",
    );
    expect(open(initialKey())).toContain('not available yet');
    expect(openTrackNotice(initialKey())).toContain('judged on steadiness only');
  });

  it('is still silent in karaoke mode', () => {
    expect(karaokeTrackNotice(karaokeTrack({ scoring: 'open', mode: 'karaoke' }))).toBeNull();
  });
});

describe('which card opens', () => {
  const take = (style?: 'strict' | 'open'): TakeSummary => ({
    id: 'a',
    songHash: 'hash-file',
    songName: 'tune.mp3',
    createdAt: 1,
    durationS: 5,
    latencyS: 0,
    sampleRate: 44100,
    report: { notesCovered: 1, ...(style ? { style } : {}) } as TakeReport,
  });
  const base = (t: TakeSummary): Partial<AppState> => ({
    takes: [t],
    reportTakeId: 'a',
    mode: 'learning',
    song,
    reference: SKIPPED,
  });

  it('shows an Open take on a karaoke track, which Open scored', () => {
    expect(openReport(stateWith(base(take('open'))))?.take.id).toBe('a');
  });

  it('still hides a Strict take, or one with no style, on a karaoke track', () => {
    expect(openReport(stateWith(base(take('strict'))))).toBeNull();
    expect(openReport(stateWith(base(take())))).toBeNull();
  });

  it('shows nothing in karaoke mode, even for an Open take', () => {
    expect(openReport(stateWith({ ...base(take('open')), mode: 'karaoke' }))).toBeNull();
  });
});

describe('the style selector', () => {
  it('has Strict and Open, in that order', () => {
    expect(SCORING_CHOICES.map((c) => c.style)).toEqual(['strict', 'open']);
    expect(SCORING_CHOICES.map((c) => c.label)).toEqual(['Strict', 'Open']);
  });
});

const note = (index: number, fields: Partial<NoteResult> = {}): NoteResult => ({
  index,
  onsetS: 10 + index,
  offsetS: 11 + index,
  midi: 57,
  frames: 100,
  meanCents: 0,
  stdCents: null,
  scoopUpCents: null,
  onsetDeltaS: 0,
  heldRatio: 1,
  ...fields,
});

const block = (fields: Partial<FreestyleReport> = {}): FreestyleReport => ({
  inKey: 8,
  offKey: 2,
  unclear: 0,
  passing: 0,
  offNotes: [
    { onsetS: 70, offsetS: 70.5, midi: 61, centsOff: 80 },
    { onsetS: 20, offsetS: 20.5, midi: 66, centsOff: -100 },
  ],
  keyStatus: 'clear',
  ...fields,
});

function report(fields: Partial<TakeReport> = {}): TakeReport {
  const notes = [note(0), note(1)];
  return {
    notesCovered: 3,
    notesSung: 2,
    inTuneRate: 1,
    frames: { hit: 80, okay: 20, miss: 0 },
    timingBiasS: 0.01,
    notes,
    worstPhrases: [],
    songRange: { lowMidi: 50, highMidi: 71, highAtS: 40 },
    sungRange: { lowMidi: 52, highMidi: 69 },
    style: 'open',
    melodyShare: 0.6,
    freestyle: block(),
    ...fields,
  };
}

describe('the Open card', () => {
  const view = describeReport(report());

  it('says the share on the melody and the in-tune share with Open\'s window', () => {
    expect(view.style).toBe('open');
    expect(view.melodyShare).toBe('On the melody: 60% of the notes you sang.');
    expect(view.headline).toBe('In tune: 100% of the notes you sang on the melody were within 100 c.');
  });

  it('says the share of free notes in key', () => {
    expect(view.freestyle?.summary).toBe("Freestyle: 80% of your free notes were in the song's key (8 of 10).");
    expect(view.freestyle?.keyNote).toBe('');
  });

  it('lists each off-key note with how far off and where, the furthest first', () => {
    expect(view.freestyle?.offNotes.map((n) => n.text)).toEqual([
      'F#4 at 0:20: 100 c below G4, the nearest note of the key',
      'C#4 at 1:10: 80 c above C4, the nearest note of the key',
    ]);
    expect(view.freestyle?.offNotes.map((n) => n.atS)).toEqual([20, 70]);
  });

  it('caps the off-key list and counts the rest', () => {
    const many = Array.from({ length: MAX_OFF_NOTES + 2 }, (_, i) => ({
      onsetS: 5 + i,
      offsetS: 5.5 + i,
      midi: 61,
      centsOff: 60 + i,
    }));
    const long = describeReport(report({ freestyle: block({ offKey: many.length, offNotes: many }) }));
    expect(long.freestyle?.offNotes).toHaveLength(MAX_OFF_NOTES);
    expect(long.freestyle?.moreOff).toBe(2);
  });

  it('names an off-key note by its nearest scale tone, not the tone it was sung as', () => {
    const near = describeReport(
      report({ freestyle: block({ offNotes: [{ onsetS: 5, offsetS: 5.5, midi: 62.6, centsOff: 60 }] }) }),
    );
    expect(near.freestyle?.offNotes[0].text).toBe('D#4 at 0:05: 60 c above D4, the nearest note of the key');
  });

  it('measures a melody note off by 80 cents as fine, and one off by 120 as off, in Open', () => {
    const open = describeReport(report({ notes: [note(0, { meanCents: 80 }), note(1, { meanCents: 120 })] }));
    expect(open.offNotes.map((n) => n.text)).toEqual(['A3 at 0:11: 120 c sharp']);
    const strict = describeReport(report({ style: 'strict', notes: [note(0, { meanCents: 80 })] }));
    expect(strict.offNotes.map((n) => n.text)).toEqual(['A3 at 0:10: 80 c sharp']);
  });

  it('says nothing was on the melody, when it was not', () => {
    const none = describeReport(report({ inTuneRate: null, notesSung: 0, melodyShare: 0 }));
    expect(none.headline).toBe('No notes to compare: nothing you sang was on the melody in this take.');
  });
});

describe('the key was unclear or missing', () => {
  const text = (fields: Partial<FreestyleReport>): string | undefined =>
    describeReport(report({ freestyle: block(fields) })).freestyle?.keyNote;

  it('is silent when the key was clear', () => {
    expect(text({})).toBe('');
  });

  it('says so, and that those notes were judged on steadiness only', () => {
    expect(text({ keyStatus: 'unclear', inKey: 0, offKey: 0, unclear: 5, offNotes: [] })).toBe(
      "The song's key was unclear, so these notes were judged on steadiness only.",
    );
    expect(text({ keyStatus: 'none', inKey: 0, offKey: 0, unclear: 5, offNotes: [] })).toBe(
      'No key was available for this song, so these notes were judged on steadiness only.',
    );
    expect(text({ keyStatus: 'partly_unclear', unclear: 3 })).toBe(
      "The song's key was unclear in places, so the free notes there (3) were judged on steadiness only.",
    );
  });

  it('does not nag when there were no judged notes at all', () => {
    expect(text({ keyStatus: 'none', inKey: 0, offKey: 0, unclear: 0, passing: 2, offNotes: [] })).toBe('');
  });

  it('reports the free notes sung when none could be judged', () => {
    const view = describeReport(report({ freestyle: block({ inKey: 0, offKey: 0, unclear: 4, keyStatus: 'none', offNotes: [] }) }));
    expect(view.freestyle?.summary).toBe('Freestyle: 4 free notes sung.');
  });

  it('counts passing notes as not judged', () => {
    const view = describeReport(report({ freestyle: block({ passing: 3 }) }));
    expect(view.freestyle?.summary).toContain('3 passing notes under 150 ms were not judged.');
  });

  it('says plainly when nothing was sung off the melody', () => {
    const empty = { inKey: 0, offKey: 0, unclear: 0, passing: 0, offNotes: [] };
    expect(describeReport(report({ freestyle: block(empty) })).freestyle?.summary).toBe(
      'Freestyle: nothing was sung off the melody in this take.',
    );
    expect(describeReport(report({ style: 'strict', freestyle: block(empty) })).freestyle?.summary).toBe(
      'Freestyle: nothing was sung off the melody in the phrases you marked free.',
    );
  });
});

describe('a song with no melody', () => {
  const view = describeReport(report({ noMelody: true, melodyShare: 0, notes: [], inTuneRate: null, notesCovered: 0 }));

  it('says everything was judged against the key and leaves out the melody\'s lines', () => {
    expect(view.hasMelody).toBe(false);
    expect(view.headline).toBe(
      "This song has no melody to follow, so everything you sang was judged against the song's key.",
    );
    expect(view.coverage).toBe('');
    expect(view.range).toBe('');
    expect(view.melodyShare).toBe('');
    expect(view.freestyle?.summary).toContain('in the song\'s key');
  });
});

describe('a Strict card with free phrases', () => {
  const view = describeReport(
    report({
      style: 'strict',
      melodyShare: undefined,
      freeSpans: [
        [12, 20],
        [65, 72],
      ],
      worstPhrases: [{ first: 4, last: 6, startS: 30, endS: 37, meanAbsCents: 63.4, missShare: 0.52 }],
    }),
  );

  it('is W3\'s card with the freestyle block for the free phrases added', () => {
    expect(view.headline).toBe('In tune: 100% of the notes you sang were within 50 c.');
    expect(view.melodyShare).toBe('');
    expect(view.freestyle?.summary).toContain('80%');
  });

  it('lists the free phrases to unmark, and gives each worst phrase its span to mark', () => {
    expect(view.freePhrases.map((p) => [p.text, p.span])).toEqual([
      ['Free phrase 0:12 to 0:20', [12, 20]],
      ['Free phrase 1:05 to 1:12', [65, 72]],
    ]);
    expect(view.phraseSpans).toEqual([[30, 37]]);
  });

  it('has no freestyle block and no free rows on a plain Strict take', () => {
    const plain = describeReport(report({ style: 'strict', freestyle: undefined, melodyShare: undefined }));
    expect(plain.freestyle).toBeNull();
    expect(plain.freePhrases).toEqual([]);
  });
});

describe('a take stored before the styles existed', () => {
  it('reads as Strict with no freestyle block', () => {
    const old = report();
    delete old.style;
    delete old.melodyShare;
    delete old.freestyle;
    const view = describeReport(old);
    expect(view.style).toBe('strict');
    expect(view.melodyShare).toBe('');
    expect(view.freestyle).toBeNull();
    expect(view.headline).toBe('In tune: 100% of the notes you sang were within 50 c.');
  });
});

describe('free frames on the lane', () => {
  it('make a run of their own between hits and misses', () => {
    const frames: LaneFrame[] = (['hit', 'free', 'free', 'miss'] as const).map((grade, i) => ({
      t: i * 0.01,
      f0: 220,
      clarity: 0.9,
      grade,
    }));
    expect(gradeRuns(frames)).toEqual([
      { from: 0, to: 1, grade: 'hit' },
      { from: 1, to: 3, grade: 'free' },
      { from: 3, to: 3, grade: 'miss' },
    ]);
  });
});
