/**
 * Tests for the pure side of learning mode's screen: the karaoke-track rule
 * and its notice, which card is open, the report card's sentences, and the
 * grade runs the lane paints. Nothing here needs a page.
 */
import { describe, expect, it } from 'vitest';
import type { NoteResult, TakeReport } from '../src/analysis/score';
import {
  isKaraokeTrack,
  karaokeTrackNotice,
  KARAOKE_TRACK_NOTICE,
  openReport,
  originalQueryFor,
} from '../src/app/learning';
import { skippedForNoVocal } from '../src/app/reference';
import { describeReport, jumpTarget, MAX_OFF_NOTES } from '../src/app/report';
import { initialState } from '../src/app/state';
import type { AppState } from '../src/app/state';
import type { TakeSummary } from '../src/app/takes';
import { FrameRing, gradeRuns } from '../src/render/pitch-lane';
import type { LaneFrame } from '../src/render/pitch-lane';

const SKIPPED_NO_VOCAL = {
  phase: 'skipped',
  notes: 0,
  message: 'No singing found: the vocal is audible in only 3% of this track.',
} as const;

function stateWith(fields: Partial<AppState>): AppState {
  return { ...initialState(), ...fields };
}

const song = (hash: string, name = 'tune.mp3') => ({ name, durationS: 100, hash });
const picked = (kind: 'karaoke' | 'original') => ({
  videoId: 'abc',
  title: 'Hello (Karaoke Version)',
  channel: 'Sing King',
  kind,
});

describe('the karaoke-track rule', () => {
  it('knows a track the service found no singer in', () => {
    expect(skippedForNoVocal(SKIPPED_NO_VOCAL)).toBe(true);
    expect(skippedForNoVocal({ phase: 'skipped', notes: 0, message: 'No melody found: nothing steady.' })).toBe(false);
    expect(skippedForNoVocal({ phase: 'failed', notes: 0, message: SKIPPED_NO_VOCAL.message })).toBe(false);
  });

  it('is true for a picked result with the Karaoke badge, for that song only', () => {
    const base = { pickedResult: picked('karaoke') };
    expect(isKaraokeTrack(stateWith({ ...base, song: song('yt-abc') }))).toBe(true);
    expect(isKaraokeTrack(stateWith({ ...base, song: song('yt-other') }))).toBe(false);
    expect(isKaraokeTrack(stateWith({ pickedResult: picked('original'), song: song('yt-abc') }))).toBe(false);
    expect(isKaraokeTrack(stateWith({ ...base, song: null }))).toBe(false);
  });

  it('is true for a song whose reference was skipped for want of a singer', () => {
    expect(isKaraokeTrack(stateWith({ song: song('hash-file'), reference: SKIPPED_NO_VOCAL }))).toBe(true);
    expect(isKaraokeTrack(stateWith({ song: song('hash-file') }))).toBe(false);
  });

  it('says so, verbatim, in learning mode and only there', () => {
    expect(KARAOKE_TRACK_NOTICE).toBe(
      "Learning mode compares your singing with the original singer's. This is a karaoke track, " +
        "so there is no singer in it to compare against: you're on your own for this one.",
    );
    const s = stateWith({ song: song('hash-file'), reference: SKIPPED_NO_VOCAL, mode: 'learning' });
    expect(karaokeTrackNotice(s)).toBe(KARAOKE_TRACK_NOTICE);
    expect(karaokeTrackNotice({ ...s, mode: 'karaoke' })).toBeNull();
    expect(karaokeTrackNotice(stateWith({ song: song('hash-file'), mode: 'learning' }))).toBeNull();
  });

  it('searches for the original from the picked result, else from the file name', () => {
    expect(originalQueryFor(stateWith({ song: song('yt-abc'), pickedResult: picked('karaoke') }))).toEqual({
      title: 'Hello (Karaoke Version)',
      channel: 'Sing King',
    });
    expect(originalQueryFor(stateWith({ song: song('hash', 'My Song.mp3') }))).toEqual({
      title: 'My Song',
      channel: '',
    });
    expect(originalQueryFor(stateWith({ song: song('hash', 'My.Song.v2.flac') })).title).toBe('My.Song.v2');
  });
});

describe('which report card is open', () => {
  const report = { notesCovered: 1 } as TakeReport;
  const take = (id: string, withReport = true): TakeSummary => ({
    id,
    songHash: 'hash',
    songName: 'tune.mp3',
    createdAt: 1,
    durationS: 5,
    latencyS: 0,
    sampleRate: 44100,
    ...(withReport ? { report } : {}),
  });
  const base: Partial<AppState> = {
    song: song('hash'),
    takes: [take('a'), take('b', false)],
    reportTakeId: 'a',
    mode: 'learning',
  };

  it('shows the chosen take\'s report in learning mode', () => {
    expect(openReport(stateWith({ ...base }))?.take.id).toBe('a');
  });

  it('shows none in karaoke mode, even for a take that has a report', () => {
    expect(openReport(stateWith({ ...base, mode: 'karaoke' }))).toBeNull();
  });

  it('shows none for a take without one, none chosen, or a karaoke track', () => {
    expect(openReport(stateWith({ ...base, reportTakeId: 'b' }))).toBeNull();
    expect(openReport(stateWith({ ...base, reportTakeId: null }))).toBeNull();
    expect(openReport(stateWith({ ...base, reference: SKIPPED_NO_VOCAL }))).toBeNull();
  });
});

function noteResult(index: number, fields: Partial<NoteResult> = {}): NoteResult {
  return {
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
  };
}

function reportOf(notes: NoteResult[], fields: Partial<TakeReport> = {}): TakeReport {
  return {
    notesCovered: notes.length,
    notesSung: notes.length,
    inTuneRate: 0.714,
    frames: { hit: 60, okay: 25, miss: 15 },
    timingBiasS: 0.08,
    notes,
    worstPhrases: [],
    songRange: { lowMidi: 50, highMidi: 71, highAtS: 40 },
    sungRange: { lowMidi: 52, highMidi: 69 },
    ...fields,
  };
}

describe('describeReport', () => {
  it('states the in-tune share, the coverage and the frame grades', () => {
    const view = describeReport(reportOf([noteResult(0), noteResult(1)], { notesCovered: 4 }));
    expect(view.headline).toBe('In tune: 71% of the notes you sang were within 50 c.');
    expect(view.coverage).toBe('You sang 2 of the 4 melody notes this take covers.');
    expect(view.frames).toBe('Frame by frame: 60% on target, 25% close, 15% off.');
  });

  it('says plainly when nothing was sung over the melody', () => {
    const view = describeReport(reportOf([], { inTuneRate: null, notesSung: 0, frames: { hit: 0, okay: 0, miss: 0 } }));
    expect(view.headline).toBe('No notes to compare: nothing was sung over the melody in this take.');
    expect(view.frames).toBe('');
  });

  it('lists the off notes with which way and how far, worst first, and leaves out the rest', () => {
    const notes = [
      noteResult(0, { meanCents: -70, onsetDeltaS: 0.2 }),
      noteResult(1, { meanCents: 30 }),
      noteResult(2, { meanCents: 120, midi: 62 }),
      noteResult(3, { onsetDeltaS: -0.4 }),
      noteResult(4, { meanCents: -50 }),
      noteResult(5, { meanCents: 50.4 }),
    ];
    const view = describeReport(reportOf(notes));
    expect(view.offNotes.map((n) => n.text)).toEqual([
      'A3 at 0:13: 400 ms early',
      'D4 at 0:12: 120 c sharp',
      'A3 at 0:10: 70 c flat, 200 ms late',
      'A3 at 0:15: 50 c sharp',
    ]);
    expect(view.offNotes.map((n) => n.atS)).toEqual([13, 12, 10, 15]);
    expect(view.moreOff).toBe(0);
  });

  it('counts off notes beyond the ones it lists', () => {
    const notes = Array.from({ length: MAX_OFF_NOTES + 3 }, (_, i) => noteResult(i, { meanCents: 60 + i }));
    const view = describeReport(reportOf(notes));
    expect(view.offNotes).toHaveLength(MAX_OFF_NOTES);
    expect(view.moreOff).toBe(3);
    expect(view.offNotes[0].text).toContain('68 c sharp');
  });

  it('says early or late in milliseconds, or on the beat', () => {
    expect(describeReport(reportOf([], { timingBiasS: 0.0824 })).timing).toBe(
      'Timing: you came in late, a median of 82 ms.',
    );
    expect(describeReport(reportOf([], { timingBiasS: -0.1 })).timing).toBe(
      'Timing: you came in early, a median of 100 ms.',
    );
    expect(describeReport(reportOf([], { timingBiasS: 0.01 })).timing).toBe('Timing: on the beat (median 10 ms late).');
    expect(describeReport(reportOf([], { timingBiasS: null })).timing).toBe(
      'Timing: too few notes were matched to say.',
    );
  });

  it('names the worst phrases with where they are, and says when none stood out', () => {
    const view = describeReport(
      reportOf([], {
        worstPhrases: [{ first: 4, last: 6, startS: 65, endS: 72, meanAbsCents: 63.4, missShare: 0.52 }],
      }),
    );
    expect(view.phrases).toEqual([{ text: '1:05 to 1:12: 63 c off on average, 52% of it missed', atS: 65 }]);
    expect(view.noPhrases).toBe('');
    expect(describeReport(reportOf([])).noPhrases).toBe('No phrase stood out as off.');
  });

  it('gives the song range and the singer\'s', () => {
    expect(describeReport(reportOf([])).range).toBe(
      'Song range D3 to B4. Your range in this take: E3 to A4.',
    );
    expect(describeReport(reportOf([], { sungRange: null })).range).toBe('Song range D3 to B4.');
  });

  it('lands a jump a moment before the phrase, never before the start', () => {
    expect(jumpTarget(65)).toBe(64);
    expect(jumpTarget(0.4)).toBe(0);
  });
});

describe('grade runs on the lane', () => {
  const frames = (grades: Array<LaneFrame['grade']>): LaneFrame[] =>
    grades.map((grade, i) => ({ t: i * 0.01, f0: 220, clarity: 0.9, ...(grade ? { grade } : {}) }));

  it('has no runs for a karaoke ribbon, whose frames carry no grade', () => {
    expect(gradeRuns(frames([undefined, undefined, undefined]))).toEqual([]);
  });

  it('groups equal grades and joins runs at a shared frame', () => {
    expect(gradeRuns(frames(['hit', 'hit', 'okay', 'okay', 'miss']))).toEqual([
      { from: 0, to: 2, grade: 'hit' },
      { from: 2, to: 4, grade: 'okay' },
      { from: 4, to: 4, grade: 'miss' },
    ]);
  });

  it('breaks a run at a frame with no grade', () => {
    expect(gradeRuns(frames(['hit', 'hit', undefined, 'hit']))).toEqual([
      { from: 0, to: 1, grade: 'hit' },
      { from: 3, to: 3, grade: 'hit' },
    ]);
  });

  it('keeps the grade on a frame in the ring, and adds none to one without', () => {
    const ring = new FrameRing(8);
    ring.push({ t: 0, f0: 220, clarity: 0.9, grade: 'miss' });
    ring.push({ t: 0.01, f0: 220, clarity: 0.9 });
    const [graded, plain] = ring.toArray();
    expect(graded.grade).toBe('miss');
    expect('grade' in plain).toBe(false);
  });
});
