/**
 * Tests for the words of the "Your voice" section (src/app/voice-report.ts):
 * each line carries its number straight from the measurements, the basis says
 * what the notes were judged against, the worst notes come worst first, and a
 * take with no notes says so plainly. Also that the card's text for a take with
 * no melody names the voice, and a take stored before the section has none.
 */
import { describe, expect, it } from 'vitest';
import type { TakeReport } from '../src/analysis/score';
import { measureVoice } from '../src/analysis/voice';
import type { VoiceReport } from '../src/analysis/voice';
import { describeReport } from '../src/app/report';
import { describeVoice } from '../src/app/voice-report';

const midiToHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** A take of 0.8 s notes with 0.12 s gaps, each `[midi]`, on the tracker's 10 ms grid. */
function take(midis: readonly number[]): Array<{ t: number; f0: number }> {
  const out: Array<{ t: number; f0: number }> = [];
  let t = 0;
  for (const midi of midis) {
    for (let i = 0; i < 80; i++) out.push({ t: t + i * 0.01, f0: midiToHz(midi) });
    t += 0.8;
    for (let i = 0; i < 12; i++) out.push({ t: t + i * 0.01, f0: 0 });
    t += 0.12;
  }
  return out;
}

const TUNE = [60, 64, 67, 72, 71, 69, 67, 65, 64, 62, 60, 67, 64, 65, 62, 60];

describe('describeVoice', () => {
  it('words each measure with its number, against an estimated key', () => {
    // Every note 30 cents sharp of C major.
    const voice = measureVoice(take(TUNE.map((m) => m + 0.3)), null);
    const view = describeVoice(voice);
    expect(view.basis).toMatch(/^Judged against the nearest note of C major, a key estimated from your own notes \(fit \d+%\)/);
    expect(view.intonation).toBe('Intonation: 0% of 16 notes within 25 c and 100% within 50 c; a median 30 c sharp.');
    expect(view.stability).toMatch(/^Held notes: 16 over 650 ms, a typical spread of \d+ c/);
    expect(view.vibrato).toMatch(/^Vibrato: none found on the 16 notes longer than 500 ms\.$/);
    expect(view.phrases).toMatch(/^Phrases: 1, a median 14.6 s/);
    expect(view.range).toMatch(/^Range used \(p10 to p90\): /);
  });

  it('lists the worst notes worst first with their time and the note they missed', () => {
    const midis = TUNE.map((m, i) => (i === 3 ? m - 0.4 : i === 5 ? m + 0.3 : m));
    const view = describeVoice(measureVoice(take(midis), null));
    expect(view.worstNotes.map((n) => n.text)).toEqual(['C5 at 0:02: 40 c flat of C5', 'A4 at 0:04: 30 c sharp of A4']);
    expect(view.worstNotes[0].atS).toBeCloseTo(3 * 0.92, 5);
    expect(view.moreOff).toBe(0);
  });

  it('says the semitone fallback in words, and that nothing was found for no notes', () => {
    const chromatic = describeVoice(measureVoice(take([60.3, 62.3]), null));
    expect(chromatic.basis).toBe('No clear key in what you sang, so each note is judged against the nearest semitone at A = 440 Hz.');
    const none = describeVoice(measureVoice([], null));
    expect(none.intonation).toBe('No notes were found in this take to measure.');
    expect(none.worstNotes).toEqual([]);
  });
});

/** A report for a song with no melody, as scoring makes it. */
function voiceOnly(voice: VoiceReport | undefined, style: 'strict' | 'open'): TakeReport {
  return {
    notesCovered: 0,
    notesSung: 0,
    inTuneRate: null,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange: { lowMidi: 0, highMidi: 0, highAtS: 0 },
    sungRange: null,
    style,
    noMelody: true,
    ...(voice ? { voice } : {}),
  };
}

describe('describeReport with no melody', () => {
  it('says the card measures the voice on its own in Strict, and keeps its Open words', () => {
    const voice = measureVoice(take(TUNE), null);
    const strict = describeReport(voiceOnly(voice, 'strict'));
    expect(strict.headline).toBe('This song has no melody to follow, so this card measures your voice on its own.');
    expect(strict.hasMelody).toBe(false);
    expect(strict.voice?.intonation).toMatch(/^Intonation: 100% of 16 notes within 25 c/);
    expect(describeReport(voiceOnly(voice, 'open')).headline).toMatch(/judged against the song's key/);
  });

  it('has no voice section for a take stored before it existed', () => {
    expect(describeReport(voiceOnly(undefined, 'strict')).voice).toBeNull();
  });
});
